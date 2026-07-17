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
  type PlayerStats,
  type PotResult,
  type TableConfig,
  DEFAULT_CONFIG,
  Phase,
  PlayerStatus,
  emptyStats,
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
  /**
   * Bumped every time the engine hands the action to a player, and never reset.
   * A seat index alone cannot tell one turn from the next, because the same seat
   * can be handed two turns in a row — heads-up, the big blind's preflop option
   * is followed by their first move on the flop. Anything putting a clock on a
   * turn must key off this, or the second turn inherits the first one's clock.
   */
  actingTurn: number;
  handNumber: number;
  /** The result of the most recently completed hand, if any. */
  lastResult: HandResult | null;
  /**
   * True while the hand is an all-in runout waiting for the caller to deal the
   * next street via `stepRunout()`. Only ever set when the engine was built with
   * `steppedRunout`; otherwise a runout completes within the triggering call.
   */
  runoutPending: boolean;
}

export interface EngineOptions {
  /**
   * Deal an all-in runout one street per `stepRunout()` call instead of all at
   * once. The engine still has no notion of time — this just hands the pacing to
   * the caller (the Room, which puts a real delay between streets so the table
   * can watch the board come out).
   */
  steppedRunout?: boolean;
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
  /** Next fold order number to hand out this hand. */
  private foldSeq = 0;
  /**
   * Lifetime stats per player id. Keyed by id rather than seat so they survive
   * a disconnect, a seat change, or standing up and sitting back down.
   */
  private stats: Map<string, PlayerStats> = new Map();
  /** Per-hand "already counted" flags so VPIP/PFR count hands, not actions. */
  private handFlags: Map<string, { vpip: boolean; pfr: boolean }> = new Map();
  /** Players who asked to leave mid-hand; their seats clear once it settles. */
  private pendingRemoval: Set<string> = new Set();
  private steppedRunout: boolean;

  constructor(config: Partial<TableConfig> = {}, rng?: RNG, opts: EngineOptions = {}) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    this.rng = rng ?? mulberry32(makeSecureSeed());
    this.steppedRunout = opts.steppedRunout ?? false;
    this.state = {
      config: merged,
      seats: new Array(merged.maxSeats).fill(null),
      buttonIndex: -1,
      phase: Phase.WaitingForPlayers,
      board: [],
      currentBet: 0,
      minRaiseSize: merged.bigBlind,
      actingIndex: null,
      actingTurn: 0,
      handNumber: 0,
      lastResult: null,
      runoutPending: false,
    };
  }

  /**
   * The single place the action changes hands. Routing every assignment through
   * here is what keeps `actingTurn` honest — a turn handed to the same seat
   * twice running still counts as two turns.
   */
  private setActing(seat: number | null): void {
    this.state.actingIndex = seat;
    if (seat !== null) this.state.actingTurn += 1;
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
      foldOrder: null,
    };
    this.state.seats[seatIndex] = player;
    this.book.set(id, { lastActedSeq: -1 });
    if (!this.stats.has(id)) this.stats.set(id, emptyStats());
    return player;
  }

  /** Lifetime stats for a player id, or null if we've never seen them. */
  statsFor(id: string): PlayerStats | null {
    return this.stats.get(id) ?? null;
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
        this.markFolded(player);
        this.checkFoldOut();
      }
    }

    // Chips already committed this hand belong to the pot, and the seat is what
    // ties them to it. Emptying the seat now would delete them from the game (a
    // player can also leave while all-in, which folding above does not cover),
    // so hold the seat until the hand settles and clear it in finishHand.
    if (this.isHandInProgress() && player.handCommitted > 0) {
      this.pendingRemoval.add(id);
      return;
    }

    this.clearSeat(seat, id);
  }

  private clearSeat(seat: number, id: string): void {
    this.state.seats[seat] = null;
    this.book.delete(id);
    this.handFlags.delete(id);
    this.pendingRemoval.delete(id);
    // Stats deliberately survive: the same player may sit back down.
  }

  // ---------------------------------------------------------------------------
  // Table settings
  // ---------------------------------------------------------------------------

  /**
   * Validate a config change against the current table and return the config it
   * would produce. Throws (with a message meant for the player) if the result
   * would be nonsense. Separated from `updateConfig` so a caller holding a
   * change until the hand ends can still reject bad input immediately.
   */
  nextConfig(patch: Partial<TableConfig>): TableConfig {
    const next: TableConfig = { ...this.state.config, ...patch };

    const whole = (v: number, label: string) => {
      if (!Number.isInteger(v) || v < 0) throw new Error(`${label} must be a whole number`);
    };
    whole(next.smallBlind, "Small blind");
    whole(next.bigBlind, "Big blind");
    whole(next.startingStack, "Starting stack");
    whole(next.maxSeats, "Seat count");
    whole(next.minPlayers, "Minimum players");

    if (next.smallBlind < 1) throw new Error("Small blind must be at least 1");
    if (next.bigBlind <= next.smallBlind) {
      throw new Error("Big blind must be larger than the small blind");
    }
    if (next.startingStack < next.bigBlind) {
      throw new Error("Starting stack must cover at least one big blind");
    }
    if (next.maxSeats < 2 || next.maxSeats > 10) throw new Error("Seats must be between 2 and 10");
    if (next.minPlayers < 2) throw new Error("At least 2 players are needed to deal");
    if (next.minPlayers > next.maxSeats) {
      throw new Error("Minimum players cannot exceed the number of seats");
    }

    // Shrinking the table can't strand a seated player: their chips and their
    // place in the betting order both hang off the seat index.
    for (let i = next.maxSeats; i < this.state.seats.length; i++) {
      if (this.state.seats[i]) {
        throw new Error(`Seat ${i} must be empty before cutting the table to ${next.maxSeats} seats`);
      }
    }
    return next;
  }

  /**
   * Apply a config change. Only legal between hands — blinds and seat counts
   * feed the betting math of a live hand, so changing them underneath one would
   * corrupt it.
   */
  updateConfig(patch: Partial<TableConfig>): void {
    if (this.isHandInProgress()) throw new Error("Cannot change table settings mid-hand");
    const next = this.nextConfig(patch);

    if (next.maxSeats !== this.state.seats.length) {
      const seats: Array<Player | null> = new Array(next.maxSeats).fill(null);
      for (let i = 0; i < Math.min(next.maxSeats, this.state.seats.length); i++) {
        seats[i] = this.state.seats[i]!;
      }
      this.state.seats = seats;
      // The button may have been sitting on a seat that no longer exists; -1
      // simply makes the next hand start the rotation over.
      if (this.state.buttonIndex >= next.maxSeats) this.state.buttonIndex = -1;
    }

    this.state.config = next;
    this.state.minRaiseSize = next.bigBlind;
  }

  /**
   * Set a seated player's stack outright (the owner topping someone up or
   * knocking them down). Between hands only, for the same reason as config: a
   * live hand's pots are computed from what players have already committed.
   */
  setStack(playerId: string, stack: number): void {
    if (this.isHandInProgress()) throw new Error("Cannot adjust stacks mid-hand");
    if (!Number.isInteger(stack) || stack < 0) {
      throw new Error("A stack must be a whole number of chips, 0 or more");
    }
    const seat = this.findSeatByPlayerId(playerId);
    if (seat === -1) throw new Error("That player is not seated at this table");
    const p = this.state.seats[seat]!;
    p.stack = stack;
    // Keep the busted marker honest in both directions: chips make a player
    // dealable again, and zeroing someone benches them.
    if (stack === 0) p.status = PlayerStatus.Busted;
    else if (p.status === PlayerStatus.Busted) p.status = PlayerStatus.SittingOut;
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
    this.markFolded(p);
    this.checkFoldOut();
  }

  /**
   * Fold a player, stamping the order they folded in. Every path that folds
   * someone goes through here so no fold is ever left unstamped — the fold order
   * decides who takes a side pot all of whose eligible players folded.
   */
  private markFolded(p: Player): void {
    if (p.status === PlayerStatus.Folded) return;
    p.status = PlayerStatus.Folded;
    p.foldOrder = this.foldSeq++;
  }

  private statsOf(id: string): PlayerStats {
    let s = this.stats.get(id);
    if (!s) {
      s = emptyStats();
      this.stats.set(id, s);
    }
    return s;
  }

  /**
   * Fold the player's action into their lifetime stats.
   *
   * VPIP and PFR count HANDS, not actions, so a player who calls and later
   * re-raises the same hand adds one to each — hence the per-hand flags. Blinds
   * never count: they are forced, and a big blind checking their option has not
   * chosen to play. The aggression factor counts every street.
   */
  private recordActionStats(p: Player, type: PlayerAction["type"]): void {
    const s = this.statsOf(p.id);
    const flags = this.handFlags.get(p.id);
    const preflop = this.state.phase === Phase.Preflop;
    const voluntary = type === "call" || type === "bet" || type === "raise";
    const aggressive = type === "bet" || type === "raise";

    if (preflop && voluntary && flags && !flags.vpip) {
      flags.vpip = true;
      s.vpip += 1;
    }
    if (preflop && aggressive && flags && !flags.pfr) {
      flags.pfr = true;
      s.pfr += 1;
    }
    if (aggressive) s.aggressive += 1;
    else if (type === "call") s.calls += 1;
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
      p.foldOrder = null;
      // Eligible players become Active; others sit out this hand.
      const isEligible = eligible.includes(p.seatIndex);
      p.status = isEligible ? PlayerStatus.Active : PlayerStatus.SittingOut;
      this.book.set(p.id, { lastActedSeq: -1 });
      this.handFlags.set(p.id, { vpip: false, pfr: false });
      if (isEligible) this.statsOf(p.id).hands += 1;
    }
    this.foldSeq = 0;

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
    this.state.runoutPending = false;
    this.postBlinds(order);

    // Begin preflop betting, or — if everyone is already all-in from the blinds
    // — run the board out and go straight to showdown.
    if (this.hasPendingBetting()) {
      this.setActing(this.firstToActPreflop(order));
    } else {
      this.returnUncalledBet();
      this.resetStreetTrackers();
      this.beginRunout();
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
      this.markFolded(p);
    } else if (n.allIn || p.stack === 0) {
      p.status = PlayerStatus.AllIn;
    }

    this.recordActionStats(p, n.type);

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
      this.setActing(next);
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

  /**
   * Give back the part of a bet that nobody matched.
   *
   * If exactly one player has out-committed everyone else on this street, the
   * excess was never contested and is returned to their stack instead of going
   * into the pot. This is the standard "uncalled bet is returned" rule.
   *
   * It matters most on all-ins. Shove 200 into a player who can only call 50 and
   * the old behaviour pushed all 250 into the pots, then quietly handed 150 back
   * as a side pot only the shover could win. The chips balanced, but the pot
   * displayed 250 while the winner "won" 100, and the shover's stack jumped by
   * 150 out of nowhere — money appearing from thin air, as far as the table
   * could tell. Returning it up front keeps the pot honest and the payouts
   * readable, and it is what a real dealer does.
   */
  private returnUncalledBet(): void {
    let top: Player | null = null;
    let topAmount = 0;
    let secondAmount = 0;
    for (const p of this.state.seats) {
      if (!p || p.streetCommitted <= 0) continue;
      if (p.streetCommitted > topAmount) {
        secondAmount = topAmount;
        topAmount = p.streetCommitted;
        top = p;
      } else if (p.streetCommitted > secondAmount) {
        secondAmount = p.streetCommitted;
      }
    }
    if (!top || topAmount <= secondAmount) return;

    // Folding forfeits everything already pushed forward, so the top committer
    // only gets change back if they are still in the hand. This is reachable:
    // Room folds a disconnected player once their grace expires, which can land
    // out of turn and leave the biggest bettor of the street folded. Refunding
    // them would pay a player who gave up — and would mean betting big and
    // pulling the plug got the chips back. Their chips still count as cover in
    // the second-highest figure above, so nobody else is refunded over them.
    if (top.status === PlayerStatus.Folded) return;

    const excess = topAmount - secondAmount;
    top.stack += excess;
    top.streetCommitted -= excess;
    top.handCommitted -= excess;
    // A shove bigger than anyone could call leaves chips behind, so the player
    // is not actually all-in any more.
    if (top.status === PlayerStatus.AllIn && top.stack > 0) top.status = PlayerStatus.Active;
    this.state.currentBet = secondAmount;
  }

  private advanceStreet(): void {
    this.returnUncalledBet();
    this.resetStreetTrackers();

    // No betting decisions left (everyone is all-in) — the rest of the board is
    // a formality, so hand it to the runout, which paces it out street by street
    // rather than jumping straight to the result.
    if (!this.hasPendingBetting()) {
      this.beginRunout();
      return;
    }

    if (this.state.phase === Phase.River) {
      this.goToShowdown();
      return;
    }

    this.dealNextStreet();
    this.setActing(this.firstToActPostflop());
  }

  /** Deal the community cards for the street after the current one. */
  private dealNextStreet(): void {
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

  /**
   * Enter the all-in runout: deal out whatever board remains and show down, with
   * no betting in between. Under `steppedRunout` the engine stops here and waits
   * for `stepRunout()` per street; otherwise it runs the whole thing now.
   */
  private beginRunout(): void {
    this.setActing(null);
    if (this.steppedRunout) {
      this.state.runoutPending = true;
      return;
    }
    while (this.state.phase !== Phase.HandComplete) this.runoutStep();
  }

  /**
   * Deal the next beat of an all-in runout — one street, or the showdown once
   * the board is complete. No-op unless a runout is actually waiting, so the
   * caller's timer can fire harmlessly late.
   */
  stepRunout(): void {
    if (!this.state.runoutPending) return;
    this.runoutStep();
    if (this.state.phase === Phase.HandComplete) this.state.runoutPending = false;
  }

  private runoutStep(): void {
    if (this.state.phase === Phase.River) {
      this.goToShowdown();
      return;
    }
    this.dealNextStreet();
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
    this.setActing(null);
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

    // The winner's own uncalled bet should come straight back rather than be
    // paid out to them as "winnings" — otherwise a raise that took the pot
    // reports a win far larger than what was actually collected.
    this.returnUncalledBet();

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
    const foldOrderById: Record<string, number> = {};
    for (const p of this.state.seats) {
      if (!p || p.handCommitted === 0) continue;
      contributions.push({
        playerId: p.id,
        contributed: p.handCommitted,
        folded: p.status === PlayerStatus.Folded,
        foldOrder: p.foldOrder,
      });
      if (p.foldOrder !== null) foldOrderById[p.id] = p.foldOrder;
      if (p.status !== PlayerStatus.Folded && p.holeCards) {
        holeCardsById[p.id] = p.holeCards;
        this.statsOf(p.id).showdowns += 1;
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
      foldOrderById,
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
    this.setActing(null);
    this.state.currentBet = 0;
    // A hand can end before its runout does — the last player not yet all-in can
    // leave the table, folding them out mid-board. Clear the flag here, the one
    // place every ending passes through, so no pending step outlives the hand.
    this.state.runoutPending = false;

    // One "won" per player per hand, however many pots they took.
    const winners = new Set<string>();
    for (const r of result.potResults) for (const w of r.winners) winners.add(w.playerId);
    for (const id of winners) this.statsOf(id).won += 1;

    // The pot has been paid out into stacks, so clear per-hand commitments:
    // after HAND_COMPLETE, each player's stack reflects everything they hold.
    for (const p of this.state.seats) {
      if (!p) continue;
      p.streetCommitted = 0;
      p.handCommitted = 0;
      // Mark busted players (out of chips) so they are skipped next hand.
      if (p.stack === 0) p.status = PlayerStatus.Busted;
    }

    // Seats held open for players who left mid-hand can go now that the pot is
    // settled and any chips they won have landed in their stack.
    for (const id of [...this.pendingRemoval]) {
      const seat = this.findSeatByPlayerId(id);
      if (seat !== -1) this.clearSeat(seat, id);
      else this.pendingRemoval.delete(id);
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

  /**
   * Chips gathered into the middle — everything committed this hand EXCEPT what
   * is still sitting in front of players on the current street.
   *
   * A real dealer only pulls bets in once the street closes, and the UI draws
   * those bets in front of each seat. Reporting the total here would double
   * count them: they would show both in front of the player and in the pot, so
   * the table would look like it holds more money than it does.
   */
  collectedPot(): number {
    let sum = 0;
    for (const p of this.state.seats) if (p) sum += p.handCommitted - p.streetCommitted;
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
