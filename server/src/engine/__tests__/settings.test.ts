import { describe, it, expect } from "vitest";
import { GameEngine } from "../gameEngine.js";
import { mulberry32 } from "../rng.js";
import { Phase, PlayerStatus, type TableConfig } from "../types.js";

const CONFIG: Partial<TableConfig> = {
  maxSeats: 6,
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
  minPlayers: 2,
};

/** Sum of all chips on the table (stacks + everything committed to pots). */
function totalChips(engine: GameEngine): number {
  let sum = 0;
  for (const p of engine.state.seats) {
    if (p) sum += p.stack + p.handCommitted;
  }
  return sum;
}

/** Two players, both all-in preflop — the setup that triggers a runout. */
function shovedHeadsUp(opts?: { steppedRunout?: boolean }): GameEngine {
  const e = new GameEngine(CONFIG, mulberry32(7), opts);
  e.seatPlayer({ id: "a", name: "A", seatIndex: 0, buyIn: 100 });
  e.seatPlayer({ id: "b", name: "B", seatIndex: 1, buyIn: 100 });
  e.startHand();
  // Heads-up: the button (seat 0) is the small blind and acts first.
  e.applyAction("a", { type: "raise", amount: 100 });
  e.applyAction("b", { type: "call" });
  return e;
}

describe("all-in runout", () => {
  it("deals the whole board within the triggering action by default", () => {
    const e = shovedHeadsUp();
    expect(e.state.runoutPending).toBe(false);
    expect(e.state.phase).toBe(Phase.HandComplete);
    expect(e.state.board).toHaveLength(5);
  });

  it("parks after each street when stepped, so the caller can pace the reveal", () => {
    const e = shovedHeadsUp({ steppedRunout: true });

    // The call does NOT deal the board — the table gets to see the shove land
    // on an empty board first.
    expect(e.state.runoutPending).toBe(true);
    expect(e.state.phase).toBe(Phase.Preflop);
    expect(e.state.board).toHaveLength(0);
    expect(e.state.actingIndex).toBeNull();
    // Blinds are pulled in rather than left sitting in front of players for the
    // length of the runout.
    expect(e.collectedPot()).toBe(200);

    e.stepRunout();
    expect(e.state.phase).toBe(Phase.Flop);
    expect(e.state.board).toHaveLength(3);
    expect(e.state.runoutPending).toBe(true);

    e.stepRunout();
    expect(e.state.phase).toBe(Phase.Turn);
    expect(e.state.board).toHaveLength(4);

    e.stepRunout();
    expect(e.state.phase).toBe(Phase.River);
    expect(e.state.board).toHaveLength(5);
    expect(e.state.runoutPending).toBe(true);

    // Showdown is its own beat, so the reveal doesn't share a frame with the
    // river landing.
    e.stepRunout();
    expect(e.state.phase).toBe(Phase.HandComplete);
    expect(e.state.runoutPending).toBe(false);
    expect(e.state.lastResult).not.toBeNull();
    expect(totalChips(e)).toBe(200);

    e.stepRunout(); // late timer: harmless
    expect(e.state.phase).toBe(Phase.HandComplete);
  });

  it("reaches the same result stepped or not", () => {
    const fast = shovedHeadsUp();
    const stepped = shovedHeadsUp({ steppedRunout: true });
    while (stepped.state.runoutPending) stepped.stepRunout();

    expect(stepped.state.board).toEqual(fast.state.board);
    expect(stepped.state.lastResult).toEqual(fast.state.lastResult);
  });

  it("clears a pending runout when the hand ends early", () => {
    // One player covers the other, so they are still Active (not all-in) while
    // the board runs out — and can walk away mid-runout.
    const e = new GameEngine(CONFIG, mulberry32(3), { steppedRunout: true });
    e.seatPlayer({ id: "short", name: "S", seatIndex: 0, buyIn: 40 });
    e.seatPlayer({ id: "big", name: "B", seatIndex: 1, buyIn: 200 });
    e.startHand();
    e.applyAction("short", { type: "raise", amount: 40 }); // button/SB acts first
    e.applyAction("big", { type: "call" });
    expect(e.state.runoutPending).toBe(true);
    expect(e.state.seats[1]!.status).toBe(PlayerStatus.Active); // big still has chips

    e.removePlayer("big");
    expect(e.state.phase).toBe(Phase.HandComplete);
    expect(e.state.runoutPending).toBe(false);
    // A stale timer firing now must not try to deal from a finished hand.
    expect(() => e.stepRunout()).not.toThrow();
  });

  it("still pauses before showdown when the all-in happens on the river", () => {
    const e = new GameEngine(CONFIG, mulberry32(5), { steppedRunout: true });
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0, buyIn: 100 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1, buyIn: 100 });
    e.startHand();
    e.applyAction("a", { type: "call" });
    e.applyAction("b", { type: "check" });
    for (const _ of [Phase.Flop, Phase.Turn]) {
      e.applyAction("b", { type: "check" });
      e.applyAction("a", { type: "check" });
    }
    expect(e.state.phase).toBe(Phase.River);

    e.applyAction("b", { type: "bet", amount: 98 });
    e.applyAction("a", { type: "call" });
    expect(e.state.runoutPending).toBe(true);
    expect(e.state.phase).toBe(Phase.River);

    e.stepRunout();
    expect(e.state.phase).toBe(Phase.HandComplete);
  });

  it("does not treat an ordinary checked-down river as a runout", () => {
    const e = new GameEngine(CONFIG, mulberry32(9), { steppedRunout: true });
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1 });
    e.startHand();
    e.applyAction("a", { type: "call" });
    e.applyAction("b", { type: "check" });
    for (let street = 0; street < 3; street++) {
      e.applyAction("b", { type: "check" });
      e.applyAction("a", { type: "check" });
    }
    // Nobody was all-in, so the river closing goes straight to showdown.
    expect(e.state.runoutPending).toBe(false);
    expect(e.state.phase).toBe(Phase.HandComplete);
  });
});

describe("owner settings — config", () => {
  const seated = () => {
    const e = new GameEngine(CONFIG, mulberry32(2));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1 });
    return e;
  };

  it("applies new blinds between hands", () => {
    const e = seated();
    e.updateConfig({ smallBlind: 5, bigBlind: 10 });
    expect(e.state.config.smallBlind).toBe(5);
    expect(e.state.minRaiseSize).toBe(10);

    e.startHand();
    expect(e.state.seats[0]!.streetCommitted).toBe(5); // heads-up: button is SB
    expect(e.state.seats[1]!.streetCommitted).toBe(10);
    expect(e.state.currentBet).toBe(10);
  });

  it("refuses to change settings mid-hand", () => {
    const e = seated();
    e.startHand();
    expect(() => e.updateConfig({ bigBlind: 10 })).toThrow(/mid-hand/);
  });

  it("rejects blinds that don't make sense", () => {
    const e = seated();
    expect(() => e.updateConfig({ smallBlind: 10, bigBlind: 10 })).toThrow(/larger than/);
    expect(() => e.updateConfig({ smallBlind: 0 })).toThrow(/at least 1/);
    expect(() => e.updateConfig({ bigBlind: 2.5 })).toThrow(/whole number/);
    expect(() => e.updateConfig({ startingStack: 1, bigBlind: 2 })).toThrow(/big blind/);
    expect(() => e.updateConfig({ minPlayers: 1 })).toThrow(/2 players/);
    expect(() => e.updateConfig({ maxSeats: 12 })).toThrow(/between 2 and 10/);
    // Nothing partially applied.
    expect(e.state.config).toEqual({ ...CONFIG });
  });

  it("resizes the table and refuses to strand a seated player", () => {
    const e = seated();
    e.seatPlayer({ id: "c", name: "C", seatIndex: 4 });
    expect(() => e.updateConfig({ maxSeats: 4 })).toThrow(/Seat 4 must be empty/);

    e.removePlayer("c");
    e.updateConfig({ maxSeats: 4 });
    expect(e.state.seats).toHaveLength(4);
    expect(e.state.seats[0]!.id).toBe("a");
    expect(() => e.seatPlayer({ id: "d", name: "D", seatIndex: 4 })).toThrow(/out of range/);

    e.updateConfig({ maxSeats: 6 });
    expect(e.state.seats).toHaveLength(6);
    expect(e.state.seats[5]).toBeNull();
  });

  it("keeps dealing after the button's seat is cut from the table", () => {
    const e = seated();
    e.seatPlayer({ id: "c", name: "C", seatIndex: 5 });
    e.startHand();
    while (e.state.phase !== Phase.HandComplete) {
      const cur = e.legalActionsForCurrent()!;
      e.applyAction(cur.playerId, { type: "fold" });
    }
    e.removePlayer("c");
    // The button was somewhere in 0..5; shrinking must not leave it dangling.
    e.updateConfig({ maxSeats: 2 });
    expect(e.state.buttonIndex).toBeLessThan(2);
    expect(() => e.startHand()).not.toThrow();
  });
});

describe("owner settings — stacks", () => {
  const seated = () => {
    const e = new GameEngine(CONFIG, mulberry32(4));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1 });
    return e;
  };

  it("sets a stack between hands", () => {
    const e = seated();
    e.setStack("a", 500);
    expect(e.state.seats[0]!.stack).toBe(500);
    expect(totalChips(e)).toBe(700);
  });

  it("refuses to touch stacks mid-hand", () => {
    const e = seated();
    e.startHand();
    expect(() => e.setStack("a", 500)).toThrow(/mid-hand/);
  });

  it("rejects nonsense amounts and unknown players", () => {
    const e = seated();
    expect(() => e.setStack("a", -1)).toThrow(/0 or more/);
    expect(() => e.setStack("a", 10.5)).toThrow(/whole number/);
    expect(() => e.setStack("nobody", 10)).toThrow(/not seated/);
    expect(e.state.seats[0]!.stack).toBe(200);
  });

  it("revives a busted player topped back up, and benches one zeroed out", () => {
    const e = seated();
    e.setStack("a", 0);
    expect(e.state.seats[0]!.status).toBe(PlayerStatus.Busted);
    expect(e.canStartHand()).toBe(false); // only one player has chips

    e.setStack("a", 150);
    expect(e.state.seats[0]!.status).toBe(PlayerStatus.SittingOut);
    expect(e.canStartHand()).toBe(true);
    e.startHand();
    expect(e.state.seats[0]!.status).toBe(PlayerStatus.Active);
  });
});
