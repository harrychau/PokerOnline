import { describe, it, expect } from "vitest";
import { cardsFromString } from "../cards.js";
import { buildPots, distributePots, type Contribution } from "../pots.js";

describe("buildPots — side pot construction", () => {
  it("makes a single pot when everyone contributed equally", () => {
    const contribs: Contribution[] = [
      { playerId: "a", contributed: 50, folded: false },
      { playerId: "b", contributed: 50, folded: false },
      { playerId: "c", contributed: 50, folded: false },
    ];
    const pots = buildPots(contribs);
    expect(pots).toHaveLength(1);
    expect(pots[0]!.amount).toBe(150);
    expect(new Set(pots[0]!.eligiblePlayerIds)).toEqual(new Set(["a", "b", "c"]));
  });

  it("creates a side pot when one player is all-in for less", () => {
    // a all-in 40, b and c call and keep betting to 100.
    const contribs: Contribution[] = [
      { playerId: "a", contributed: 40, folded: false },
      { playerId: "b", contributed: 100, folded: false },
      { playerId: "c", contributed: 100, folded: false },
    ];
    const pots = buildPots(contribs);
    expect(pots).toHaveLength(2);
    // Main pot: 40 from each of the three.
    expect(pots[0]!.amount).toBe(120);
    expect(new Set(pots[0]!.eligiblePlayerIds)).toEqual(new Set(["a", "b", "c"]));
    // Side pot: 60 more from b and c only.
    expect(pots[1]!.amount).toBe(120);
    expect(new Set(pots[1]!.eligiblePlayerIds)).toEqual(new Set(["b", "c"]));
  });

  it("handles three all-ins at different stack sizes (nested side pots)", () => {
    const contribs: Contribution[] = [
      { playerId: "short", contributed: 20, folded: false },
      { playerId: "mid", contributed: 60, folded: false },
      { playerId: "big", contributed: 100, folded: false },
    ];
    const pots = buildPots(contribs);
    expect(pots).toHaveLength(3);
    // Level 20: 20*3 = 60, all eligible.
    expect(pots[0]!.amount).toBe(60);
    expect(new Set(pots[0]!.eligiblePlayerIds)).toEqual(new Set(["short", "mid", "big"]));
    // Level 60: (60-20)*2 = 80, mid + big.
    expect(pots[1]!.amount).toBe(80);
    expect(new Set(pots[1]!.eligiblePlayerIds)).toEqual(new Set(["mid", "big"]));
    // Level 100: (100-60)*1 = 40, big only (uncalled portion returns to big).
    expect(pots[2]!.amount).toBe(40);
    expect(new Set(pots[2]!.eligiblePlayerIds)).toEqual(new Set(["big"]));
  });

  it("keeps a folded player's chips in the pot but not their eligibility", () => {
    // a bets 100 then folds; b and c all-in for 30 each. a's extra 70 forms a
    // side pot with no eligible player besides a... but a folded, so that
    // uncalled money should ideally return — here we assert folded players are
    // never eligible, and the main pot goes to b/c.
    const contribs: Contribution[] = [
      { playerId: "a", contributed: 100, folded: true },
      { playerId: "b", contributed: 30, folded: false },
      { playerId: "c", contributed: 30, folded: false },
    ];
    const pots = buildPots(contribs);
    // Main pot at level 30: 30*3 = 90, eligible b + c.
    expect(pots[0]!.amount).toBe(90);
    expect(new Set(pots[0]!.eligiblePlayerIds)).toEqual(new Set(["b", "c"]));
    // The remaining 70 from a alone has no non-folded eligible player.
    const orphan = pots.find((p) => p.eligiblePlayerIds.length === 0);
    expect(orphan?.amount).toBe(70);
  });
});

describe("distributePots — awarding chips", () => {
  const order = ["a", "b", "c"];

  it("awards the whole pot to the best hand", () => {
    const pots = buildPots([
      { playerId: "a", contributed: 50, folded: false },
      { playerId: "b", contributed: 50, folded: false },
    ]);
    const { payouts } = distributePots(
      pots,
      {
        a: cardsFromString("Ah Ad") as [any, any],
        b: cardsFromString("Kh Kd") as [any, any],
      },
      cardsFromString("2c 7d 9s Th Jc"),
      order,
    );
    expect(payouts["a"]).toBe(100); // aces beat kings
    expect(payouts["b"]).toBeUndefined();
  });

  it("splits a tied pot evenly", () => {
    const pots = buildPots([
      { playerId: "a", contributed: 50, folded: false },
      { playerId: "b", contributed: 50, folded: false },
    ]);
    // Both play the same straight on the board.
    const { payouts } = distributePots(
      pots,
      {
        a: cardsFromString("2c 3d") as [any, any],
        b: cardsFromString("2h 3s") as [any, any],
      },
      cardsFromString("8h 9s Ts Jd Qc"),
      order,
    );
    expect(payouts["a"]).toBe(50);
    expect(payouts["b"]).toBe(50);
  });

  it("gives the odd chip to the earliest player left of the button on a split", () => {
    const pots = buildPots([
      { playerId: "a", contributed: 25, folded: false },
      { playerId: "b", contributed: 25, folded: false },
    ]);
    // Pot is 50... make it odd: 51 total by uneven contributions but tie.
    pots[0]!.amount = 51;
    const { payouts } = distributePots(
      pots,
      {
        a: cardsFromString("2c 3d") as [any, any],
        b: cardsFromString("2h 3s") as [any, any],
      },
      cardsFromString("8h 9s Ts Jd Qc"),
      order, // "a" is earliest left of button
    );
    expect(payouts["a"]).toBe(26); // gets the odd chip
    expect(payouts["b"]).toBe(25);
  });

  it("distributes main and side pots to the right eligible players", () => {
    // short all-in 40 with the best hand wins only the main pot; big wins side.
    const pots = buildPots([
      { playerId: "short", contributed: 40, folded: false },
      { playerId: "big1", contributed: 100, folded: false },
      { playerId: "big2", contributed: 100, folded: false },
    ]);
    const { payouts } = distributePots(
      pots,
      {
        short: cardsFromString("Ah As") as [any, any], // trip aces
        big1: cardsFromString("Kh Kd") as [any, any], // trip kings
        big2: cardsFromString("Qh Qd") as [any, any], // trip queens
      },
      cardsFromString("Ac Kc 2d 7h 9s"),
      ["short", "big1", "big2"],
    );
    // Main pot 120 → short (best hand overall).
    // Side pot 120 → big1 (kings beat queens); short not eligible.
    expect(payouts["short"]).toBe(120);
    expect(payouts["big1"]).toBe(120);
    expect(payouts["big2"]).toBeUndefined();
  });

  it("conserves chips: total paid equals total contributed (contested pots)", () => {
    const contribs: Contribution[] = [
      { playerId: "a", contributed: 33, folded: false },
      { playerId: "b", contributed: 33, folded: false },
      { playerId: "c", contributed: 100, folded: false },
    ];
    const pots = buildPots(contribs);
    const { payouts } = distributePots(
      pots,
      {
        a: cardsFromString("Ah As") as [any, any],
        b: cardsFromString("Kh Ks") as [any, any],
        c: cardsFromString("2h 2s") as [any, any],
      },
      cardsFromString("Ac Kd Qh Js 9c"),
      ["a", "b", "c"],
    );
    const totalPaid = Object.values(payouts).reduce((x, y) => x + y, 0);
    // Note: the uncalled 67 from c beyond what a matched is a side pot c wins.
    const totalContributed = 33 + 33 + 100;
    expect(totalPaid).toBe(totalContributed);
  });
});

describe("pot layers nobody is eligible for", () => {
  // Two players build a side pot over the top of a short all-in and then both
  // fold it away. The layer reaches showdown with an empty eligible set; the
  // chips still have to go somewhere.
  const contribs: Contribution[] = [
    { playerId: "short", contributed: 29, folded: false, foldOrder: null },
    { playerId: "first", contributed: 106, folded: true, foldOrder: 0 },
    { playerId: "last", contributed: 106, folded: true, foldOrder: 1 },
  ];

  it("records the contributors of a layer, not just who can win it", () => {
    const pots = buildPots(contribs);
    const orphan = pots.find((p) => p.eligiblePlayerIds.length === 0)!;
    expect(orphan).toBeDefined();
    expect(orphan.amount).toBe(154); // (106 - 29) * 2
    expect(new Set(orphan.contributorIds)).toEqual(new Set(["first", "last"]));
  });

  it("awards it to the last of them to fold rather than dropping the chips", () => {
    const pots = buildPots(contribs);
    const board = cardsFromString("2c 7d 9h Jd Ks");
    const { results, payouts } = distributePots(
      pots,
      { short: cardsFromString("As Ad") as [never, never] },
      board,
      ["short"],
      { first: 0, last: 1 },
    );

    // Every chip contributed is still accounted for.
    const paid = Object.values(payouts).reduce((a, b) => a + b, 0);
    expect(paid).toBe(29 * 3 + 77 * 2);

    // "last" folded after "first", so the side pot was already theirs.
    expect(payouts["last"]).toBe(154);
    expect(payouts["first"]).toBeUndefined();
    expect(payouts["short"]).toBe(87); // main pot, 29 from each of the three

    // A pot won because everyone else folded is not a showdown win.
    const orphanResult = results.find((r) => r.amount === 154)!;
    expect(orphanResult.uncontested).toBe(true);
    expect(orphanResult.winners[0]!.hand).toBeNull();
  });
});
