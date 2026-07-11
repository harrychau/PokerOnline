/**
 * Turns the engine's full internal state into a per-viewer `PublicTableState`,
 * hiding information the viewer must not see — above all, other players' hole
 * cards before showdown.
 *
 * This is a PURE function and is unit-tested directly (see redact.test.ts),
 * because "never leak hole cards" is a correctness/security guarantee we can't
 * afford to get subtly wrong behind a socket.
 */
import type { GameEngine } from "../engine/gameEngine.js";
import { Phase, PlayerStatus } from "../engine/types.js";
import type { PublicSeat, PublicTableState } from "./protocol.js";

export interface RedactOptions {
  tableId: string;
  /** The viewer's player id, or null for a pure spectator. */
  viewerId: string | null;
  /** Player ids whose sockets are currently connected. */
  connectedIds: Set<string>;
  /** Epoch-ms deadline for the acting player, or null. Owned by the Room. */
  actingDeadline?: number | null;
  /** Full turn time in ms (for the client countdown ring). */
  turnTimeMs?: number;
}

export function redactStateFor(engine: GameEngine, opts: RedactOptions): PublicTableState {
  const s = engine.state;
  const { tableId, viewerId, connectedIds } = opts;

  // Which players' hole cards may be revealed to everyone right now? Only at
  // hand completion, and only for players who actually showed down (i.e. appear
  // in the result's shownHands). Folded players and uncontested winners keep
  // their cards face-down — mirroring real poker.
  const revealedIds = new Set<string>();
  if (s.phase === Phase.HandComplete || s.phase === Phase.Showdown) {
    for (const id of Object.keys(s.lastResult?.shownHands ?? {})) revealedIds.add(id);
  }

  const legalForCurrent = engine.legalActionsForCurrent();

  const seats: Array<PublicSeat | null> = s.seats.map((p, seatIndex) => {
    if (!p) return null;

    const isSelf = viewerId !== null && p.id === viewerId;
    const maySeeCards = isSelf || revealedIds.has(p.id);
    const hasCards =
      p.holeCards !== null &&
      p.status !== PlayerStatus.SittingOut &&
      p.status !== PlayerStatus.Busted;

    const seat: PublicSeat = {
      seatIndex,
      playerId: p.id,
      name: p.name,
      stack: p.stack,
      streetCommitted: p.streetCommitted,
      status: p.status,
      hasCards,
      holeCards: maySeeCards && p.holeCards ? [...p.holeCards] : null,
      isButton: seatIndex === s.buttonIndex,
      isActing: seatIndex === s.actingIndex,
      connected: connectedIds.has(p.id),
      willSitOutNextHand: p.sitOutNextHand,
    };
    return seat;
  });

  const yourSeatIndex =
    viewerId !== null ? s.seats.findIndex((p) => p?.id === viewerId) : -1;

  return {
    tableId,
    config: s.config,
    phase: s.phase,
    board: [...s.board],
    pot: engine.totalPot(),
    currentBet: s.currentBet,
    minRaiseSize: s.minRaiseSize,
    buttonIndex: s.buttonIndex,
    actingIndex: s.actingIndex,
    handNumber: s.handNumber,
    seats,
    youPlayerId: viewerId,
    yourSeatIndex: yourSeatIndex === -1 ? null : yourSeatIndex,
    // Only attach legal actions when it is genuinely this viewer's turn.
    legalActions:
      legalForCurrent && legalForCurrent.playerId === viewerId
        ? legalForCurrent.actions
        : null,
    lastResult: s.lastResult,
    actingDeadline: opts.actingDeadline ?? null,
    turnTimeMs: opts.turnTimeMs ?? 20000,
  };
}
