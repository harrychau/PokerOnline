import { useEffect, useState } from "react";

/**
 * A countdown ring for the acting player. It counts down locally against the
 * server-provided epoch-ms `deadline`, so the server doesn't broadcast ticks.
 */
export function TurnTimer({ deadline, total }: { deadline: number; total: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  const remainingMs = Math.max(0, deadline - now);
  const secs = Math.ceil(remainingMs / 1000);
  const frac = total > 0 ? Math.max(0, Math.min(1, remainingMs / total)) : 0;
  const deg = frac * 360;
  const urgent = remainingMs <= 5000;

  // Conic-gradient ring that empties clockwise; color turns red when urgent.
  const ringColor = urgent ? "#e05a5a" : "#e7c66b";
  return (
    <div
      className="turn-timer"
      style={{
        background: `conic-gradient(${ringColor} ${deg}deg, rgba(255,255,255,0.12) ${deg}deg)`,
      }}
      title={`${secs}s to act`}
    >
      <span className={`turn-timer-num ${urgent ? "urgent" : ""}`}>{secs}</span>
    </div>
  );
}
