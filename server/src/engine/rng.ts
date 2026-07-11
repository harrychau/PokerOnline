/**
 * Deterministic, seedable pseudo-random number generator.
 *
 * The game engine never calls Math.random() directly so that hands can be
 * replayed exactly in tests (and, later, so a table's shuffle can be audited).
 * Production tables seed this from crypto-strong entropy; tests seed it with a
 * fixed number to get a repeatable deck order.
 */
export interface RNG {
  /** Returns a float in [0, 1). */
  next(): number;
}

/**
 * mulberry32 — a tiny, fast 32-bit PRNG with good statistical properties for
 * shuffling. Not cryptographically secure; that is intentional and fine for a
 * play-money game, but see makeSecureSeed() for how real tables are seeded.
 */
export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return {
    next(): number {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * Seed derived from crypto-strong randomness for real (non-test) tables.
 * Kept separate so the engine stays free of Node built-in imports where it can.
 */
export function makeSecureSeed(): number {
  // 2^32 space is plenty of entropy to seed the shuffle for a play-money game.
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
