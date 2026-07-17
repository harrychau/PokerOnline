import { describe, it, expect } from "vitest";
import { EVENTS } from "../protocol.js";
import { makeServer, shutdown, watch } from "./helpers.js";

const TURN_MS = 30_000;

/**
 * Seat two players heads-up and get to the big blind's preflop option.
 *
 * Heads-up the button IS the small blind and acts first, so after it calls, the
 * big blind is handed the option — and once they check, the flop's first actor
 * is the big blind again. That back-to-back pair of turns at one seat is the
 * case a seat-keyed clock cannot see.
 */
async function toBigBlindOption() {
  const ctx = await makeServer({
    turnTimeMs: TURN_MS,
    nextHandDelayMs: 60_000,
    config: { maxSeats: 6, smallBlind: 1, bigBlind: 2, startingStack: 200, minPlayers: 2 },
  });
  const sb = watch(ctx.port); // seat 0 — button/small blind heads-up
  const bb = watch(ctx.port); // seat 1 — big blind
  await sb.identify("SB", ctx.tableId);
  await bb.identify("BB", ctx.tableId);
  await sb.send(EVENTS.Sit, { seatIndex: 0 });
  await bb.send(EVENTS.Sit, { seatIndex: 1 });
  await sb.until((s) => s.phase === "PREFLOP");
  await sb.send(EVENTS.Action, { type: "call" });
  return { ...ctx, sb, bb };
}

describe("turn timer", () => {
  it("gives a fresh clock to the big blind's flop turn after their preflop option", async () => {
    const { server, sb, bb } = await toBigBlindOption();
    try {
      // The option: the big blind is acting preflop at seat 1.
      const option = await bb.until((s) => s.phase === "PREFLOP" && s.actingIndex === 1);
      expect(option.actingDeadline).not.toBeNull();

      await bb.send(EVENTS.Action, { type: "check" });

      // The flop hands the action straight back to the same seat. This is a new
      // turn and must get the full clock, not the remains of the option's.
      const flop = await bb.until((s) => s.phase === "FLOP" && s.actingIndex === 1);
      expect(flop.actingDeadline).not.toBeNull();
      expect(flop.actingDeadline!).toBeGreaterThan(option.actingDeadline!);

      // And it is a genuinely full turn, not merely a later one.
      const remaining = flop.actingDeadline! - Date.now();
      expect(remaining).toBeGreaterThan(TURN_MS - 3_000);
      expect(remaining).toBeLessThanOrEqual(TURN_MS);
    } finally {
      shutdown(server, sb.sock, bb.sock);
    }
  }, 15_000);

  it("does not restart the acting player's clock when someone chats or sits", async () => {
    const { server, port, sb, bb } = await toBigBlindOption();
    const spectator = watch(port);
    try {
      const option = await bb.until((s) => s.phase === "PREFLOP" && s.actingIndex === 1);
      const armed = option.actingDeadline!;

      // Unrelated table events must not hand the acting player a new clock.
      await sb.send(EVENTS.Chat, { text: "hurry up" });
      await spectator.identify("Rail", (await bb.until(() => true)).tableId);
      await spectator.send(EVENTS.Sit, { seatIndex: 3 });

      const later = await bb.until((s) => s.seats[3] !== null && s.actingIndex === 1);
      expect(later.actingDeadline).toBe(armed);
    } finally {
      shutdown(server, sb.sock, bb.sock, spectator.sock);
    }
  }, 15_000);

  it("times out the turn it was armed for, not a later one at the same seat", async () => {
    // Short clock: the big blind lets the option expire (auto-check), which
    // hands them the flop. The expired timer must not also fire on the flop.
    const ctx = await makeServer({
      turnTimeMs: 250,
      nextHandDelayMs: 60_000,
      config: { maxSeats: 6, smallBlind: 1, bigBlind: 2, startingStack: 200, minPlayers: 2 },
    });
    const sb = watch(ctx.port);
    const bb = watch(ctx.port);
    try {
      await sb.identify("SB", ctx.tableId);
      await bb.identify("BB", ctx.tableId);
      await sb.send(EVENTS.Sit, { seatIndex: 0 });
      await bb.send(EVENTS.Sit, { seatIndex: 1 });
      await sb.until((s) => s.phase === "PREFLOP");
      await sb.send(EVENTS.Action, { type: "call" });

      // Option expires → auto-check → flop. The flop's first actor is the BB,
      // whose fresh turn then expires too, auto-checking to the SB.
      const flop = await bb.until((s) => s.phase === "FLOP", 6000);
      expect(flop.board).toHaveLength(3);
      // Nobody was folded by a stale timer: both players are still in the hand.
      const live = flop.seats.filter((s) => s && s.status !== "FOLDED");
      expect(live).toHaveLength(2);
    } finally {
      shutdown(ctx.server, sb.sock, bb.sock);
    }
  }, 15_000);
});
