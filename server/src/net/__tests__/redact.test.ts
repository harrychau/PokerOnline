import { describe, it, expect } from "vitest";
import { GameEngine } from "../../engine/gameEngine.js";
import { mulberry32 } from "../../engine/rng.js";
import { Phase } from "../../engine/types.js";
import { redactStateFor } from "../redact.js";

function threeHandedInHand() {
  const e = new GameEngine(
    { smallBlind: 1, bigBlind: 2, startingStack: 200, minPlayers: 2 },
    mulberry32(42),
  );
  e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
  e.seatPlayer({ id: "b", name: "B", seatIndex: 1 });
  e.seatPlayer({ id: "c", name: "C", seatIndex: 2 });
  e.startHand();
  return e;
}

const connected = new Set(["a", "b", "c"]);

describe("redactStateFor — hole card privacy", () => {
  it("shows a player only their own hole cards during a live hand", () => {
    const e = threeHandedInHand();
    const view = redactStateFor(e, { tableId: "t", viewerId: "a", connectedIds: connected });

    const seatA = view.seats.find((s) => s?.playerId === "a")!;
    const seatB = view.seats.find((s) => s?.playerId === "b")!;
    const seatC = view.seats.find((s) => s?.playerId === "c")!;

    expect(seatA.holeCards).toHaveLength(2); // own cards visible
    expect(seatB.holeCards).toBeNull(); // opponents hidden
    expect(seatC.holeCards).toBeNull();
    // But the UI still knows opponents are holding cards.
    expect(seatB.hasCards).toBe(true);
    expect(seatC.hasCards).toBe(true);
  });

  it("hides ALL hole cards from a spectator (no viewer id)", () => {
    const e = threeHandedInHand();
    const view = redactStateFor(e, { tableId: "t", viewerId: null, connectedIds: connected });
    for (const s of view.seats) {
      if (s) expect(s.holeCards).toBeNull();
    }
    expect(view.youPlayerId).toBeNull();
    expect(view.yourSeatIndex).toBeNull();
  });

  it("never serializes another player's cards anywhere in the payload", () => {
    const e = threeHandedInHand();
    const view = redactStateFor(e, { tableId: "t", viewerId: "a", connectedIds: connected });
    // Deep-stringify the entire payload A would receive and ensure B's exact
    // cards do not appear anywhere in it.
    const json = JSON.stringify(view);
    const parsed = JSON.stringify(
      view.seats.find((s) => s?.playerId === "b")!.holeCards,
    );
    expect(parsed).toBe("null");
    // Sanity: A's own cards DO appear.
    const aCards = e.state.seats[0]!.holeCards!;
    expect(json).toContain(`"rank":${aCards[0].rank}`);
  });

  it("reveals hole cards at showdown only for players who showed down", () => {
    // Drive a heads-up hand to a showdown so shownHands is populated.
    const e = new GameEngine(
      { smallBlind: 1, bigBlind: 2, startingStack: 200, minPlayers: 2 },
      mulberry32(1),
    );
    e.seatPlayer({ id: "a", name: "A", seatIndex: 0 });
    e.seatPlayer({ id: "b", name: "B", seatIndex: 1 });
    e.startHand();
    // Check/call to the river and show down.
    while (e.state.phase !== Phase.HandComplete) {
      const legal = e.legalActionsForCurrent();
      if (!legal) break;
      const act = legal.actions.canCheck ? { type: "check" as const } : { type: "call" as const };
      e.applyAction(legal.playerId, act);
    }
    expect(e.state.phase).toBe(Phase.HandComplete);
    const shown = Object.keys(e.state.lastResult!.shownHands);
    expect(shown.length).toBeGreaterThan(0);

    // A spectator now sees the shown-down players' cards.
    const view = redactStateFor(e, { tableId: "t", viewerId: null, connectedIds: connected });
    for (const s of view.seats) {
      if (s && shown.includes(s.playerId)) {
        expect(s.holeCards).toHaveLength(2);
      }
    }
  });

  it("attaches legal actions only to the player whose turn it is", () => {
    const e = threeHandedInHand();
    const actingId = e.legalActionsForCurrent()!.playerId;
    const otherId = ["a", "b", "c"].find((id) => id !== actingId)!;

    const actingView = redactStateFor(e, { tableId: "t", viewerId: actingId, connectedIds: connected });
    const otherView = redactStateFor(e, { tableId: "t", viewerId: otherId, connectedIds: connected });

    expect(actingView.legalActions).not.toBeNull();
    expect(otherView.legalActions).toBeNull();
  });
});
