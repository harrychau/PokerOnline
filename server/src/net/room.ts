/**
 * A Room owns exactly one table: a GameEngine plus the bookkeeping the pure
 * engine deliberately knows nothing about — connections, session tokens,
 * turn/reconnect timers, chat, and when to auto-start the next hand.
 *
 * All wall-clock behavior (timers) lives here, keeping the engine pure and
 * unit-testable. The engine stays the single source of truth for game state.
 */
import { randomUUID } from "node:crypto";
import type { Server as IOServer } from "socket.io";
import { GameEngine } from "../engine/gameEngine.js";
import type { TableConfig } from "../engine/types.js";
import { Phase } from "../engine/types.js";
import { redactStateFor } from "./redact.js";
import {
  EVENTS,
  type ActionPayload,
  type ChatMessage,
  type IdentifyPayload,
  type IdentifyResult,
  type PublicTableState,
  type SitPayload,
  type TableSummary,
} from "./protocol.js";

interface PlayerReg {
  playerId: string;
  name: string;
  sessionToken: string;
  /** Currently-attached socket id, or null while disconnected. */
  socketId: string | null;
  /** Whether this player currently holds a seat in the engine. */
  seated: boolean;
}

export interface RoomOptions {
  tableId?: string;
  /** Human-readable name shown in the lobby and table header. */
  name?: string;
  config?: Partial<TableConfig>;
  /** Delay before auto-starting the next hand, ms. */
  nextHandDelayMs?: number;
  /** Time each player has to act before being auto-checked/folded, ms. */
  turnTimeMs?: number;
  /** How long a disconnected player's seat is held before sit-out, ms. */
  disconnectGraceMs?: number;
}

export class Room {
  readonly tableId: string;
  readonly name: string;
  readonly engine: GameEngine;
  private io: IOServer;
  private nextHandDelayMs: number;
  private turnTimeMs: number;
  private graceMs: number;

  private playersById = new Map<string, PlayerReg>();
  private tokenToId = new Map<string, string>();
  private socketToPlayer = new Map<string, string>();

  private nextHandTimer: ReturnType<typeof setTimeout> | null = null;

  // Turn timer: which seat it's for, when it fires, and the handle.
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnSeat: number | null = null;
  private turnDeadline: number | null = null;

  // Per-player reconnect grace timers.
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private chatLog: ChatMessage[] = [];

  constructor(io: IOServer, opts: RoomOptions = {}) {
    this.io = io;
    this.tableId = opts.tableId ?? "main";
    this.name = opts.name ?? "Table";
    this.engine = new GameEngine(opts.config ?? {});
    this.nextHandDelayMs = opts.nextHandDelayMs ?? 2500;
    this.turnTimeMs = opts.turnTimeMs ?? 20_000;
    this.graceMs = opts.disconnectGraceMs ?? 30_000;
  }

  // --- Identity / connection ------------------------------------------------

  identify(socketId: string, payload: IdentifyPayload): IdentifyResult {
    const name = (payload.name ?? "Player").slice(0, 20).trim() || "Player";

    let reg: PlayerReg | undefined;
    if (payload.sessionToken) {
      const existingId = this.tokenToId.get(payload.sessionToken);
      if (existingId) reg = this.playersById.get(existingId);
    }

    if (reg) {
      // Reconnection within (or after) grace: rebind the socket, cancel any
      // pending grace timer, and bring them back into the rotation.
      reg.socketId = socketId;
      reg.name = name;
      this.clearGrace(reg.playerId);
      if (reg.seated) this.engine.setSitOut(reg.playerId, false);
    } else {
      const playerId = randomUUID();
      const sessionToken = randomUUID();
      reg = { playerId, name, sessionToken, socketId, seated: false };
      this.playersById.set(playerId, reg);
      this.tokenToId.set(sessionToken, playerId);
    }

    this.socketToPlayer.set(socketId, reg.playerId);
    this.afterStateChange();
    return { ok: true, playerId: reg.playerId, sessionToken: reg.sessionToken };
  }

  /**
   * Handle a socket dropping. The seat is HELD for a grace period so a refresh
   * or brief network blip doesn't lose it. The turn timer keeps the table
   * moving in the meantime; if grace expires, the player is folded and sat out
   * (seat still reclaimable via their session token).
   */
  disconnect(socketId: string): void {
    const playerId = this.socketToPlayer.get(socketId);
    this.socketToPlayer.delete(socketId);
    if (!playerId) return;
    const reg = this.playersById.get(playerId);
    if (!reg || reg.socketId !== socketId) return;

    reg.socketId = null;
    if (reg.seated) this.startGrace(playerId);
    this.afterStateChange();
  }

  private startGrace(playerId: string): void {
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      const reg = this.playersById.get(playerId);
      if (!reg || reg.socketId) return; // reconnected in time
      this.engine.forceFold(playerId);
      this.engine.setSitOut(playerId, true);
      this.afterStateChange();
    }, this.graceMs);
    this.graceTimers.set(playerId, t);
  }

  private clearGrace(playerId: string): void {
    const t = this.graceTimers.get(playerId);
    if (t) {
      clearTimeout(t);
      this.graceTimers.delete(playerId);
    }
  }

  private isConnected(playerId: string): boolean {
    return !!this.playersById.get(playerId)?.socketId;
  }

  playerIdForSocket(socketId: string): string | null {
    return this.socketToPlayer.get(socketId) ?? null;
  }

  // --- Table actions --------------------------------------------------------

  sit(playerId: string, payload: SitPayload): void {
    const reg = this.requireReg(playerId);
    if (reg.seated) throw new Error("You are already seated");
    this.engine.seatPlayer({
      id: playerId,
      name: reg.name,
      seatIndex: payload.seatIndex,
      buyIn: payload.buyIn ?? this.engine.state.config.startingStack,
    });
    reg.seated = true;
    this.startHandIfReady();
    this.afterStateChange();
  }

  leaveSeat(playerId: string): void {
    const reg = this.requireReg(playerId);
    if (!reg.seated) return;
    this.engine.removePlayer(playerId);
    reg.seated = false;
    this.afterStateChange();
  }

  setSitOut(playerId: string, sitOut: boolean): void {
    this.requireReg(playerId);
    this.engine.setSitOut(playerId, sitOut);
    this.afterStateChange();
  }

  action(playerId: string, payload: ActionPayload): void {
    // The engine validates turn order and legality and throws on any violation.
    this.engine.applyAction(playerId, { type: payload.type, amount: payload.amount });
    this.afterStateChange();
  }

  // --- Chat -----------------------------------------------------------------

  chat(playerId: string, text: string): void {
    const reg = this.requireReg(playerId);
    const clean = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!clean) return;
    const msg: ChatMessage = {
      id: randomUUID(),
      playerId,
      name: reg.name,
      text: clean,
      ts: Date.now(),
    };
    this.chatLog.push(msg);
    if (this.chatLog.length > 100) this.chatLog.shift();
    // Scoped to this table's Socket.IO room only — other tables must not see it.
    this.io.to(this.tableId).emit(EVENTS.ChatMessage, msg);
  }

  chatHistory(): ChatMessage[] {
    return this.chatLog.slice();
  }

  // --- Hand lifecycle -------------------------------------------------------

  private startHandIfReady(): void {
    if (this.nextHandTimer) return; // a start is already scheduled
    if (this.engine.canStartHand()) this.engine.startHand();
  }

  private scheduleNextHand(): void {
    if (this.nextHandTimer) return;
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      if (this.engine.canStartHand()) this.engine.startHand();
      this.syncTurnTimer();
      this.broadcast();
    }, this.nextHandDelayMs);
  }

  /** Broadcast + keep timers in sync; queue the next hand if one just finished. */
  private afterStateChange(): void {
    this.syncTurnTimer();
    this.broadcast();
    const phase = this.engine.state.phase;
    if (
      (phase === Phase.HandComplete || phase === Phase.WaitingForPlayers) &&
      this.engine.canStartHand()
    ) {
      this.scheduleNextHand();
    }
  }

  // --- Turn timer -----------------------------------------------------------

  /**
   * Arm (or leave running) the timer for the player currently to act. Called
   * after every state change. If the acting seat is unchanged, the existing
   * timer keeps running — so an unrelated event (a sit, a chat) can't reset an
   * opponent's clock.
   */
  private syncTurnTimer(): void {
    const seat = this.engine.state.actingIndex;
    if (seat === this.turnSeat && this.turnTimer) return;

    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnSeat = seat;
    if (seat === null) {
      this.turnDeadline = null;
      return;
    }
    this.turnDeadline = Date.now() + this.turnTimeMs;
    this.turnTimer = setTimeout(() => this.onTurnTimeout(seat), this.turnTimeMs);
  }

  private onTurnTimeout(seat: number): void {
    // Ignore if the situation moved on before the timer fired.
    if (this.engine.state.actingIndex !== seat) return;
    const p = this.engine.state.seats[seat];
    if (!p) return;

    const legal = this.engine.legalActionsFor(seat);
    try {
      // Check for free when possible; otherwise fold. (Standard time-out rule.)
      this.engine.applyAction(p.id, legal.canCheck ? { type: "check" } : { type: "fold" });
    } catch {
      // If the auto-action was somehow illegal, leave state as-is.
    }
    // A player who timed out while disconnected is sat out so they stop
    // stalling every hand until they return.
    if (!this.isConnected(p.id)) this.engine.setSitOut(p.id, true);
    this.afterStateChange();
  }

  // --- Broadcasting ---------------------------------------------------------

  private connectedIds(): Set<string> {
    const ids = new Set<string>();
    for (const reg of this.playersById.values()) {
      if (reg.socketId) ids.add(reg.playerId);
    }
    return ids;
  }

  /** Lobby-level snapshot — enough to render a row in the "browse tables" list. */
  summary(): TableSummary {
    return {
      tableId: this.tableId,
      name: this.name,
      playerCount: this.engine.state.seats.filter((p) => p !== null).length,
      maxSeats: this.engine.state.config.maxSeats,
      handNumber: this.engine.state.handNumber,
      phase: this.engine.state.phase,
    };
  }

  /** Whether any socket is currently attached to this table. */
  hasConnections(): boolean {
    for (const reg of this.playersById.values()) {
      if (reg.socketId) return true;
    }
    return false;
  }

  stateFor(viewerId: string | null): PublicTableState {
    return redactStateFor(this.engine, {
      tableId: this.tableId,
      tableName: this.name,
      viewerId,
      connectedIds: this.connectedIds(),
      actingDeadline: this.turnDeadline,
      turnTimeMs: this.turnTimeMs,
    });
  }

  broadcast(): void {
    for (const [socketId, playerId] of this.socketToPlayer.entries()) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (!socket) continue;
      socket.emit(EVENTS.State, this.stateFor(playerId));
    }
  }

  private requireReg(playerId: string): PlayerReg {
    const reg = this.playersById.get(playerId);
    if (!reg) throw new Error("Unknown player — identify first");
    return reg;
  }

  /** Cancel all timers (used on shutdown / in tests). */
  dispose(): void {
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
    if (this.turnTimer) clearTimeout(this.turnTimer);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.nextHandTimer = null;
    this.turnTimer = null;
    this.graceTimers.clear();
  }
}
