import { useEffect, useRef } from "react";
import type { PublicTableState } from "../protocol";
import { HAND_CATEGORY_NAMES } from "../protocol";
import { PlayingCard, CardSlot } from "./Card";
import { Seat } from "./Seat";

interface TableProps {
  state: PublicTableState;
  onSit: (seatIndex: number) => void;
}

/** How far, in px, cards and chips travel to or from the middle of the table. */
const TRAVEL = 64;

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

  // Stagger each street's cards from where the previous street left off, so the
  // flop ripples out across three cards but the turn and river snap in alone
  // instead of waiting behind delays meant for cards already on the table.
  const dealtBefore = usePreviousBoardLength(state.board.length, state.handNumber);

  return (
    <div className="table-area">
      <div className="felt">
        {/* Center: pot + community board */}
        <div className="center">
          <PotDisplay state={state} />
          <div className="board">
            {Array.from({ length: 5 }).map((_, i) =>
              state.board[i] ? (
                <PlayingCard
                  key={`${state.handNumber}-${i}`}
                  card={state.board[i]!}
                  flip
                  delayMs={Math.max(0, i - dealtBefore) * 110}
                />
              ) : (
                <CardSlot key={`${state.handNumber}-${i}`} />
              ),
            )}
          </div>
          <div className="phase">{phaseLabel(state)}</div>
          {state.phase === "HAND_COMPLETE" && <ResultLine state={state} />}
        </div>

        {/* Seats around the ellipse */}
        {Array.from({ length: n }).map((_, seatIndex) => {
          const rel = (seatIndex - anchor + n) % n; // 0 = you, at the bottom
          const angle = Math.PI / 2 + (rel * 2 * Math.PI) / n; // 90° = bottom
          const left = 50 + 44 * Math.cos(angle);
          const top = 50 + 40 * Math.sin(angle);
          const seat = state.seats[seatIndex] ?? null;
          return (
            <div
              key={seatIndex}
              className="seat-slot"
              style={
                {
                  left: `${left}%`,
                  top: `${top}%`,
                  // Vector pointing from this seat back to the middle of the
                  // table. Cards are dealt along it and bets travel back down it
                  // into the pot.
                  "--to-center-x": `${-Math.cos(angle) * TRAVEL}px`,
                  "--to-center-y": `${-Math.sin(angle) * TRAVEL}px`,
                } as React.CSSProperties
              }
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
                handNumber={state.handNumber}
                dealOrder={rel}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * How many board cards were already showing before this render, resetting each
 * hand. Only used to time the deal animation.
 */
function usePreviousBoardLength(length: number, handNumber: number): number {
  const ref = useRef({ length: 0, handNumber });
  const previous = ref.current.handNumber === handNumber ? ref.current.length : 0;
  useEffect(() => {
    ref.current = { length, handNumber };
  }, [length, handNumber]);
  return previous;
}

/**
 * The pot in the middle. This counts only chips already gathered in — bets still
 * in front of players are drawn at their seats, and showing them in both places
 * would make the table look like it holds more money than it does.
 */
function PotDisplay({ state }: { state: PublicTableState }) {
  const inFront = state.potTotal - state.pot;
  return (
    <div className="pot-wrap">
      <div className="pot">
        <span className="pot-chip" aria-hidden="true" />
        Pot: {state.pot}
      </div>
      {inFront > 0 && <div className="pot-pending">+{inFront} betting</div>}
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
