import type { PublicTableState } from "../protocol";
import { HAND_CATEGORY_NAMES } from "../protocol";
import { PlayingCard, CardSlot } from "./Card";
import { Seat } from "./Seat";

interface TableProps {
  state: PublicTableState;
  onSit: (seatIndex: number) => void;
}

/** Board + pot in the center, seats arranged around an ellipse. */
export function Table({ state, onSit }: TableProps) {
  const n = state.config.maxSeats;
  const youSeated = state.yourSeatIndex !== null;

  // Rotate the layout so the viewer's seat sits at the bottom-center.
  const anchor = state.yourSeatIndex ?? 0;

  // Map winner payouts by player id for the result overlay.
  const winnings = new Map<string, number>();
  if (state.phase === "HAND_COMPLETE" && state.lastResult) {
    for (const pot of state.lastResult.potResults) {
      for (const w of pot.winners) {
        winnings.set(w.playerId, (winnings.get(w.playerId) ?? 0) + w.amountWon);
      }
    }
  }

  return (
    <div className="table-area">
      <div className="felt">
        {/* Center: pot + community board */}
        <div className="center">
          <div className="pot">Pot: {state.pot}</div>
          <div className="board">
            {Array.from({ length: 5 }).map((_, i) =>
              state.board[i] ? <PlayingCard key={i} card={state.board[i]!} /> : <CardSlot key={i} />,
            )}
          </div>
          <div className="phase">{phaseLabel(state)}</div>
          {state.phase === "HAND_COMPLETE" && <ResultLine state={state} />}
        </div>

        {/* Seats around the ellipse */}
        {Array.from({ length: n }).map((_, seatIndex) => {
          const rel = (seatIndex - anchor + n) % n; // 0 = you, at the bottom
          const angle = (Math.PI / 2) + (rel * 2 * Math.PI) / n; // 90° = bottom
          const left = 50 + 44 * Math.cos(angle);
          const top = 50 + 40 * Math.sin(angle);
          const seat = state.seats[seatIndex] ?? null;
          return (
            <div
              key={seatIndex}
              className="seat-slot"
              style={{ left: `${left}%`, top: `${top}%` }}
            >
              <Seat
                seat={seat}
                seatIndex={seatIndex}
                isYou={seat?.playerId === state.youPlayerId}
                canSit={!youSeated && seat === null}
                onSit={onSit}
                winnerAmount={seat ? winnings.get(seat.playerId) : undefined}
                actingDeadline={state.actingDeadline}
                turnTimeMs={state.turnTimeMs}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function phaseLabel(state: PublicTableState): string {
  switch (state.phase) {
    case "WAITING_FOR_PLAYERS":
      return "Waiting for players…";
    case "HAND_COMPLETE":
      return `Hand #${state.handNumber} complete`;
    default:
      return `${state.phase} · Hand #${state.handNumber}`;
  }
}

function ResultLine({ state }: { state: PublicTableState }) {
  const r = state.lastResult;
  if (!r) return null;
  return (
    <div className="result">
      {r.potResults.map((pot, i) =>
        pot.winners.map((w) => {
          const name = state.seats.find((s) => s?.playerId === w.playerId)?.name ?? "?";
          const hand =
            !pot.uncontested && w.hand ? ` with ${HAND_CATEGORY_NAMES[w.hand.category]}` : "";
          return (
            <div key={`${i}-${w.playerId}`} className="result-line">
              {name} wins {w.amountWon}
              {hand}
              {pot.uncontested ? " (uncontested)" : ""}
            </div>
          );
        }),
      )}
    </div>
  );
}
