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
      <div className="seat-body">
        <div className="seat-avatar" style={{ background: avatarGradient(seat.name) }}>
          {initials(seat.name)}
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
      </div>
      {seat.streetCommitted > 0 && <div className="seat-bet">bet {seat.streetCommitted}</div>}
      {winnerAmount !== undefined && <div className="seat-win">+{winnerAmount}</div>}
    </div>
  );
}

/** Up to two initials from the player's name for the avatar chip. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** Deterministic, name-derived color so each player's avatar is recognisable. */
function avatarGradient(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 62% 68%), hsl(${(h + 40) % 360} 58% 52%))`;
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
