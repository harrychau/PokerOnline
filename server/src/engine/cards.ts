import type { RNG } from "./rng.js";

/** Card ranks as numbers so they compare directly. 11=J 12=Q 13=K 14=A. */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

/** clubs, diamonds, hearts, spades */
export type Suit = "c" | "d" | "h" | "s";

export interface Card {
  rank: Rank;
  suit: Suit;
}

export const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const SUITS: Suit[] = ["c", "d", "h", "s"];

const RANK_TO_CHAR: Record<Rank, string> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

const CHAR_TO_RANK: Record<string, Rank> = Object.fromEntries(
  Object.entries(RANK_TO_CHAR).map(([r, c]) => [c, Number(r) as Rank]),
) as Record<string, Rank>;

/** Compact, human-readable card code, e.g. "As", "Th", "2c". */
export function cardToString(card: Card): string {
  return `${RANK_TO_CHAR[card.rank]}${card.suit}`;
}

/** Parse a card code like "As" or "Td". Throws on malformed input. */
export function cardFromString(code: string): Card {
  if (code.length !== 2) throw new Error(`Invalid card code: "${code}"`);
  const rank = CHAR_TO_RANK[code[0]!.toUpperCase()];
  const suit = code[1]!.toLowerCase() as Suit;
  if (rank === undefined) throw new Error(`Invalid rank in card code: "${code}"`);
  if (!SUITS.includes(suit)) throw new Error(`Invalid suit in card code: "${code}"`);
  return { rank, suit };
}

/** Convenience for tests: parse a space-separated list like "As Kd 2c". */
export function cardsFromString(codes: string): Card[] {
  return codes.trim().split(/\s+/).map(cardFromString);
}

/** A fresh, ordered 52-card deck. */
export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

/**
 * Fisher–Yates shuffle using the injected RNG. Returns a new array; does not
 * mutate the input. Deterministic given a deterministic RNG.
 */
export function shuffle(cards: Card[], rng: RNG): Card[] {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** A shuffled 52-card deck ready to deal from the top (index 0). */
export function makeShuffledDeck(rng: RNG): Card[] {
  return shuffle(makeDeck(), rng);
}
