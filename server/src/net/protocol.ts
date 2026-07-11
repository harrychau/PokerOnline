/**
 * The wire protocol shared between server and client.
 *
 * Everything here is plain data (JSON-serializable). The client (Phase 3)
 * imports these same types so the two sides can never drift apart.
 *
 * Design principle: the server broadcasts a fully-redacted `PublicTableState`
 * to each socket. Clients render exactly what they receive and submit intents;
 * they never compute game state themselves.
 */
import type { Card } from "../engine/cards.js";
import type { LegalActions } from "../engine/betting.js";
import type { HandResult, Phase, PlayerStatus, TableConfig } from "../engine/types.js";

/** One seat as seen by a particular viewer. */
export interface PublicSeat {
  seatIndex: number;
  playerId: string;
  name: string;
  stack: number;
  /** Chips committed on the current street (for the UI's bet display). */
  streetCommitted: number;
  status: PlayerStatus;
  /** Whether this player is holding hole cards this hand (renders card backs). */
  hasCards: boolean;
  /**
   * The actual hole cards — populated ONLY when the viewer is allowed to see
   * them: their own cards always, or another player's cards at showdown if that
   * player showed down. null in every other case. This is the anti-leak gate.
   */
  holeCards: Card[] | null;
  isButton: boolean;
  isActing: boolean;
  /** True if the player's socket is currently connected. */
  connected: boolean;
  /**
   * True if the player has chosen to sit out the next hand. Distinguishes a
   * voluntary sit-out from a freshly-seated player who simply hasn't been dealt
   * into a hand yet (both otherwise report status SITTING_OUT between hands).
   */
  willSitOutNextHand: boolean;
}

/** The complete view of the table for one viewer. */
export interface PublicTableState {
  tableId: string;
  /** Human-readable table name, shown in the UI (distinct from the opaque id). */
  tableName: string;
  config: TableConfig;
  phase: Phase;
  board: Card[];
  /** Total chips in the pot(s) this hand. */
  pot: number;
  currentBet: number;
  minRaiseSize: number;
  buttonIndex: number;
  actingIndex: number | null;
  handNumber: number;
  seats: Array<PublicSeat | null>;

  /** The viewer's own player id, or null if they are a pure spectator. */
  youPlayerId: string | null;
  /** The viewer's seat index, or null if unseated. */
  yourSeatIndex: number | null;
  /** Legal actions for the viewer — present only when it is their turn. */
  legalActions: LegalActions | null;
  /** Full result of the most recently completed hand (safe to reveal). */
  lastResult: HandResult | null;
  /**
   * Epoch-ms deadline by which the acting player must act, or null when no
   * timer is running. Clients render a local countdown against this so the
   * server doesn't have to broadcast every tick.
   */
  actingDeadline: number | null;
  /** The full turn time in ms, so the client can size the countdown ring. */
  turnTimeMs: number;
}

/** A single chat message at the table. */
export interface ChatMessage {
  id: string;
  playerId: string;
  name: string;
  text: string;
  /** Epoch ms when the server received it. */
  ts: number;
}

/** A lobby-level summary of a table, for the "browse tables" screen. */
export interface TableSummary {
  tableId: string;
  name: string;
  playerCount: number;
  maxSeats: number;
  handNumber: number;
  phase: Phase;
}

// --- Client → Server events -------------------------------------------------

export interface IdentifyPayload {
  name: string;
  /** Which table to join — required; use ListTables/CreateTable to pick one. */
  tableId: string;
  /** Present when reconnecting to reclaim an existing identity/seat. */
  sessionToken?: string;
}
export interface IdentifyResult {
  ok: true;
  playerId: string;
  sessionToken: string;
}

export interface CreateTablePayload {
  /** Optional display name; the server assigns a default if omitted. */
  name?: string;
  config?: Partial<TableConfig>;
}
export interface CreateTableResult {
  ok: true;
  tableId: string;
}

export interface ListTablesResult {
  ok: true;
  tables: TableSummary[];
}

export interface SitPayload {
  seatIndex: number;
  buyIn?: number;
}

export interface ActionPayload {
  type: "fold" | "check" | "call" | "bet" | "raise";
  /** Required for bet/raise: the TOTAL street amount to raise to. */
  amount?: number;
}

export interface SitOutPayload {
  sitOut: boolean;
}

export interface ChatPayload {
  text: string;
}

/** Generic acknowledgement returned via Socket.IO callbacks. */
export type Ack = { ok: true } | { ok: false; error: string };

// --- Event name constants (avoid magic strings on both sides) ---------------

export const EVENTS = {
  // client → server
  ListTables: "listTables",
  CreateTable: "createTable",
  CloseTable: "closeTable",
  Identify: "identify",
  Sit: "sit",
  LeaveSeat: "leaveSeat",
  SitOut: "sitOut",
  Action: "action",
  Chat: "chat",
  // server → client
  State: "state",
  ErrorMsg: "errorMsg",
  ChatMessage: "chatMessage",
  ChatHistory: "chatHistory",
  /** Pushed to everyone at a table when it is closed, so clients return to the lobby. */
  TableClosed: "tableClosed",
} as const;
