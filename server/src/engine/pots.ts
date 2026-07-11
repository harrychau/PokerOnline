import type { Card } from "./cards.js";
import { compareHandRank, evaluateBest, type HandRank } from "./handEvaluator.js";
import type { Pot, PotResult } from "./types.js";

/**
 * Per-player input to pot construction. `contributed` is the total the player
 * put into the pot across the whole hand; `folded` players' chips still form
 * part of the pots but they are not eligible to win any pot.
 */
export interface Contribution {
  playerId: string;
  contributed: number;
  folded: boolean;
}

/**
 * Build the main pot and any side pots from each player's total contribution.
 *
 * The classic algorithm: sort the distinct contribution levels ascending. Each
 * level defines a pot layer. Every player who put in more than the previous
 * level contributes (level - previousLevel) to this layer — capped at what they
 * actually put in. A player is eligible to win a layer only if they were NOT
 * folded AND their contribution reached that layer's level.
 *
 * Example: stacks all-in for 100 / 100 / 40 (last one short).
 *   - Layer at 40: each of the 3 contributes 40 → 120 pot, all 3 eligible.
 *   - Layer at 100: the two deep players add 60 each → 120 pot, only they are
 *     eligible. The short all-in player cannot win chips beyond what he matched.
 */
export function buildPots(contributions: Contribution[]): Pot[] {
  const withChips = contributions.filter((c) => c.contributed > 0);
  if (withChips.length === 0) return [];

  const levels = [...new Set(withChips.map((c) => c.contributed))].sort((a, b) => a - b);

  const pots: Pot[] = [];
  let prevLevel = 0;
  for (const level of levels) {
    let amount = 0;
    const eligible: string[] = [];
    for (const c of withChips) {
      if (c.contributed > prevLevel) {
        // This player participates in this layer for the capped amount.
        amount += Math.min(c.contributed, level) - prevLevel;
      }
      // Eligible if they reached this level and did not fold.
      if (!c.folded && c.contributed >= level) {
        eligible.push(c.playerId);
      }
    }
    // Merge into the previous pot if the eligibility set is identical. This
    // keeps the pot list tidy (e.g. when a fold creates a level with no new
    // eligibility change) without affecting correctness of distribution.
    const prev = pots[pots.length - 1];
    if (prev && sameSet(prev.eligiblePlayerIds, eligible)) {
      prev.amount += amount;
    } else if (amount > 0) {
      pots.push({ amount, eligiblePlayerIds: eligible });
    }
    prevLevel = level;
  }

  return pots;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/**
 * Distribute a list of pots to their winners at showdown.
 *
 * @param pots            Pots from buildPots.
 * @param holeCardsById   Each still-in player's two hole cards.
 * @param board           The community cards (up to 5).
 * @param orderFromButton Player ids ordered by seat starting immediately
 *                        left of the button. Used to assign odd chips: when a
 *                        split leaves an indivisible remainder, the odd chip(s)
 *                        go to the earliest eligible player in this order
 *                        (standard "odd chip to first seat left of the button").
 */
export function distributePots(
  pots: Pot[],
  holeCardsById: Record<string, [Card, Card]>,
  board: Card[],
  orderFromButton: string[],
): { results: PotResult[]; payouts: Record<string, number> } {
  const payouts: Record<string, number> = {};
  const results: PotResult[] = [];

  // Cache each player's best hand once.
  const handById = new Map<string, HandRank>();
  const handFor = (id: string): HandRank => {
    let h = handById.get(id);
    if (!h) {
      const hole = holeCardsById[id]!;
      h = evaluateBest([...hole, ...board]);
      handById.set(id, h);
    }
    return h;
  };

  for (const pot of pots) {
    const contenders = pot.eligiblePlayerIds.filter((id) => holeCardsById[id]);
    if (contenders.length === 0) continue;

    // Find the best hand among contenders.
    let best: HandRank | null = null;
    let winners: string[] = [];
    for (const id of contenders) {
      const h = handFor(id);
      const cmp = best === null ? 1 : compareHandRank(h, best);
      if (cmp > 0) {
        best = h;
        winners = [id];
      } else if (cmp === 0) {
        winners.push(id);
      }
    }

    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;

    // Assign odd chips one at a time to winners in button order.
    const winnerSet = new Set(winners);
    const orderedWinners = orderFromButton.filter((id) => winnerSet.has(id));
    // Fallback: if orderFromButton is incomplete, use the winners list as-is.
    const oddChipOrder = orderedWinners.length === winners.length ? orderedWinners : winners;

    const perWinner: Record<string, number> = {};
    for (const id of winners) perWinner[id] = share;
    for (let i = 0; i < remainder; i++) {
      const id = oddChipOrder[i % oddChipOrder.length]!;
      perWinner[id] = (perWinner[id] ?? 0) + 1;
    }
    remainder = 0;

    for (const id of winners) {
      payouts[id] = (payouts[id] ?? 0) + perWinner[id]!;
    }

    results.push({
      amount: pot.amount,
      uncontested: false,
      winners: winners.map((id) => ({
        playerId: id,
        amountWon: perWinner[id]!,
        hand: handById.get(id) ?? null,
      })),
    });
  }

  return { results, payouts };
}
