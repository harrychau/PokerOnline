import { useEffect, useRef, useState } from "react";
import type { PlayerStats, PublicSeat } from "../protocol";
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
  /** Re-keys the hole cards so each new hand deals in fresh. */
  handNumber?: number;
  /** Position in the deal order (0 = first), used to stagger the deal. */
  dealOrder?: number;
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
  handNumber = 0,
  dealOrder = 0,
}: SeatProps) {
  const collecting = useChipCollection(seat?.streetCommitted ?? 0, handNumber);

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
  const won = winnerAmount !== undefined;
  const classes = [
    "seat",
    seat.isActing ? "seat-acting" : "",
    isYou ? "seat-you" : "",
    folded ? "seat-folded" : "",
    !seat.connected ? "seat-disconnected" : "",
    won ? "seat-winner" : "",
  ].join(" ");

  // Cards land one at a time around the table, the way a dealer pitches them.
  const dealDelay = (i: number) => dealOrder * 90 + i * 45;

  return (
    <div className={classes}>
      {seat.isActing && actingDeadline != null && (
        <TurnTimer deadline={actingDeadline} total={turnTimeMs ?? 20000} />
      )}
      <div className="seat-cards">
        {seat.hasCards ? (
          seat.holeCards ? (
            seat.holeCards.map((c, i) => (
              <PlayingCard
                key={`${handNumber}-${i}`}
                card={c}
                delayMs={dealDelay(i)}
                muted={folded}
                // Hole cards are always face-down until they are yours to see:
                // your own turn over as they land, an opponent's turn over where
                // they lie at showdown. Either way the reveal is a flip.
                flip
              />
            ))
          ) : (
            <>
              <CardBack key={`${handNumber}-0`} delayMs={dealDelay(0)} />
              <CardBack key={`${handNumber}-1`} delayMs={dealDelay(1)} />
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
      <StatsHud stats={seat.stats} />
      {seat.streetCommitted > 0 && (
        <div className="seat-bet">
          <span className="bet-chip" aria-hidden="true" />
          {seat.streetCommitted}
        </div>
      )}
      {/* The bet that just left this seat, shown travelling into the pot. */}
      {collecting !== null && (
        <div className="seat-bet chips-fly" key={collecting.id} aria-hidden="true">
          <span className="bet-chip" />
          {collecting.amount}
        </div>
      )}
      {won && <div className="seat-win">+{winnerAmount}</div>}
    </div>
  );
}

/**
 * Watches a seat's street bet and reports it once, briefly, at the moment it
 * gets pulled in — the server just zeroes the number when a street closes, so
 * without this the chips would blink out where they stand instead of visibly
 * moving to the pot they end up in.
 */
function useChipCollection(
  streetCommitted: number,
  handNumber: number,
): { id: number; amount: number } | null {
  const [flying, setFlying] = useState<{ id: number; amount: number } | null>(null);
  const previous = useRef({ amount: 0, handNumber });
  const nextId = useRef(0);

  useEffect(() => {
    const prior = previous.current;
    previous.current = { amount: streetCommitted, handNumber };

    // Only a bet dropping to zero within the same hand is a collection. A new
    // hand zeroes everyone's bet as a matter of bookkeeping, which is not chips
    // moving anywhere.
    if (prior.handNumber !== handNumber || streetCommitted !== 0 || prior.amount <= 0) return;

    const entry = { id: nextId.current++, amount: prior.amount };
    setFlying(entry);
    const timer = setTimeout(() => {
      setFlying((current) => (current?.id === entry.id ? null : current));
    }, 600);
    return () => clearTimeout(timer);
  }, [streetCommitted, handNumber]);

  return flying;
}

/**
 * The stats strip under each player's profile — the same three numbers a poker
 * HUD leads with, because together they characterise how someone plays:
 * how often they enter a pot, how often they enter it raising, and how hard they
 * push once they're in.
 */
function StatsHud({ stats }: { stats: PlayerStats | null }) {
  if (!stats || stats.hands === 0) return null;

  const vpip = (stats.vpip / stats.hands) * 100;
  const pfr = (stats.pfr / stats.hands) * 100;
  // Undefined rather than infinite when a player has never called: showing "∞"
  // after a single raise would read as a hard read on no evidence.
  const af = stats.calls > 0 ? stats.aggressive / stats.calls : null;

  // Under ~20 hands these numbers swing wildly on variance alone, so fade them
  // rather than presenting noise with the same confidence as a real read.
  const thin = stats.hands < 20;

  const tip =
    `${stats.hands} hands\n` +
    `VPIP ${vpip.toFixed(0)}% — entered the pot voluntarily (${stats.vpip})\n` +
    `PFR ${pfr.toFixed(0)}% — raised preflop (${stats.pfr})\n` +
    `AF ${af === null ? "—" : af.toFixed(1)} — ${stats.aggressive} bets/raises per ${stats.calls} calls\n` +
    `Won ${stats.won} · showdowns ${stats.showdowns}` +
    (thin ? "\n\nToo few hands to read much into yet." : "");

  return (
    <div className={`seat-stats ${thin ? "seat-stats--thin" : ""}`} title={tip}>
      <div className="stat">
        <span className="stat-label">VPIP</span>
        <span className={`stat-value ${vpipTone(vpip)}`}>{vpip.toFixed(0)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">PFR</span>
        <span className="stat-value">{pfr.toFixed(0)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">AF</span>
        <span className="stat-value">{af === null ? "—" : af.toFixed(1)}</span>
      </div>
    </div>
  );
}

/** Tight / standard / loose, by the usual full-ring rules of thumb. */
function vpipTone(vpip: number): string {
  if (vpip < 18) return "stat-tight";
  if (vpip > 35) return "stat-loose";
  return "";
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
