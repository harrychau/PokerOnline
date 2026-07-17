import type { Card as CardType, Suit } from "../protocol";

const RANK_LABEL: Record<number, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
  10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

const SUIT_SYMBOL: Record<Suit, string> = { c: "♣", d: "♦", h: "♥", s: "♠" };
const SUIT_RED: Record<Suit, boolean> = { c: false, d: true, h: true, s: false };

interface PlayingCardProps {
  card: CardType;
  /** Reveal by turning a face-down card over, rather than just fading in. */
  flip?: boolean;
  /** Hold the card back this long before it animates, for staggered deals. */
  delayMs?: number;
  /** Dim the card — used for a folded player's hand. */
  muted?: boolean;
}

export function PlayingCard({ card, flip, delayMs = 0, muted }: PlayingCardProps) {
  const red = SUIT_RED[card.suit];
  const face = (
    <>
      <span className="card-rank">{RANK_LABEL[card.rank]}</span>
      <span className="card-suit">{SUIT_SYMBOL[card.suit]}</span>
      <span className="card-corner" aria-hidden="true">
        {RANK_LABEL[card.rank]}
        {SUIT_SYMBOL[card.suit]}
      </span>
    </>
  );
  const label = `${RANK_LABEL[card.rank]}${SUIT_SYMBOL[card.suit]}`;
  const tone = red ? "card-red" : "card-black";

  if (!flip) {
    return (
      <div
        className={`card ${tone} card-deal ${muted ? "card-muted" : ""}`}
        style={{ animationDelay: `${delayMs}ms` }}
        aria-label={label}
      >
        {face}
      </div>
    );
  }

  // Two faces on a rotating plane: the back turns away as the front turns in, so
  // the card reads as being physically turned over rather than swapped out.
  return (
    <div
      className={`card-flip ${muted ? "card-muted" : ""}`}
      style={{ animationDelay: `${delayMs}ms` }}
      aria-label={label}
    >
      <div className="card-flip-inner" style={{ animationDelay: `${delayMs}ms` }}>
        <div className="card card-back card-face" />
        <div className={`card ${tone} card-face card-face-front`}>{face}</div>
      </div>
    </div>
  );
}

/** Face-down card (an opponent's hidden hole card). */
export function CardBack({ delayMs = 0 }: { delayMs?: number }) {
  return (
    <div
      className="card card-back card-deal"
      style={{ animationDelay: `${delayMs}ms` }}
      aria-label="face-down card"
    />
  );
}

/** Empty placeholder where a card could be. */
export function CardSlot() {
  return <div className="card card-slot" />;
}
