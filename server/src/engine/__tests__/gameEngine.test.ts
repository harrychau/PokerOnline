import { describe, it, expect, beforeEach } from "vitest";
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

describe("blind posting and positions", () => {
  it("posts SB/BB correctly and sets the first actor (3-handed)", () => {
    const e = new GameEngine(CONFIG, mulberry32(1));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1 });
    e.seatPlayer({ id: "c", name: "C", seatIndex: 2 });
    e.startHand();

    expect(e.state.phase).toBe(Phase.Preflop);
    expect(e.state.buttonIndex).toBe(0); // first eligible seat becomes button
    expect(e.state.seats[1]!.streetCommitted).toBe(1); // SB is left of button
    expect(e.state.seats[2]!.streetCommitted).toBe(2); // BB next
    expect(e.state.currentBet).toBe(2);
    // 3-handed: first to act preflop is left of BB — here the button (seat 0).
    expect(e.state.actingIndex).toBe(0);
    // Everyone dealt two hole cards.
    for (const p of e.state.seats) {
      if (p) expect(p.holeCards).toHaveLength(2);
    }
  });

  it("reverses the blinds heads-up: button posts the small blind and acts first", () => {
    const e = new GameEngine(CONFIG, mulberry32(2));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1 });
    e.startHand();

    expect(e.state.buttonIndex).toBe(0);
    // Heads-up: button (seat 0) is the SMALL blind and acts first preflop.
    expect(e.state.seats[0]!.streetCommitted).toBe(1);
    expect(e.state.seats[1]!.streetCommitted).toBe(2);
    expect(e.state.actingIndex).toBe(0);
  });
});

describe("a full uncontested hand (fold-out)", () => {
  it("awards the pot to the last remaining player when everyone folds", () => {
    const e = new GameEngine(CONFIG, mulberry32(3));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1 });
    e.seatPlayer({ id: "c", name: "C", seatIndex: 2 });
    const start = totalChips(e);
    e.startHand();

    // Preflop: button (a) folds, SB (b) folds → BB (c) wins uncontested.
    e.applyAction("a", { type: "fold" });
    e.applyAction("b", { type: "fold" });

    expect(e.state.phase).toBe(Phase.HandComplete);
    expect(e.state.lastResult!.potResults[0]!.uncontested).toBe(true);
    expect(e.state.lastResult!.potResults[0]!.winners[0]!.playerId).toBe("c");
    // c wins the 1 (SB) + its own 2 back = pot of 3; net +1 over the blind.
    expect(e.state.seats[2]!.stack).toBe(200 + 1);
    expect(totalChips(e)).toBe(start); // chips conserved
  });
});

describe("street transitions to showdown", () => {
  it("walks preflop → flop → turn → river → showdown with checks/calls", () => {
    const e = new GameEngine(CONFIG, mulberry32(7));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1 });
    const start = totalChips(e);
    e.startHand(); // heads-up: seat0 SB/button acts first

    // Preflop: SB completes, BB checks option.
    e.applyAction("a", { type: "call" }); // a to 2
    e.applyAction("b", { type: "check" });
    expect(e.state.phase).toBe(Phase.Flop);
    expect(e.state.board).toHaveLength(3);

    // Postflop first to act heads-up is the big blind (seat 1).
    expect(e.state.actingIndex).toBe(1);
    e.applyAction("b", { type: "check" });
    e.applyAction("a", { type: "check" });
    expect(e.state.phase).toBe(Phase.Turn);
    expect(e.state.board).toHaveLength(4);

    e.applyAction("b", { type: "check" });
    e.applyAction("a", { type: "check" });
    expect(e.state.phase).toBe(Phase.River);
    expect(e.state.board).toHaveLength(5);

    e.applyAction("b", { type: "check" });
    e.applyAction("a", { type: "check" });
    expect(e.state.phase).toBe(Phase.HandComplete);
    expect(e.state.lastResult!.potResults.length).toBeGreaterThan(0);
    expect(totalChips(e)).toBe(start); // chips conserved through showdown
  });
});

describe("all-in with side pots, end to end", () => {
  it("runs the board out and builds a main + side pot for three all-ins", () => {
    const e = new GameEngine(CONFIG, mulberry32(11));
    e.seatPlayer({ id: "short", name: "S", seatIndex: 0, buyIn: 40 });
    e.seatPlayer({ id: "mid", name: "M", seatIndex: 1, buyIn: 100 });
    e.seatPlayer({ id: "big", name: "B", seatIndex: 2, buyIn: 100 });
    const start = totalChips(e);
    expect(start).toBe(240);

    e.startHand(); // button seat0(short) SB? no — 3-handed. button=0.
    // button=short(0), SB=mid(1) posts 1, BB=big(2) posts 2. Actor = short(0).

    // short shoves 40 (all-in).
    e.applyAction("short", { type: "raise", amount: 40 });
    expect(e.state.seats[0]!.status).toBe(PlayerStatus.AllIn);
    // mid shoves 100 (all-in).
    e.applyAction("mid", { type: "raise", amount: 100 });
    expect(e.state.seats[1]!.status).toBe(PlayerStatus.AllIn);
    // big calls 100 (all-in).
    e.applyAction("big", { type: "call" });

    // All three all-in → board runs out, hand completes.
    expect(e.state.phase).toBe(Phase.HandComplete);
    expect(e.state.board).toHaveLength(5);

    const pots = e.state.lastResult!.potResults;
    // Main pot (all three eligible) + side pot (mid & big only).
    expect(pots.length).toBe(2);
    const totalAwarded = pots.reduce(
      (s, p) => s + p.winners.reduce((x, w) => x + w.amountWon, 0),
      0,
    );
    expect(totalAwarded).toBe(240);
    expect(totalChips(e)).toBe(start); // no chips created or destroyed
  });
});

describe("min-raise reopen rule (under-raise all-in)", () => {
  let e: GameEngine;
  beforeEach(() => {
    e = new GameEngine(CONFIG, mulberry32(5));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0, buyIn: 200 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1, buyIn: 200 });
    e.seatPlayer({ id: "c", name: "C", seatIndex: 2, buyIn: 13 }); // short BB
    e.startHand();
    // button=a(0), SB=b(1) posts 1, BB=c(2) posts 2. Actor = a(0).
  });

  it("does not reopen betting for a player who already acted", () => {
    e.applyAction("a", { type: "raise", amount: 10 }); // full raise (+8)
    e.applyAction("b", { type: "call" }); // b calls 10
    // c is all-in for 13: a +3 raise over 10, short of the +8 min-raise.
    e.applyAction("c", { type: "raise", amount: 13 });
    expect(e.state.seats[2]!.status).toBe(PlayerStatus.AllIn);

    // Action comes back to a. a already acted; the under-raise did NOT reopen
    // betting, so a may call or fold but must not be allowed to re-raise.
    expect(e.state.actingIndex).toBe(0);
    const legal = e.legalActionsForCurrent()!;
    expect(legal.playerId).toBe("a");
    expect(legal.actions.canRaise).toBe(false);
    expect(legal.actions.canCall).toBe(true);
    expect(() => e.applyAction("a", { type: "raise", amount: 30 })).toThrow();

    // Calling is fine and legal.
    expect(() => e.applyAction("a", { type: "call" })).not.toThrow();
  });

  it("DOES reopen betting when the all-in is a full raise", () => {
    e.applyAction("a", { type: "raise", amount: 10 }); // full raise
    // b re-raises to 30, a full +20 raise → reopens betting.
    e.applyAction("b", { type: "raise", amount: 30 });
    // c folds out of the way.
    e.applyAction("c", { type: "fold" });
    // Back to a, who now faces a full raise since last acting → can re-raise.
    expect(e.state.actingIndex).toBe(0);
    const legal = e.legalActionsForCurrent()!;
    expect(legal.actions.canRaise).toBe(true);
  });
});

describe("seating and busting", () => {
  it("refuses to start without enough players", () => {
    const e = new GameEngine(CONFIG, mulberry32(9));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
    expect(() => e.startHand()).toThrow(/at least/i);
  });

  it("rejects taking an occupied seat", () => {
    const e = new GameEngine(CONFIG, mulberry32(9));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
    expect(() => e.seatPlayer({ id: "b", name: "B", seatIndex: 0 })).toThrow(/taken/i);
  });

  it("rotates the button on the next hand", () => {
    const e = new GameEngine(CONFIG, mulberry32(4));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1 });
    e.seatPlayer({ id: "c", name: "C", seatIndex: 2 });
    e.startHand();
    const firstButton = e.state.buttonIndex;
    // Fold the hand out quickly.
    while (e.state.phase !== Phase.HandComplete) {
      const legal = e.legalActionsForCurrent();
      if (!legal) break;
      e.applyAction(legal.playerId, { type: "fold" });
    }
    e.startHand();
    expect(e.state.buttonIndex).not.toBe(firstButton);
  });
});

describe("uncalled bets are returned", () => {
  it("hands back a shove nobody could cover instead of routing it via a side pot", () => {
    const e = new GameEngine({ ...CONFIG, maxSeats: 3 }, mulberry32(4));
    e.seatPlayer({ id: "deep", name: "Deep", seatIndex: 0, buyIn: 200 });
    e.seatPlayer({ id: "short", name: "Short", seatIndex: 1, buyIn: 50 });
    e.startHand();

    // Heads-up: the button (seat 0) is the SB and acts first.
    e.applyAction("deep", { type: "raise", amount: 200 }); // shove
    e.applyAction("short", { type: "call" }); // can only cover 50

    // 150 of the shove was never called, so it goes straight back rather than
    // into a pot only "deep" could win.
    expect(e.state.phase).toBe(Phase.HandComplete);
    const potTotal = e.state.lastResult!.potResults.reduce((a, p) => a + p.amount, 0);
    expect(potTotal).toBe(100); // 50 each — the honest, contested amount
    expect(e.state.lastResult!.potResults).toHaveLength(1);
    expect(totalChips(e)).toBe(250);
  });

  it("returns the uncalled part of a raise that took the pot", () => {
    const e = new GameEngine({ ...CONFIG, maxSeats: 3 }, mulberry32(5));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0, buyIn: 200 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1, buyIn: 200 });
    e.startHand();

    e.applyAction("a", { type: "raise", amount: 100 });
    e.applyAction("b", { type: "fold" });

    // B put in the big blind (2) and gave up. A collects that, not 100.
    const result = e.state.lastResult!;
    expect(result.potResults[0]!.amount).toBe(4); // A's matched 2 + B's 2
    expect(result.potResults[0]!.winners[0]!.amountWon).toBe(4);
    expect(e.state.seats[0]!.stack).toBe(202); // A: +2, not +100
    expect(totalChips(e)).toBe(400);
  });

  it("leaves a matched all-in alone", () => {
    const e = new GameEngine({ ...CONFIG, maxSeats: 3 }, mulberry32(6));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0, buyIn: 100 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1, buyIn: 100 });
    e.startHand();

    e.applyAction("a", { type: "raise", amount: 100 });
    e.applyAction("b", { type: "call" });

    // Fully covered: nothing to give back, one pot of everything.
    const potTotal = e.state.lastResult!.potResults.reduce((a, p) => a + p.amount, 0);
    expect(potTotal).toBe(200);
    expect(totalChips(e)).toBe(200);
  });
});

describe("chips are conserved", () => {
  it("survives thousands of randomly-played hands without creating or losing a chip", () => {
    for (let seed = 0; seed < 400; seed++) {
      const r = mulberry32(seed);
      const rng = () => r.next();
      const e = new GameEngine({ ...CONFIG, maxSeats: 6 }, mulberry32(seed + 7));
      const nPlayers = 2 + Math.floor(rng() * 4);
      let total = 0;
      for (let i = 0; i < nPlayers; i++) {
        // Small stacks relative to the blinds keep all-ins frequent.
        const buyIn = 1 + Math.floor(rng() * 40);
        total += buyIn;
        e.seatPlayer({ id: `p${i}`, name: `P${i}`, seatIndex: i, buyIn });
      }

      for (let hand = 0; hand < 8 && e.canStartHand(); hand++) {
        e.startHand();
        let guard = 0;
        while (e.isHandInProgress() && guard++ < 400) {
          const cur = e.legalActionsForCurrent();
          if (!cur) break;
          const legal = e.legalActionsFor(e.state.actingIndex!);
          const roll = rng();
          if (roll < 0.15) e.applyAction(cur.playerId, { type: "fold" });
          else if (roll < 0.45 && legal.canCheck) e.applyAction(cur.playerId, { type: "check" });
          else if (roll < 0.7 && legal.canCall) e.applyAction(cur.playerId, { type: "call" });
          else if (legal.canBet || legal.canRaise) {
            const span = legal.maxBetTo - legal.minBetTo;
            const to = legal.minBetTo + Math.floor(rng() * (span + 1));
            e.applyAction(cur.playerId, { type: legal.canBet ? "bet" : "raise", amount: to });
          } else if (legal.canCheck) e.applyAction(cur.playerId, { type: "check" });
          else if (legal.canCall) e.applyAction(cur.playerId, { type: "call" });
          else e.applyAction(cur.playerId, { type: "fold" });
        }
        expect(totalChips(e), `seed ${seed}, hand ${hand}`).toBe(total);
      }
    }
  });
});

describe("leaving mid-hand", () => {
  it("lets a player leave cleanly once the hand has settled", () => {
    const e = new GameEngine({ ...CONFIG, maxSeats: 3 }, mulberry32(11));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0, buyIn: 100 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1, buyIn: 100 });
    e.startHand();

    e.applyAction("a", { type: "raise", amount: 100 });
    e.applyAction("b", { type: "call" });
    expect(e.state.phase).toBe(Phase.HandComplete);

    // The pot is already settled, so the seat can go immediately and A takes
    // whatever they ended the hand with.
    const aStack = e.state.seats[0]!.stack;
    e.removePlayer("a");
    expect(e.state.seats[0]).toBeNull();
    expect(totalChips(e)).toBe(200 - aStack);
  });

  it("holds the seat until the hand settles rather than deleting committed chips", () => {
    const e = new GameEngine({ ...CONFIG, maxSeats: 3 }, mulberry32(12));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0, buyIn: 100 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1, buyIn: 100 });
    e.seatPlayer({ id: "c", name: "C", seatIndex: 2, buyIn: 100 });
    e.startHand();

    e.applyAction("a", { type: "raise", amount: 20 });
    e.applyAction("b", { type: "call" });
    e.applyAction("c", { type: "call" });

    // B walks away with 20 already in the pot, mid-hand.
    e.removePlayer("b");
    expect(e.state.seats[1]).not.toBeNull(); // seat held, chips still in the pot
    expect(totalChips(e)).toBe(300);

    // Play the hand out; B's seat clears once it settles.
    let guard = 0;
    while (e.isHandInProgress() && guard++ < 100) {
      const cur = e.legalActionsForCurrent();
      if (!cur) break;
      const legal = e.legalActionsFor(e.state.actingIndex!);
      e.applyAction(cur.playerId, legal.canCheck ? { type: "check" } : { type: "fold" });
    }
    expect(e.state.phase).toBe(Phase.HandComplete);
    expect(e.state.seats[1]).toBeNull();
  });
});

describe("folding forfeits chips already bet", () => {
  it("does not refund the biggest bettor of the street once they have folded", () => {
    const e = new GameEngine({ ...CONFIG, maxSeats: 3 }, mulberry32(3));
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0, buyIn: 200 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1, buyIn: 200 });
    e.seatPlayer({ id: "c", name: "C", seatIndex: 2, buyIn: 200 });
    e.startHand();

    // A opens for 100 and then drops off the table. Room folds a disconnected
    // player when their grace expires, which lands out of turn and leaves the
    // street's biggest bettor folded.
    e.applyAction("a", { type: "raise", amount: 100 });
    e.forceFold("a");
    expect(e.state.seats[0]!.status).toBe(PlayerStatus.Folded);

    // B gives up as well, so C takes the pot unchallenged.
    e.applyAction("b", { type: "fold" });

    // A's 100 is forfeit and belongs to C. Handing back the uncalled 98 would
    // both rob C and make "bet big, then pull the plug" a way to keep chips.
    expect(e.state.seats[0]!.stack).toBe(100);
    expect(e.state.seats[2]!.stack).toBe(301); // 200 - 2 + (100 + 1 + 2)
    expect(e.state.lastResult!.potResults[0]!.amount).toBe(103);
    expect(totalChips(e)).toBe(600);
  });
});
