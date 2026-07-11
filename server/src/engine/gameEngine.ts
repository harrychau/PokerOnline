import type { Card } from "./cards.js";
import { makeShuffledDeck } from "./cards.js";
import { type RNG, mulberry32, makeSecureSeed } from "./rng.js";
import {
  type BettingContext,
  type LegalActions,
  computeLegalActions,
  validateAction,
} from "./betting.js";
import { buildPots, distributePots, type Contribution } from "./pots.js";
import {
  type HandResult,
  type Player,
  type PlayerAction,
  type PotResult,
  type TableConfig,
  DEFAULT_CONFIG,
  Phase,
  PlayerStatus,
} from "./types.js";

/**
 * A snapshot of everything about a table. The engine mutates this in place.
 * Phase 2 derives per-player redacted views from it (hiding others' hole cards).
 */
export interface TableState {
  config: TableConfig;
  seats: Array<Player | null>;
  buttonIndex: number;
  phase: Phase;
  board: Card[];
  /** Highest street commitment any player has made this street. */
  currentBet: number;
  /** Minimum full-raise increment currently in force. */
  minRaiseSize: number;
  /** Seat index of the player to act, or null when no one is to act. */
  actingIndex: number | null;
  handNumber: number;
  /** The result of the most recently completed hand, if any. */
  lastResult: HandResult | null;
}

/**
 * Options for a single seated player's "acted" bookkeeping that the engine
 * tracks outside the Player object to keep the reopen-betting logic tidy.
 */
interface ActingBook {
  /**
   * The value of `fullRaiseSeq` at the moment this player last voluntarily
   * acted this street, or -1 if they haven't acted yet. A player may re-raise
   * only if a full raise has happened since — i.e. fullRaiseSeq > this value.
   * This is how an all-in under-raise correctly fails to reopen the betting.
   */
  lastActedSeq: number;
}

export class GameEngine {
  readonly state: TableState;
  private rng: RNG;
  private deck: Card[] = [];
  private deckPos = 0;
  /** Increments on every full (betting-reopening) bet or raise this street. */
  private fullRaiseSeq = 0;
  private book: Map<string, ActingBook> = new Map();

  constructor(config: Partial<TableConfig> = {}, rng?: RNG) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    this.rng = rng ?? mulberry32(makeSecureSeed());
    this.state = {
      config: merged,
      seats: new Array(merged.maxSeats).fill(null),
      buttonIndex: -1,
      phase: Phase.WaitingForPlayers,
      board: [],
      currentBet: 0,
      minRaiseSize: merged.bigBlind,
      actingIndex: null,
      handNumber: 0,
      lastResult: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Seating
  // ---------------------------------------------------------------------------

  /** Seat a new player. Throws if the seat is taken or out of range. */
  seatPlayer(args: {
    id: string;
    name: string;
    seatIndex: number;
    buyIn?: number;
  }): Player {
    const { id, name, seatIndex } = args;
    if (seatIndex < 0 || seatIndex >= this.state.config.maxSeats) {
      throw new Error(`Seat ${seatIndex} out of range`);
    }
    if (this.state.seats[seatIndex]) throw new Error(`Seat ${seatIndex} is taken`);
    if (this.findSeatByPlayerId(id) !== -1) throw new Error(`Player ${id} already seated`);

    const player: Player = {
      id,
      name,
      seatIndex,
      stack: args.buyIn ?? this.state.config.startingStack,
      holeCards: null,
      status: PlayerStatus.SittingOut, // sits out until the next hand starts
      streetCommitted: 0,
      handCommitted: 0,
      hasActedThisStreet: false,
      sitOutNextHand: false,
    };
    this.state.seats[seatIndex] = player;
    this.book.set(id, { lastActedSeq: -1 });
    return player;
  }

  /** Remove a player from their seat entirely (leave table / cash out). */
  removePlayer(id: string): void {
    const seat = this.findSeatByPlayerId(id);
    if (seat === -1) return;
    const player = this.state.seats[seat]!;
    // If they are in a live hand, fold them first so pots stay consistent.
    if (this.isHandInProgress() && player.status === PlayerStatus.Active) {
      if (this.state.actingIndex === seat) {
        this.applyAction(id, { type: "fold" });
      } else {
        player.status = PlayerStatus.Folded;
        this.checkFoldOut();
      }
    }
    this.state.seats[seat] = null;
    this.book.delete(id);
  }

  /** Mark a player to sit out (or come back) starting next hand. */
  setSitOut(id: string, sitOut: boolean): void {
    const seat = this.findSeatByPlayerId(id);
    if (seat === -1) return;
    this.state.seats[seat]!.sitOutNextHand = sitOut;
  }

  // ---------------------------------------------------------------------------
  // Hand lifecycle
  // ---------------------------------------------------------------------------

  /** True while a hand is being played (between deal and completion). */
  isHandInProgress(): boolean {
    return (
      this.state.phase !== Phase.WaitingForPlayers &&
      this.state.phase !== Phase.HandComplete
    );
  }

  /** Whether a fresh hand could be started right now. */
  canStartHand(): boolean {
    return !this.isHandInProgress() && this.eligibleSeats().length >= this.state.config.minPlayers;
  }

  /** Number of players eligible to be dealt into the next hand. */
  eligibleCount(): number {
    return this.eligibleSeats().length;
  }

  /**
   * Fold a player out of turn — used for disconnects, time-outs, or leaving
   * mid-hand. Safe no-op if the player isn't currently able to act. When it IS
   * the player's turn, this routes through the normal action path so the hand
   * advances correctly; otherwise it folds them in place and checks for a
   * fold-out.
   */
  forceFold(playerId: string): void {
    const seat = this.findSeatByPlayerId(playerId);
    if (seat === -1) return;
    const p = this.state.seats[seat]!;
    if (!this.isHandInProgress() || p.status !== PlayerStatus.Active) return;
    if (this.state.actingIndex === seat) {
      this.applyAction(playerId, { type: "fold" });
      return;
    }
    p.status = PlayerStatus.Folded;
    this.checkFoldOut();
  }

  /** Seats eligible to be dealt into a new hand. */
  private eligibleSeats(): number[] {
    const out: number[] = [];
    this.state.seats.forEach((p, i) => {
      if (p && !p.sitOutNextHand && p.stack > 0) out.push(i);
    });
    return out;
  }

  /**
   * Begin a new hand: rotate the button, shuffle, deal, and post blinds.
   * Throws if there are not enough eligible players.
   */
  startHand(): void {
    if (this.isHandInProgress()) throw new Error("A hand is already in progress");

    const eligible = this.eligibleSeats();
    if (eligible.length < this.state.config.minPlayers) {
      throw new Error(
        `Need at least ${this.state.config.minPlayers} players to start (have ${eligible.length})`,
      );
    }

    // Reset per-hand state for everyone.
    for (const p of this.state.seats) {
      if (!p) continue;
      p.holeCards = null;
      p.streetCommitted = 0;
      p.handCommitted = 0;
      p.hasActedThisStreet = false;
      // Eligible players become Active; others sit out this hand.
      const isEligible = eligible.includes(p.seatIndex);
      p.status = isEligible ? PlayerStatus.Active : PlayerStatus.SittingOut;
      this.book.set(p.id, { lastActedSeq: -1 });
    }

    // Rotate the button to the next eligible seat clockwise.
    this.state.buttonIndex = this.nextEligibleSeatFrom(this.state.buttonIndex, eligible);

    // Shuffle a fresh deck for this hand.
    this.deck = makeShuffledDeck(this.rng);
    this.deckPos = 0;
    this.state.board = [];
    this.state.handNumber += 1;
    this.state.lastResult = null;
    this.fullRaiseSeq = 0;

    // Deal two hole cards to each in-hand player, starting left of the button,
    // one card at a time across two passes (as in a real deal — cosmetic, but
    // faithful to how cards come off the deck).
    const order = this.seatsInHandOrder();
    const firstCard = new Map<number, Card>();
    for (const seatIndex of order) firstCard.set(seatIndex, this.drawCard());
    for (const seatIndex of order) {
      const p = this.state.seats[seatIndex]!;
      p.holeCards = [firstCard.get(seatIndex)!, this.drawCard()];
    }

    this.state.phase = Phase.Preflop;
    this.postBlinds(order);

    // Begin preflop betting, or — if everyone is already all-in from the blinds
    // — run the board out and go straight to showdown.
    if (this.hasPendingBetting()) {
      this.state.actingIndex = this.firstToActPreflop(order);
    } else {
      this.dealRemainingAndShowdown();
    }
  }

  /** Post small/big blinds, handling heads-up reversal and short all-ins. */
  private postBlinds(order: number[]): void {
    const { smallBlind, bigBlind } = this.state.config;
    const n = order.length;

    let sbSeat: number;
    let bbSeat: number;
    if (n === 2) {
      // Heads-up: the button IS the small blind and acts first preflop; the
      // other player posts the big blind. This is a real rule that trips people
      // up, so it's called out explicitly.
      sbSeat = this.state.buttonIndex;
      bbSeat = order.find((s) => s !== this.state.buttonIndex)!;
    } else {
      // 3+ handed: small blind is the first eligible seat left of the button,
      // big blind the next one.
      sbSeat = order[1]!; // order[0] is the button
      bbSeat = order[2]!;
    }

    this.commitBlind(sbSeat, smallBlind);
    this.commitBlind(bbSeat, bigBlind);

    // The big blind sets the line to call, and the min-raise starts at one BB.
    this.state.currentBet = bigBlind;
    this.state.minRaiseSize = bigBlind;
    // Blinds are forced, not voluntary actions: the big blind still gets the
    // "option" to raise, so we do NOT mark them as having acted.
  }

  private commitBlind(seatIndex: number, blind: number): void {
    const p = this.state.seats[seatIndex]!;
    const amount = Math.min(blind, p.stack);
    p.stack -= amount;
    p.streetCommitted += amount;
    p.handCommitted += amount;
    if (p.stack === 0) p.status = PlayerStatus.AllIn;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** Legal actions for the player currently to act, or null if none. */
  legalActionsForCurrent(): { playerId: string; actions: LegalActions } | null {
    if (this.state.actingIndex === null) return null;
    const p = this.state.seats[this.state.actingIndex];
    if (!p) return null;
    return { playerId: p.id, actions: this.legalActionsFor(this.state.actingIndex) };
  }

  private bettingContext(): BettingContext {
    return {
      currentBet: this.state.currentBet,
      minRaiseSize: this.state.minRaiseSize,
      bigBlind: this.state.config.bigBlind,
    };
  }

  /**
   * Apply a player's action. Validates against the authoritative rules, mutates
   * state, and advances the hand (next actor, next street, or showdown).
   * Throws if it isn't the player's turn or the action is illegal.
   */
  applyAction(playerId: string, action: PlayerAction): void {
    if (this.state.actingIndex === null) throw new Error("No one is to act");
    const seat = this.state.actingIndex;
    const p = this.state.seats[seat];
    if (!p) throw new Error("Acting seat is empty");
    if (p.id !== playerId) throw new Error(`It is not ${playerId}'s turn`);

    // Enforce the reopen rule: a player who has already acted and now faces
    // only an under-raise all-in may call but not re-raise.
    if (action.type === "bet" || action.type === "raise") {
      const acted = this.book.get(p.id)!;
      const reopened = acted.lastActedSeq < 0 || this.fullRaiseSeq > acted.lastActedSeq;
      if (!reopened) {
        throw new Error("Illegal action: betting is not reopened; you may only call or fold");
      }
    }

    const result = validateAction(p, action, this.bettingContext());
    if (!result.ok) throw new Error(`Illegal action: ${result.error}`);
    const n = result.normalized;

    // Apply chips.
    if (n.chipsPutIn > 0) {
      p.stack -= n.chipsPutIn;
      p.streetCommitted = n.betTo;
      p.handCommitted += n.chipsPutIn;
    }

    if (n.type === "fold") {
      p.status = PlayerStatus.Folded;
    } else if (n.allIn || p.stack === 0) {
      p.status = PlayerStatus.AllIn;
    }

    // Update the betting line for bets/raises.
    if (n.betTo > this.state.currentBet) {
      const prevBet = this.state.currentBet;
      this.state.currentBet = n.betTo;
      if (n.isFullRaise) {
        // A full raise resets the min-raise size and reopens betting.
        this.state.minRaiseSize = n.betTo - prevBet;
        this.fullRaiseSeq += 1;
      }
      // An under-raise all-in intentionally leaves minRaiseSize and
      // fullRaiseSeq unchanged, so it does not reopen the betting.
    }

    p.hasActedThisStreet = true;
    this.book.get(p.id)!.lastActedSeq = this.fullRaiseSeq;

    // If everyone but one folded, the hand ends immediately.
    if (this.checkFoldOut()) return;

    this.advanceAfterAction(seat);
  }

  /**
   * Compute legal actions for a player, but with the reopen rule applied: if a
   * full raise has NOT occurred since this player last acted (only under-raise
   * all-ins), they may call but not raise.
   */
  legalActionsFor(seat: number): LegalActions {
    const p = this.state.seats[seat]!;
    const base = computeLegalActions(p, this.bettingContext());
    const acted = this.book.get(p.id)!;
    const reopened = acted.lastActedSeq < 0 || this.fullRaiseSeq > acted.lastActedSeq;
    if (!reopened) {
      return { ...base, canBet: false, canRaise: false };
    }
    return base;
  }

  private advanceAfterAction(fromSeat: number): void {
    const next = this.findNextActor(fromSeat);
    if (next !== null) {
      this.state.actingIndex = next;
      return;
    }
    // Betting round complete for this street.
    this.advanceStreet();
  }

  /**
   * Find the next seat that still owes action this street, scanning clockwise
   * from `fromSeat`. Returns null when the betting round is complete.
   */
  private findNextActor(fromSeat: number): number | null {
    const n = this.state.config.maxSeats;
    for (let offset = 1; offset <= n; offset++) {
      const seat = (fromSeat + offset) % n;
      const p = this.state.seats[seat];
      if (!p || p.status !== PlayerStatus.Active) continue;
      const owesCall = p.streetCommitted < this.state.currentBet;
      if (owesCall || !p.hasActedThisStreet) return seat;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Street / phase transitions
  // ---------------------------------------------------------------------------

  private advanceStreet(): void {
    this.resetStreetTrackers();

    if (this.state.phase === Phase.River) {
      this.goToShowdown();
      return;
    }

    // Deal the next street.
    switch (this.state.phase) {
      case Phase.Preflop:
        this.dealBoard(3);
        this.state.phase = Phase.Flop;
        break;
      case Phase.Flop:
        this.dealBoard(1);
        this.state.phase = Phase.Turn;
        break;
      case Phase.Turn:
        this.dealBoard(1);
        this.state.phase = Phase.River;
        break;
      default:
        throw new Error(`Cannot advance street from phase ${this.state.phase}`);
    }

    // If no meaningful betting remains (players are all-in), keep dealing.
    if (!this.hasPendingBetting()) {
      this.state.actingIndex = null;
      this.advanceStreet();
      return;
    }

    this.state.actingIndex = this.firstToActPostflop();
  }

  private resetStreetTrackers(): void {
    for (const p of this.state.seats) {
      if (!p) continue;
      p.streetCommitted = 0;
      p.hasActedThisStreet = false;
    }
    this.state.currentBet = 0;
    this.state.minRaiseSize = this.state.config.bigBlind;
    this.fullRaiseSeq = 0;
    for (const b of this.book.values()) b.lastActedSeq = -1;
  }

  /** Deal any remaining community cards with no betting, then show down. */
  private dealRemainingAndShowdown(): void {
    this.state.actingIndex = null;
    if (this.state.phase === Phase.Preflop) {
      this.dealBoard(3);
      this.state.phase = Phase.Flop;
    }
    if (this.state.phase === Phase.Flop) {
      this.dealBoard(1);
      this.state.phase = Phase.Turn;
    }
    if (this.state.phase === Phase.Turn) {
      this.dealBoard(1);
      this.state.phase = Phase.River;
    }
    this.goToShowdown();
  }

  /**
   * Whether any player can still make a meaningful betting decision this street.
   * False when everyone is all-in/folded, or when a single active player has
   * nothing left to call (so their only "action" would be a pointless check).
   */
  private hasPendingBetting(): boolean {
    const active = this.state.seats.filter(
      (p): p is Player => !!p && p.status === PlayerStatus.Active,
    );
    if (active.length === 0) return false;
    if (active.length === 1) return active[0]!.streetCommitted < this.state.currentBet;
    return true;
  }

  private goToShowdown(): void {
    this.state.phase = Phase.Showdown;
    this.state.actingIndex = null;
    this.settleShowdown();
    this.state.phase = Phase.HandComplete;
  }

  /**
   * Ends the hand immediately if only one player remains un-folded, awarding the
   * whole pot uncontested. Returns true if the hand ended.
   */
  private checkFoldOut(): boolean {
    const inHand = this.playersInHand();
    if (inHand.length > 1) return false;
    if (inHand.length === 0) return false; // shouldn't happen

    const winner = inHand[0]!;
    const pot = this.totalPot();
    winner.stack += pot;

    const result: HandResult = {
      board: this.state.board.slice(),
      shownHands: {},
      potResults: [
        {
          amount: pot,
          uncontested: true,
          winners: [{ playerId: winner.id, amountWon: pot, hand: null }],
        },
      ],
    };
    this.finishHand(result);
    return true;
  }

  /** Build side pots, evaluate hands, distribute chips. */
  private settleShowdown(): void {
    const contributions: Contribution[] = [];
    const holeCardsById: Record<string, [Card, Card]> = {};
    for (const p of this.state.seats) {
      if (!p || p.handCommitted === 0) continue;
      contributions.push({
        playerId: p.id,
        contributed: p.handCommitted,
        folded: p.status === PlayerStatus.Folded,
      });
      if (p.status !== PlayerStatus.Folded && p.holeCards) {
        holeCardsById[p.id] = p.holeCards;
      }
    }

    const pots = buildPots(contributions);
    const order = this.seatsInHandOrder()
      .map((s) => this.state.seats[s]!.id)
      .filter((id) => holeCardsById[id]);
    // orderFromButton for odd chips: start immediately left of the button.
    const orderFromButton = order;

    const { results, payouts } = distributePots(
      pots,
      holeCardsById,
      this.state.board,
      orderFromButton,
    );

    for (const [id, amount] of Object.entries(payouts)) {
      const seat = this.findSeatByPlayerId(id);
      if (seat !== -1) this.state.seats[seat]!.stack += amount;
    }

    const shownHands: HandResult["shownHands"] = {};
    for (const r of results) {
      for (const w of r.winners) {
        if (w.hand) shownHands[w.playerId] = w.hand;
      }
    }

    const result: HandResult = {
      board: this.state.board.slice(),
      shownHands,
      potResults: results as PotResult[],
    };
    this.finishHand(result);
  }

  private finishHand(result: HandResult): void {
    this.state.lastResult = result;
    this.state.phase = Phase.HandComplete;
    this.state.actingIndex = null;
    this.state.currentBet = 0;
    // The pot has been paid out into stacks, so clear per-hand commitments:
    // after HAND_COMPLETE, each player's stack reflects everything they hold.
    for (const p of this.state.seats) {
      if (!p) continue;
      p.streetCommitted = 0;
      p.handCommitted = 0;
      // Mark busted players (out of chips) so they are skipped next hand.
      if (p.stack === 0) p.status = PlayerStatus.Busted;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private drawCard(): Card {
    if (this.deckPos >= this.deck.length) throw new Error("Deck exhausted");
    return this.deck[this.deckPos++]!;
  }

  private dealBoard(count: number): void {
    // A real deal "burns" a card before each street; we skip burning since the
    // deck is already randomly shuffled (burning changes nothing statistically).
    for (let i = 0; i < count; i++) this.state.board.push(this.drawCard());
  }

  /** Total chips committed across all players this hand (the pot). */
  totalPot(): number {
    let sum = 0;
    for (const p of this.state.seats) if (p) sum += p.handCommitted;
    return sum;
  }

  /** Players still in the hand (not folded / sitting out). */
  private playersInHand(): Player[] {
    return this.state.seats.filter(
      (p): p is Player =>
        !!p && (p.status === PlayerStatus.Active || p.status === PlayerStatus.AllIn),
    );
  }

  private findSeatByPlayerId(id: string): number {
    return this.state.seats.findIndex((p) => p?.id === id);
  }

  /** In-hand seat indices, ordered clockwise starting from the button. */
  private seatsInHandOrder(): number[] {
    const n = this.state.config.maxSeats;
    const order: number[] = [];
    for (let offset = 0; offset < n; offset++) {
      const seat = (this.state.buttonIndex + offset) % n;
      const p = this.state.seats[seat];
      if (
        p &&
        (p.status === PlayerStatus.Active || p.status === PlayerStatus.AllIn)
      ) {
        order.push(seat);
      }
    }
    return order;
  }

  private nextEligibleSeatFrom(from: number, eligible: number[]): number {
    const n = this.state.config.maxSeats;
    for (let offset = 1; offset <= n; offset++) {
      const seat = (from + offset) % n;
      if (eligible.includes(seat)) return seat;
    }
    // Fallback: keep the button where it is (shouldn't happen with >=1 eligible).
    return eligible[0]!;
  }

  private firstToActPreflop(order: number[]): number {
    if (order.length === 2) {
      // Heads-up: the button/small blind acts first preflop.
      return this.firstActiveFrom(this.state.buttonIndex);
    }
    // 3+ handed: first to act is left of the big blind (order[2]).
    const bbSeat = order[2]!;
    return this.firstActiveFrom(bbSeat + 1);
  }

  private firstToActPostflop(): number {
    // First active player left of the button acts first on every postflop
    // street (heads-up: that's the big blind; 3+: the small blind).
    return this.firstActiveFrom(this.state.buttonIndex + 1);
  }

  private firstActiveFrom(start: number): number {
    const n = this.state.config.maxSeats;
    for (let offset = 0; offset < n; offset++) {
      const seat = (start + offset) % n;
      const p = this.state.seats[seat];
      if (p && p.status === PlayerStatus.Active) return seat;
    }
    return start % n;
  }
}
