import { useEffect, useState } from "react";
import type { ActionPayload, LegalActions } from "../protocol";

interface ActionBarProps {
  legal: LegalActions;
  /** Highest street bet — 0 means the aggressive action is an opening bet. */
  currentBet: number;
  /** Total pot, used to size the preset raise buttons. */
  pot: number;
  onAct: (a: ActionPayload) => void;
}

/**
 * The betting controls. Everything is driven by the server-provided
 * `legalActions`; the client never decides what's legal, it only offers the
 * options the server already said are allowed and submits the intent.
 */
export function ActionBar({ legal, currentBet, pot, onAct }: ActionBarProps) {
  const isOpen = currentBet === 0; // opening bet vs. raising an existing bet
  const [amount, setAmount] = useState(legal.minBetTo);

  // Reset the slider to the minimum whenever a new decision starts.
  useEffect(() => {
    setAmount(legal.minBetTo);
  }, [legal.minBetTo, legal.maxBetTo]);

  const canAggress = legal.canBet || legal.canRaise;
  const clamp = (v: number) => Math.max(legal.minBetTo, Math.min(legal.maxBetTo, Math.round(v)));

  /** A pot-fraction "raise to" total, clamped to the legal range. */
  const presetTo = (fraction: number): number => {
    const potIfCall = pot + legal.callAmount;
    const increment = Math.round(fraction * potIfCall);
    return clamp((isOpen ? 0 : currentBet) + increment);
  };

  return (
    <div className="actionbar">
      <div className="actionbar-buttons">
        {legal.canFold && (
          <button className="btn btn-fold" onClick={() => onAct({ type: "fold" })}>
            Fold
          </button>
        )}
        {legal.canCheck && (
          <button className="btn btn-check" onClick={() => onAct({ type: "check" })}>
            Check
          </button>
        )}
        {legal.canCall && (
          <button className="btn btn-call" onClick={() => onAct({ type: "call" })}>
            Call {legal.callAmount}
          </button>
        )}
        {canAggress && (
          <button
            className="btn btn-raise"
            onClick={() => onAct({ type: isOpen ? "bet" : "raise", amount })}
          >
            {isOpen ? "Bet" : "Raise to"} {amount}
          </button>
        )}
      </div>

      {canAggress && (
        <div className="actionbar-sizing">
          <input
            type="range"
            min={legal.minBetTo}
            max={legal.maxBetTo}
            value={amount}
            onChange={(e) => setAmount(clamp(Number(e.target.value)))}
          />
          <input
            type="number"
            className="amount-input"
            min={legal.minBetTo}
            max={legal.maxBetTo}
            value={amount}
            onChange={(e) => setAmount(clamp(Number(e.target.value)))}
          />
          <div className="presets">
            <button onClick={() => setAmount(presetTo(0.5))}>½ Pot</button>
            <button onClick={() => setAmount(presetTo(1))}>Pot</button>
            <button onClick={() => setAmount(legal.maxBetTo)}>All-in</button>
          </div>
        </div>
      )}
    </div>
  );
}
