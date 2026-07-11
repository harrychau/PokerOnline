import { describe, it, expect } from "vitest";
import { computeLegalActions, validateAction, type BettingContext } from "../betting.js";
import { type Player, PlayerStatus } from "../types.js";

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: "p",
    name: "P",
    seatIndex: 0,
    stack: 200,
    holeCards: null,
    status: PlayerStatus.Active,
    streetCommitted: 0,
    handCommitted: 0,
    hasActedThisStreet: false,
    sitOutNextHand: false,
    ...overrides,
  };
}

const ctx = (over: Partial<BettingContext> = {}): BettingContext => ({
  currentBet: 0,
  minRaiseSize: 2,
  bigBlind: 2,
  ...over,
});

describe("computeLegalActions", () => {
  it("allows check and bet when there is no outstanding bet", () => {
    const a = computeLegalActions(makePlayer(), ctx());
    expect(a.canCheck).toBe(true);
    expect(a.canCall).toBe(false);
    expect(a.canBet).toBe(true);
    expect(a.canRaise).toBe(false);
    expect(a.minBetTo).toBe(2); // one big blind
  });

  it("requires a call and forbids check when facing a bet", () => {
    const p = makePlayer({ streetCommitted: 0 });
    const a = computeLegalActions(p, ctx({ currentBet: 10, minRaiseSize: 8 }));
    expect(a.canCheck).toBe(false);
    expect(a.canCall).toBe(true);
    expect(a.callAmount).toBe(10);
    expect(a.canRaise).toBe(true);
    expect(a.minBetTo).toBe(18); // currentBet + minRaise
  });

  it("caps the call at the player's stack (short stack)", () => {
    const p = makePlayer({ stack: 6 });
    const a = computeLegalActions(p, ctx({ currentBet: 10, minRaiseSize: 8 }));
    expect(a.callAmount).toBe(6);
    // Cannot make a full raise; min "raise to" collapses to the all-in amount.
    expect(a.maxBetTo).toBe(6);
    expect(a.minBetTo).toBe(6);
  });
});

describe("validateAction — checks and calls", () => {
  it("rejects a check when facing a bet", () => {
    const p = makePlayer();
    const r = validateAction(p, { type: "check" }, ctx({ currentBet: 10 }));
    expect(r.ok).toBe(false);
  });

  it("normalizes a call to the exact chips owed", () => {
    const p = makePlayer({ streetCommitted: 2 });
    const r = validateAction(p, { type: "call" }, ctx({ currentBet: 10, minRaiseSize: 8 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.chipsPutIn).toBe(8);
      expect(r.normalized.betTo).toBe(10);
      expect(r.normalized.allIn).toBe(false);
    }
  });

  it("marks a call that uses the whole stack as all-in", () => {
    const p = makePlayer({ stack: 8, streetCommitted: 2 });
    const r = validateAction(p, { type: "call" }, ctx({ currentBet: 20, minRaiseSize: 8 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.chipsPutIn).toBe(8); // all they have
      expect(r.normalized.allIn).toBe(true);
    }
  });
});

describe("validateAction — bets and raises", () => {
  it("accepts a minimum opening bet of one big blind", () => {
    const p = makePlayer();
    const r = validateAction(p, { type: "bet", amount: 2 }, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized.isFullRaise).toBe(true);
  });

  it("rejects an opening bet below one big blind", () => {
    const p = makePlayer();
    const r = validateAction(p, { type: "bet", amount: 1 }, ctx());
    expect(r.ok).toBe(false);
  });

  it("enforces the min-raise equals the previous raise size", () => {
    // currentBet 10, last raise size 8 → min raise to 18.
    const p = makePlayer();
    const under = validateAction(p, { type: "raise", amount: 15 }, ctx({ currentBet: 10, minRaiseSize: 8 }));
    expect(under.ok).toBe(false); // 15 is only a +5 raise, below +8

    const ok = validateAction(p, { type: "raise", amount: 18 }, ctx({ currentBet: 10, minRaiseSize: 8 }));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.normalized.isFullRaise).toBe(true);
      expect(ok.normalized.chipsPutIn).toBe(18);
    }
  });

  it("allows a short all-in raise below the min-raise, but flags it not-full", () => {
    // Stack only allows raising to 15 when a full raise would need 18.
    const p = makePlayer({ stack: 15 });
    const r = validateAction(p, { type: "raise", amount: 15 }, ctx({ currentBet: 10, minRaiseSize: 8 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized.allIn).toBe(true);
      expect(r.normalized.isFullRaise).toBe(false); // does not reopen betting
    }
  });

  it("rejects a raise that does not exceed the current bet", () => {
    const p = makePlayer();
    const r = validateAction(p, { type: "raise", amount: 10 }, ctx({ currentBet: 10, minRaiseSize: 8 }));
    expect(r.ok).toBe(false);
  });

  it("rejects a bet larger than the stack", () => {
    const p = makePlayer({ stack: 50 });
    const r = validateAction(p, { type: "bet", amount: 60 }, ctx());
    expect(r.ok).toBe(false);
  });

  it("rejects fractional chip amounts", () => {
    const p = makePlayer();
    const r = validateAction(p, { type: "bet", amount: 2.5 }, ctx());
    expect(r.ok).toBe(false);
  });
});
