import { describe, it, expect } from "vitest";
import { cardsFromString } from "../cards.js";
import {
  HandCategory,
  compareHandRank,
  evaluate5,
  evaluateBest,
} from "../handEvaluator.js";

/** Helper: evaluate a space-separated 5-card string. */
const ev5 = (s: string) => evaluate5(cardsFromString(s));
/** Helper: evaluate best-of-N from a space-separated string. */
const evN = (s: string) => evaluateBest(cardsFromString(s));

describe("evaluate5 — category detection", () => {
  it("detects a royal/straight flush", () => {
    const h = ev5("Ts Js Qs Ks As");
    expect(h.category).toBe(HandCategory.StraightFlush);
    expect(h.tiebreakers).toEqual([14]);
  });

  it("detects the wheel straight flush (5-high)", () => {
    const h = ev5("As 2s 3s 4s 5s");
    expect(h.category).toBe(HandCategory.StraightFlush);
    expect(h.tiebreakers).toEqual([5]); // ace plays low; 5 is the high card
  });

  it("detects four of a kind with kicker", () => {
    const h = ev5("9c 9d 9h 9s Kd");
    expect(h.category).toBe(HandCategory.FourOfAKind);
    expect(h.tiebreakers).toEqual([9, 13]);
  });

  it("detects a full house", () => {
    const h = ev5("Qc Qd Qh 4s 4d");
    expect(h.category).toBe(HandCategory.FullHouse);
    expect(h.tiebreakers).toEqual([12, 4]);
  });

  it("detects a flush by high cards", () => {
    const h = ev5("2h 5h 9h Jh Kh");
    expect(h.category).toBe(HandCategory.Flush);
    expect(h.tiebreakers).toEqual([13, 11, 9, 5, 2]);
  });

  it("detects a plain straight", () => {
    const h = ev5("5c 6d 7h 8s 9d");
    expect(h.category).toBe(HandCategory.Straight);
    expect(h.tiebreakers).toEqual([9]);
  });

  it("detects the wheel straight (A-2-3-4-5)", () => {
    const h = ev5("Ac 2d 3h 4s 5d");
    expect(h.category).toBe(HandCategory.Straight);
    expect(h.tiebreakers).toEqual([5]);
  });

  it("does NOT count A-K-Q-J-... wraparound as a straight (Q-K-A-2-3)", () => {
    const h = ev5("Qc Kd Ah 2s 3d");
    expect(h.category).toBe(HandCategory.HighCard);
  });

  it("detects three of a kind with kickers", () => {
    const h = ev5("7c 7d 7h Kd 2s");
    expect(h.category).toBe(HandCategory.ThreeOfAKind);
    expect(h.tiebreakers).toEqual([7, 13, 2]);
  });

  it("detects two pair with kicker", () => {
    const h = ev5("Kc Kd 3h 3s Qd");
    expect(h.category).toBe(HandCategory.TwoPair);
    expect(h.tiebreakers).toEqual([13, 3, 12]);
  });

  it("detects one pair with kickers", () => {
    const h = ev5("Ac Ad 9h 5s 2d");
    expect(h.category).toBe(HandCategory.OnePair);
    expect(h.tiebreakers).toEqual([14, 9, 5, 2]);
  });

  it("detects high card", () => {
    const h = ev5("Ac Kd 9h 5s 2d");
    expect(h.category).toBe(HandCategory.HighCard);
    expect(h.tiebreakers).toEqual([14, 13, 9, 5, 2]);
  });
});

describe("category ordering (each beats the one below it)", () => {
  const ordered = [
    ev5("Ts Js Qs Ks As"), // straight flush
    ev5("9c 9d 9h 9s Kd"), // quads
    ev5("Qc Qd Qh 4s 4d"), // full house
    ev5("2h 5h 9h Jh Kh"), // flush
    ev5("5c 6d 7h 8s 9d"), // straight
    ev5("7c 7d 7h Kd 2s"), // trips
    ev5("Kc Kd 3h 3s Qd"), // two pair
    ev5("Ac Ad 9h 5s 2d"), // one pair
    ev5("Ac Kd 9h 5s 2d"), // high card
  ];

  it("ranks categories strictly descending", () => {
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareHandRank(ordered[i]!, ordered[i + 1]!)).toBeGreaterThan(0);
      expect(compareHandRank(ordered[i + 1]!, ordered[i]!)).toBeLessThan(0);
    }
  });
});

describe("within-category tiebreaks", () => {
  it("higher full house beats lower full house", () => {
    const aces = ev5("Ac Ad Ah 2s 2d");
    const kings = ev5("Kc Kd Kh Qs Qd");
    expect(compareHandRank(aces, kings)).toBeGreaterThan(0);
  });

  it("full house ties break on the trips first, then the pair", () => {
    const kkkAA = ev5("Kc Kd Kh Ac Ad");
    const kkkQQ = ev5("Ks Kh Kc Qc Qd");
    expect(compareHandRank(kkkAA, kkkQQ)).toBeGreaterThan(0);
  });

  it("flush ties break on the second-highest card", () => {
    const a = ev5("Ah Kh 7h 4h 2h");
    const b = ev5("Ah Qh Jh 9h 8h");
    expect(compareHandRank(a, b)).toBeGreaterThan(0);
  });

  it("one pair ties break on kickers in order", () => {
    const a = ev5("9c 9d Ah 5s 2d");
    const b = ev5("9h 9s Kh Qs Jd");
    expect(compareHandRank(a, b)).toBeGreaterThan(0);
  });

  it("recognises an exact tie (identical ranks, different suits)", () => {
    const a = ev5("Ac Kc 9d 5s 2h");
    const b = ev5("Ah Kd 9s 5c 2d");
    expect(compareHandRank(a, b)).toBe(0);
  });
});

describe("evaluateBest — best 5 of 7", () => {
  it("finds a flush hidden among 7 cards", () => {
    // 2 hole + 5 board; four hearts + one on board make a flush.
    const h = evN("Ah Kh  2h 7h 9h 3c 4s");
    expect(h.category).toBe(HandCategory.Flush);
    expect(h.tiebreakers[0]).toBe(14);
  });

  it("prefers a straight over a lower two pair from the same 7", () => {
    const h = evN("5h 6d  7s 8c 9h Ah Ad");
    expect(h.category).toBe(HandCategory.Straight);
    expect(h.tiebreakers).toEqual([9]);
  });

  it("uses the board when it is the best 5 (playing the board)", () => {
    // Board is a queen-high straight; hole cards are irrelevant.
    const h = evN("2c 3d  8h 9s Ts Jd Qc");
    expect(h.category).toBe(HandCategory.Straight);
    expect(h.tiebreakers).toEqual([12]);
  });

  it("finds quads using both hole cards and board", () => {
    const h = evN("As Ad  Ac Ah Kd 2s 3c");
    expect(h.category).toBe(HandCategory.FourOfAKind);
    expect(h.tiebreakers).toEqual([14, 13]);
  });
});
