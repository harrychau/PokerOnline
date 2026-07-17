import type { Card } from "./cards.js";
import type { HandRank } from "./handEvaluator.js";

/** The explicit states of a hand's lifecycle. */
export enum Phase {
  WaitingForPlayers = "WAITING_FOR_PLAYERS",
  Preflop = "PREFLOP",
  Flop = "FLOP",
  Turn = "TURN",
  River = "RIVER",
  Showdown = "SHOWDOWN",
  HandComplete = "HAND_COMPLETE",
}

/** The four betting streets, in order. */
export const BETTING_STREETS = [Phase.Preflop, Phase.Flop, Phase.Turn, Phase.River] as const;

/** Per-player status within the current hand. */
export enum PlayerStatus {
  /** Seated and holding cards, still able to act. */
  Active = "ACTIVE",
  /** Folded this hand. */
  Folded = "FOLDED",
  /** All chips committed; can win but cannot act further. */
  AllIn = "ALL_IN",
  /** Seated but not dealt into hands (voluntarily or after timing out). */
  SittingOut = "SITTING_OUT",
  /** Stack is zero and player is between hands; awaiting rebuy or removal. */
  Busted = "BUSTED",
}

export type ActionType = "fold" | "check" | "call" | "bet" | "raise";

/**
 * An action a player intends to take. For "bet" and "raise", `amount` is the
 * TOTAL the player's bet becomes for the street (i.e. "raise to X"), not the
 * increment. This "raise to" convention avoids ambiguity between the call
 * portion and the raise portion.
 */
export interface PlayerAction {
  type: ActionType;
  /** Required for "bet" and "raise": the total street bet to raise to. */
  amount?: number;
}

export interface Player {
  id: string;
  name: string;
  seatIndex: number;
  /** Chips in front of the player, not yet committed to the pot. */
  stack: number;
  /** Two hole cards once dealt; null before the deal / when sitting out. */
  holeCards: [Card, Card] | null;
  status: PlayerStatus;
  /** Chips committed on the CURRENT betting street (resets each street). */
  streetCommitted: number;
  /** Chips committed across the WHOLE hand (drives side-pot math). */
  handCommitted: number;
  /**
   * Whether the player has acted at least once on the current street. Used
   * together with matching the current bet to decide when a street is done.
   */
  hasActedThisStreet: boolean;
  /** True if the player wants to be dealt out of the next hand. */
  sitOutNextHand: boolean;
  /**
   * The order in which this player folded within the current hand (0 = first to
   * fold), or null if they are still in. This decides who takes a side pot whose
   * every eligible player ended up folding: the last of them to fold had already
   * won it outright at the moment the others gave up.
   */
  foldOrder: number | null;
}

/**
 * Lifetime counters behind the stats shown above each seat. Stored as raw
 * numerators/denominators rather than percentages so the UI can format them and
 * so they stay exact as they accumulate.
 */
export interface PlayerStats {
  /** Hands dealt into (the denominator for VPIP and PFR). */
  hands: number;
  /** Hands where the player voluntarily put chips in preflop — blinds excluded. */
  vpip: number;
  /** Hands where the player raised preflop. */
  pfr: number;
  /** Bets + raises across all streets (aggression factor numerator). */
  aggressive: number;
  /** Calls across all streets (aggression factor denominator). */
  calls: number;
  /** Hands that reached showdown. */
  showdowns: number;
  /** Hands where the player won at least one pot. */
  won: number;
}

export function emptyStats(): PlayerStats {
  return { hands: 0, vpip: 0, pfr: 0, aggressive: 0, calls: 0, showdowns: 0, won: 0 };
}

export interface TableConfig {
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  /** Default buy-in / starting stack for a fresh seat. */
  startingStack: number;
  /** Minimum players required to start dealing. */
  minPlayers: number;
}

export const DEFAULT_CONFIG: TableConfig = {
  maxSeats: 6,
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
  minPlayers: 2,
};

/** A (main or side) pot and the set of players eligible to win it. */
export interface Pot {
  amount: number;
  /** Player ids eligible to win this pot (never includes folded players). */
  eligiblePlayerIds: string[];
  /**
   * Every player who put chips into this layer, folded or not. Only used to
   * resolve a layer whose eligible set is empty because all of its contributors
   * folded — without this the chips would have no owner.
   */
  contributorIds: string[];
}

/** How a single pot was awarded, for hand history / UI. */
export interface PotResult {
  amount: number;
  winners: Array<{ playerId: string; amountWon: number; hand: HandRank | null }>;
  /** Present when the pot was won without showdown (everyone else folded). */
  uncontested: boolean;
}

export interface HandResult {
  potResults: PotResult[];
  /** Final board at the time the hand ended. */
  board: Card[];
  /** Hands shown at showdown, by player id (empty when uncontested). */
  shownHands: Record<string, HandRank>;
}
