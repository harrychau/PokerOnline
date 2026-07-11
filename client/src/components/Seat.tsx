import type { PublicSeat } from "../protocol";
import { CardBack, PlayingCard } from "./Card";
import { TurnTimer } from "./TurnTimer";

interface SeatProps {
  seat: PublicSeat | null;
  seatIndex: number;
  isYou: boolean;
  canSit: boolean;
  onSit: (seatIndex: number) => void;
  winnerAmount?: number;
  /** Epoch-ms deadline when this seat is the one to act; null otherwise. */
  actingDeadline?: number | null;
  turnTimeMs?: number;
}

/** One seat around the table: player info, chips, and their hole cards. */
export function Seat({
  seat,
  seatIndex,
  isYou,
  canSit,
  onSit,
  winnerAmount,
  actingDeadline,
  turnTimeMs,
}: SeatProps) {
  if (!seat) {
    return (
      <div className="seat seat-empty">
        {canSit ? (
          <button className="sit-btn" onClick={() => onSit(seatIndex)}>
            Sit here
          </button>
        ) : (
          <span className="seat-empty-label">Seat {seatIndex}</span>
        )}
      </div>
    );
  }

  const folded = seat.status === "FOLDED";
  const classes = [
    "seat",
    seat.isActing ? "seat-acting" : "",
    isYou ? "seat-you" : "",
    folded ? "seat-folded" : "",
    !seat.connected ? "seat-disconnected" : "",
  ].join(" ");

  return (
    <div className={classes}>
      {seat.isActing && actingDeadline != null && (
        <TurnTimer deadline={actingDeadline} total={turnTimeMs ?? 20000} />
      )}
      <div className="seat-cards">
        {seat.hasCards ? (
          seat.holeCards ? (
            seat.holeCards.map((c, i) => <PlayingCard key={i} card={c} />)
          ) : (
            <>
              <CardBack />
              <CardBack />
            </>
          )
        ) : null}
      </div>
      <div className="seat-info">
        <div className="seat-name">
          {seat.isButton && <span className="dealer-btn" title="Dealer button">D</span>}
          {seat.name}
          {isYou && <span className="you-tag"> (you)</span>}
          {!seat.connected && <span className="offline-tag"> ⚠offline</span>}
        </div>
        <div className="seat-stack">${seat.stack}</div>
        <div className="seat-status">{statusLabel(seat)}</div>
      </div>
      {seat.streetCommitted > 0 && <div className="seat-bet">bet {seat.streetCommitted}</div>}
      {winnerAmount !== undefined && <div className="seat-win">+{winnerAmount}</div>}
    </div>
  );
}

function statusLabel(seat: PublicSeat): string {
  switch (seat.status) {
    case "ALL_IN":
      return "ALL IN";
    case "FOLDED":
      return "folded";
    case "SITTING_OUT":
      // Between hands a just-seated player is SITTING_OUT but hasn't *chosen*
      // to; only label a deliberate sit-out.
      return seat.willSitOutNextHand ? "sitting out" : "waiting";
    case "BUSTED":
      return "busted";
    default:
      return "";
  }
}
