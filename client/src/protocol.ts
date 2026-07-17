/**
 * Wire types shared with the server.
 *
 * SOURCE OF TRUTH: server/src/net/protocol.ts (+ engine/types.ts). These are
 * mirrored here so the Vite build stays self-contained. If the server protocol
 * changes, update this file to match. (A shared `packages/shared` workspace is
 * the natural next refactor once the shape stabilizes.)
 */

export type Suit = "c" | "d" | "h" | "s";
export interface Card {
  rank: number; // 2..14 (11=J 12=Q 13=K 14=A)
  suit: Suit;
}

export type Phase =
  | "WAITING_FOR_PLAYERS"
  | "PREFLOP"
  | "FLOP"
  | "TURN"
  | "RIVER"
  | "SHOWDOWN"
  | "HAND_COMPLETE";

export type PlayerStatus =
  | "ACTIVE"
  | "FOLDED"
  | "ALL_IN"
  | "SITTING_OUT"
  | "BUSTED";

export interface TableConfig {
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
  minPlayers: number;
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canBet: boolean;
  canRaise: boolean;
  minBetTo: number;
  maxBetTo: number;
}

/** Raw lifetime counters behind the stats shown above each seat. */
export interface PlayerStats {
  hands: number;
  vpip: number;
  pfr: number;
  aggressive: number;
  calls: number;
  showdowns: number;
  won: number;
}

export interface PublicSeat {
  seatIndex: number;
  playerId: string;
  name: string;
  stack: number;
  streetCommitted: number;
  status: PlayerStatus;
  hasCards: boolean;
  holeCards: Card[] | null;
  isButton: boolean;
  isActing: boolean;
  connected: boolean;
  willSitOutNextHand: boolean;
  stats: PlayerStats | null;
}

export interface HandRankLike {
  category: number;
  tiebreakers: number[];
  cards: Card[];
}

export interface PotResult {
  amount: number;
  winners: Array<{ playerId: string; amountWon: number; hand: HandRankLike | null }>;
  uncontested: boolean;
}

export interface HandResult {
  potResults: PotResult[];
  board: Card[];
  shownHands: Record<string, HandRankLike>;
}

export interface TableSummary {
  tableId: string;
  name: string;
  playerCount: number;
  maxSeats: number;
  handNumber: number;
  phase: Phase;
}

export interface PublicTableState {
  tableId: string;
  tableName: string;
  config: TableConfig;
  phase: Phase;
  board: Card[];
  /** Chips in the middle, excluding bets still in front of players this street. */
  pot: number;
  /** Everything committed this hand, including this street's bets. Sizes raises. */
  potTotal: number;
  currentBet: number;
  minRaiseSize: number;
  buttonIndex: number;
  actingIndex: number | null;
  handNumber: number;
  seats: Array<PublicSeat | null>;
  youPlayerId: string | null;
  yourSeatIndex: number | null;
  legalActions: LegalActions | null;
  lastResult: HandResult | null;
  /** Epoch-ms deadline for the acting player, or null when no timer runs. */
  actingDeadline: number | null;
  /** Full turn time in ms, for sizing the countdown. */
  turnTimeMs: number;
}

export interface ChatMessage {
  id: string;
  playerId: string;
  name: string;
  text: string;
  ts: number;
}

export interface IdentifyResult {
  ok: true;
  playerId: string;
  sessionToken: string;
}

export interface CreateTableResult {
  ok: true;
  tableId: string;
}

export interface ListTablesResult {
  ok: true;
  tables: TableSummary[];
}

export type Ack = { ok: true } | { ok: false; error: string };

export interface ActionPayload {
  type: "fold" | "check" | "call" | "bet" | "raise";
  amount?: number;
}

export const EVENTS = {
  ListTables: "listTables",
  CreateTable: "createTable",
  CloseTable: "closeTable",
  Identify: "identify",
  Sit: "sit",
  LeaveSeat: "leaveSeat",
  SitOut: "sitOut",
  Action: "action",
  Chat: "chat",
  State: "state",
  ErrorMsg: "errorMsg",
  ChatMessage: "chatMessage",
  ChatHistory: "chatHistory",
  TableClosed: "tableClosed",
} as const;

export const HAND_CATEGORY_NAMES: Record<number, string> = {
  0: "High Card",
  1: "One Pair",
  2: "Two Pair",
  3: "Three of a Kind",
  4: "Straight",
  5: "Flush",
  6: "Full House",
  7: "Four of a Kind",
  8: "Straight Flush",
};
