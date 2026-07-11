import type { Card, Rank } from "./cards.js";

/**
 * Hand categories, ordered so a larger number always beats a smaller one.
 */
export enum HandCategory {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
}

export const HAND_CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: "High Card",
  [HandCategory.OnePair]: "One Pair",
  [HandCategory.TwoPair]: "Two Pair",
  [HandCategory.ThreeOfAKind]: "Three of a Kind",
  [HandCategory.Straight]: "Straight",
  [HandCategory.Flush]: "Flush",
  [HandCategory.FullHouse]: "Full House",
  [HandCategory.FourOfAKind]: "Four of a Kind",
  [HandCategory.StraightFlush]: "Straight Flush",
};

/**
 * A fully-evaluated 5-card hand.
 *
 * `tiebreakers` is an array of ranks ordered from most to least significant,
 * used to break ties *within* a category. For example a full house of aces
 * over kings is [14, 13]; two pair kings and threes with a queen kicker is
 * [13, 3, 12]. Comparing two hands is: compare category, then compare
 * tiebreakers element by element.
 */
export interface HandRank {
  category: HandCategory;
  tiebreakers: number[];
  /** The exact 5 cards that make this hand (useful for UIs/logging). */
  cards: Card[];
}

/**
 * Compare two evaluated hands.
 * Returns > 0 if a beats b, < 0 if b beats a, 0 if they are exactly equal
 * (a genuine tie — the pot should be split).
 */
export function compareHandRank(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreakers[i] ?? 0;
    const bv = b.tiebreakers[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/** Descending sort of ranks, used throughout to build tiebreaker arrays. */
function descRanks(cards: Card[]): Rank[] {
  return cards.map((c) => c.rank).sort((x, y) => y - x);
}

/**
 * Given a set of ranks present, return the high card of the best straight, or
 * null if there is no straight. Handles the wheel (A-2-3-4-5) where the ace
 * plays low and the straight's high card is the 5.
 */
function straightHighCard(uniqueRanksDesc: number[]): number | null {
  // Treat an ace (14) as also a low ace (1) for wheel detection.
  const ranks = uniqueRanksDesc.slice();
  if (ranks.includes(14)) ranks.push(1);
  // ranks is descending; walk looking for 5 consecutive values.
  let run = 1;
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] === ranks[i - 1]! - 1) {
      run++;
      if (run >= 5) return ranks[i - 4]!; // high card of the run
    } else if (ranks[i] !== ranks[i - 1]) {
      run = 1;
    }
  }
  return null;
}

/**
 * Evaluate exactly 5 cards. Callers with 7 cards should use evaluateBest7,
 * which finds the best 5-card subset.
 */
export function evaluate5(cards: Card[]): HandRank {
  if (cards.length !== 5) {
    throw new Error(`evaluate5 expects 5 cards, got ${cards.length}`);
  }

  // Count how many of each rank we hold, and detect a flush.
  const rankCounts = new Map<number, number>();
  for (const c of cards) {
    rankCounts.set(c.rank, (rankCounts.get(c.rank) ?? 0) + 1);
  }
  const isFlush = cards.every((c) => c.suit === cards[0]!.suit);

  const uniqueRanksDesc = [...rankCounts.keys()].sort((a, b) => b - a);
  const straightHigh = straightHighCard(uniqueRanksDesc);

  // Groups of ranks sorted by (count desc, then rank desc). This ordering makes
  // building tiebreakers trivial: the biggest group is the most significant.
  const groups = [...rankCounts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });
  const counts = groups.map((g) => g[1]);

  if (straightHigh !== null && isFlush) {
    return { category: HandCategory.StraightFlush, tiebreakers: [straightHigh], cards };
  }
  if (counts[0] === 4) {
    const quad = groups[0]![0];
    const kicker = groups[1]![0];
    return { category: HandCategory.FourOfAKind, tiebreakers: [quad, kicker], cards };
  }
  if (counts[0] === 3 && counts[1] === 2) {
    return {
      category: HandCategory.FullHouse,
      tiebreakers: [groups[0]![0], groups[1]![0]],
      cards,
    };
  }
  if (isFlush) {
    return { category: HandCategory.Flush, tiebreakers: descRanks(cards), cards };
  }
  if (straightHigh !== null) {
    return { category: HandCategory.Straight, tiebreakers: [straightHigh], cards };
  }
  if (counts[0] === 3) {
    const trips = groups[0]![0];
    const kickers = groups.slice(1).map((g) => g[0]);
    return { category: HandCategory.ThreeOfAKind, tiebreakers: [trips, ...kickers], cards };
  }
  if (counts[0] === 2 && counts[1] === 2) {
    // groups already sorted so the higher pair is first.
    const highPair = groups[0]![0];
    const lowPair = groups[1]![0];
    const kicker = groups[2]![0];
    return {
      category: HandCategory.TwoPair,
      tiebreakers: [highPair, lowPair, kicker],
      cards,
    };
  }
  if (counts[0] === 2) {
    const pair = groups[0]![0];
    const kickers = groups.slice(1).map((g) => g[0]);
    return { category: HandCategory.OnePair, tiebreakers: [pair, ...kickers], cards };
  }
  return { category: HandCategory.HighCard, tiebreakers: descRanks(cards), cards };
}

/** All k-combinations of indices [0, n). */
function combinations(n: number, k: number): number[][] {
  const result: number[][] = [];
  const combo: number[] = [];
  const recurse = (start: number): void => {
    if (combo.length === k) {
      result.push(combo.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      combo.push(i);
      recurse(i + 1);
      combo.pop();
    }
  };
  recurse(0);
  return result;
}

/**
 * Evaluate the best 5-card hand from 5, 6, or 7 cards (typically 2 hole + up to
 * 5 community cards). Brute-forces all C(n,5) subsets — with n<=7 that's at
 * most 21 combinations, which is trivially fast and unambiguously correct.
 */
export function evaluateBest(cards: Card[]): HandRank {
  if (cards.length < 5) {
    throw new Error(`Need at least 5 cards to evaluate, got ${cards.length}`);
  }
  if (cards.length === 5) return evaluate5(cards);

  let best: HandRank | null = null;
  for (const idx of combinations(cards.length, 5)) {
    const hand = evaluate5(idx.map((i) => cards[i]!));
    if (best === null || compareHandRank(hand, best) > 0) {
      best = hand;
    }
  }
  return best!;
}

/** Alias matching the "best 5-of-7" phrasing in the brief. */
export const evaluateBest7 = evaluateBest;
