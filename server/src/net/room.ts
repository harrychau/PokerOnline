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
  type UpdateSettingsPayload,
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
  /**
   * Pause between streets once everyone is all-in, ms. The hand is already
   * decided by then, so this is purely so the table gets to watch the board
   * arrive instead of having the result land on them at once.
   */
  runoutRevealMs?: number;
}

/** Bounds for owner-set turn timers — long enough to think, short enough to play. */
const MIN_TURN_TIME_MS = 5_000;
const MAX_TURN_TIME_MS = 120_000;

export class Room {
  readonly tableId: string;
  readonly name: string;
  readonly engine: GameEngine;
  private io: IOServer;
  private nextHandDelayMs: number;
  private turnTimeMs: number;
  private graceMs: number;
  private runoutRevealMs: number;

  private playersById = new Map<string, PlayerReg>();
  private tokenToId = new Map<string, string>();
  private socketToPlayer = new Map<string, string>();

  /**
   * Who may change this table's settings. The first player through the door owns
   * it (they are, in practice, whoever just created it), and ownership moves on
   * if they vanish — see `reassignOwner`.
   */
  private ownerPlayerId: string | null = null;

  /**
   * Owner changes waiting on the current hand to finish. Blinds, seat counts and
   * stacks all feed a live hand's math, so they queue rather than apply mid-hand.
   */
  private pendingConfig: Partial<TableConfig> | null = null;
  private pendingStacks = new Map<string, number>();

  private nextHandTimer: ReturnType<typeof setTimeout> | null = null;
  private runoutTimer: ReturnType<typeof setTimeout> | null = null;

  // Turn timer: which turn it's for, when it fires, and the handle.
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnId: number | null = null;
  private turnDeadline: number | null = null;

  // Per-player reconnect grace timers.
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private chatLog: ChatMessage[] = [];

  constructor(io: IOServer, opts: RoomOptions = {}) {
    this.io = io;
    this.tableId = opts.tableId ?? "main";
    this.name = opts.name ?? "Table";
    // Stepped runout: the Room puts a real pause between streets, so the engine
    // deals an all-in board one street per beat instead of in one go.
    this.engine = new GameEngine(opts.config ?? {}, undefined, { steppedRunout: true });
    this.nextHandDelayMs = opts.nextHandDelayMs ?? 2500;
    this.turnTimeMs = opts.turnTimeMs ?? 20_000;
    this.graceMs = opts.disconnectGraceMs ?? 30_000;
    this.runoutRevealMs = opts.runoutRevealMs ?? 1400;
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

    // An unowned table is claimed by whoever turns up first — normally the
    // player who just created it, since creating one drops you straight into it.
    if (this.ownerPlayerId === null) this.ownerPlayerId = reg.playerId;

    this.socketToPlayer.set(socketId, reg.playerId);
    this.afterStateChange();
    return { ok: true, playerId: reg.playerId, sessionToken: reg.sessionToken };
  }

  /** True if this player currently controls the table's settings. */
  isOwner(playerId: string): boolean {
    return this.ownerPlayerId === playerId;
  }

  /**
   * Hand the table to someone still here. Called once a departed owner's grace
   * has run out — without it a table whose owner never comes back could never
   * have its blinds touched again. Falls back to null so the next arrival claims
   * it rather than leaving the table permanently unowned.
   */
  private reassignOwner(): void {
    for (const reg of this.playersById.values()) {
      if (reg.socketId) {
        this.ownerPlayerId = reg.playerId;
        return;
      }
    }
    this.ownerPlayerId = null;
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
    // An owner watching from the rail still needs a grace timer, so that
    // ownership moves on if they never come back.
    if (reg.seated || this.ownerPlayerId === playerId) this.startGrace(playerId);
    this.afterStateChange();
  }

  private startGrace(playerId: string): void {
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      const reg = this.playersById.get(playerId);
      if (!reg || reg.socketId) return; // reconnected in time
      if (reg.seated) {
        this.engine.forceFold(playerId);
        this.engine.setSitOut(playerId, true);
      }
      if (this.ownerPlayerId === playerId) this.reassignOwner();
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

  /**
   * Apply an owner's settings change. Blinds, seats and stacks are queued and
   * land the moment the table is between hands — which, if no hand is running,
   * is immediately (`afterStateChange` flushes them below). The turn timer needs
   * no queue: it only sizes the *next* countdown.
   *
   * Everything is validated before anything is applied, so a single bad field
   * rejects the whole change rather than half-applying it.
   */
  updateSettings(playerId: string, payload: UpdateSettingsPayload): void {
    this.requireReg(playerId);
    if (!this.isOwner(playerId)) throw new Error("Only the table owner can change settings");

    const { config, stacks, turnTimeMs } = payload ?? {};

    if (turnTimeMs !== undefined) {
      if (
        !Number.isFinite(turnTimeMs) ||
        turnTimeMs < MIN_TURN_TIME_MS ||
        turnTimeMs > MAX_TURN_TIME_MS
      ) {
        throw new Error(
          `Turn time must be between ${MIN_TURN_TIME_MS / 1000} and ${MAX_TURN_TIME_MS / 1000} seconds`,
        );
      }
    }
    if (config) this.engine.nextConfig({ ...this.pendingConfig, ...config });
    if (stacks) {
      for (const [id, value] of Object.entries(stacks)) {
        if (!Number.isInteger(value) || value < 0) {
          throw new Error("A stack must be a whole number of chips, 0 or more");
        }
        if (!this.playersById.has(id)) throw new Error("Unknown player");
      }
    }

    if (turnTimeMs !== undefined) this.turnTimeMs = Math.round(turnTimeMs);
    if (config) this.pendingConfig = { ...this.pendingConfig, ...config };
    if (stacks) for (const [id, v] of Object.entries(stacks)) this.pendingStacks.set(id, v);

    this.afterStateChange();
  }

  /** Whether owner changes are still waiting on a hand to finish. */
  private hasPendingSettings(): boolean {
    return this.pendingConfig !== null || this.pendingStacks.size > 0;
  }

  /**
   * Flush queued owner changes. Only ever called between hands. Re-validation can
   * still fail here — a seat that was empty when the owner shrank the table may
   * have filled since — so failures are reported to the owner rather than thrown
   * into whatever unrelated event happened to trigger the flush.
   */
  private applyPendingSettings(): void {
    const config = this.pendingConfig;
    const stacks = [...this.pendingStacks];
    this.pendingConfig = null;
    this.pendingStacks.clear();

    for (const [id, value] of stacks) {
      // A player can leave between queueing and applying; their stack change
      // simply has nowhere to land.
      if (this.engine.state.seats.some((p) => p?.id === id)) {
        this.tryOwnerChange(() => this.engine.setStack(id, value));
      }
    }
    if (config) this.tryOwnerChange(() => this.engine.updateConfig(config));
  }

  private tryOwnerChange(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const ownerSocket = this.ownerPlayerId
        ? this.playersById.get(this.ownerPlayerId)?.socketId
        : null;
      if (ownerSocket) {
        this.io.sockets.sockets
          .get(ownerSocket)
          ?.emit(EVENTS.ErrorMsg, { message: `Setting not applied: ${message}` });
      }
    }
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
    // The moment the table is between hands is the moment queued owner changes
    // become safe to apply — do it before broadcasting so players see the new
    // blinds and stacks in the same frame the hand ends.
    if (!this.engine.isHandInProgress() && this.hasPendingSettings()) {
      this.applyPendingSettings();
    }
    this.syncTurnTimer();
    this.syncRunout();
    this.broadcast();
    const phase = this.engine.state.phase;
    if (
      (phase === Phase.HandComplete || phase === Phase.WaitingForPlayers) &&
      this.engine.canStartHand()
    ) {
      this.scheduleNextHand();
    }
  }

  // --- All-in runout --------------------------------------------------------

  /**
   * Once everyone is all-in the hand is already decided, and the engine parks
   * rather than dealing the rest of the board. Drip one street per beat so the
   * table watches the cards arrive — the whole point of an all-in — instead of
   * the board and the result landing together.
   */
  private syncRunout(): void {
    if (this.runoutTimer || !this.engine.state.runoutPending) return;
    this.runoutTimer = setTimeout(() => {
      this.runoutTimer = null;
      this.engine.stepRunout();
      this.afterStateChange(); // re-arms until the runout reaches showdown
    }, this.runoutRevealMs);
  }

  // --- Turn timer -----------------------------------------------------------

  /**
   * Arm (or leave running) the timer for the player currently to act. Called
   * after every state change. While the same turn is still live the existing
   * timer keeps running, so an unrelated event (a sit, a chat) can't reset an
   * opponent's clock.
   *
   * A turn is identified by the engine's turn counter, NOT by the acting seat.
   * The same seat can be handed two turns in a row — heads-up, the big blind's
   * preflop option is followed by their first move on the flop — and keying off
   * the seat made that look like one continuous turn, so the second turn
   * silently inherited whatever was left of the first one's clock.
   */
  private syncTurnTimer(): void {
    const seat = this.engine.state.actingIndex;
    const turn = seat === null ? null : this.engine.state.actingTurn;
    if (turn !== null && turn === this.turnId && this.turnTimer) return;

    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnId = turn;
    if (seat === null) {
      this.turnDeadline = null;
      return;
    }
    this.turnDeadline = Date.now() + this.turnTimeMs;
    this.turnTimer = setTimeout(() => this.onTurnTimeout(turn!), this.turnTimeMs);
  }

  private onTurnTimeout(turn: number): void {
    // Ignore if the situation moved on before the timer fired. Comparing the
    // turn rather than the seat also covers the case where the same player has
    // since been handed a fresh turn: that turn gets its own full clock.
    if (this.engine.state.actingTurn !== turn) return;
    const seat = this.engine.state.actingIndex;
    if (seat === null) return;
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
      ownerPlayerId: this.ownerPlayerId,
      settingsPending: this.hasPendingSettings(),
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
    if (this.runoutTimer) clearTimeout(this.runoutTimer);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.nextHandTimer = null;
    this.turnTimer = null;
    this.runoutTimer = null;
    this.graceTimers.clear();
  }
}
