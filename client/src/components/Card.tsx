import type { Card as CardType, Suit } from "../protocol";

const RANK_LABEL: Record<number, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
  10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

const SUIT_SYMBOL: Record<Suit, string> = { c: "♣", d: "♦", h: "♥", s: "♠" };
const SUIT_RED: Record<Suit, boolean> = { c: false, d: true, h: true, s: false };

export function PlayingCard({ card }: { card: CardType }) {
  const red = SUIT_RED[card.suit];
  return (
    <div className={`card ${red ? "card-red" : "card-black"}`}>
      <span className="card-rank">{RANK_LABEL[card.rank]}</span>
      <span className="card-suit">{SUIT_SYMBOL[card.suit]}</span>
    </div>
  );
}

/** Face-down card (an opponent's hidden hole card). */
export function CardBack() {
  return <div className="card card-back" aria-label="face-down card" />;
}

/** Empty placeholder where a card could be. */
export function CardSlot() {
  return <div className="card card-slot" />;
}
