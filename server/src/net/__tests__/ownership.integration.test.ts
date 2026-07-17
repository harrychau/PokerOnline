import { describe, it, expect } from "vitest";
import { EVENTS } from "../protocol.js";
import { createTable, makeEmptyServer, makeServer, shutdown, watch } from "./helpers.js";
describe("table ownership — one owner per table", () => {
  it("boots with no tables at all, so no table exists that nobody created", async () => {
    const { server } = await makeEmptyServer();
    try {
      expect(server.tables.list()).toEqual([]);
    } finally {
      shutdown(server);
    }
  });

  it("makes the player who created a table its owner", async () => {
    const { server, port } = await makeEmptyServer();
    // The lobby creates from a socket that never identifies, then the game
    // connects on a fresh one — mirroring how the real client does it.
    const lobby = watch(port);
    const creator = watch(port);
    const other = watch(port);
    try {
      const tableId = await createTable(lobby.sock, "Harry's table");
      const c = await creator.identify("Creator", tableId);
      const o = await other.identify("Other", tableId);

      expect((await creator.until((s) => s.youPlayerId === c.playerId)).youAreOwner).toBe(true);
      const asOther = await other.until((s) => s.youPlayerId === o.playerId);
      expect(asOther.youAreOwner).toBe(false);
      expect(asOther.ownerPlayerId).toBe(c.playerId);
    } finally {
      shutdown(server, lobby.sock, creator.sock, other.sock);
    }
  }, 15_000);

  it("names exactly one owner however many players are at the table", async () => {
    const { server, port } = await makeEmptyServer();
    const lobby = watch(port);
    const players = [watch(port), watch(port), watch(port), watch(port)];
    try {
      const tableId = await createTable(lobby.sock, "Six max");
      const ids: string[] = [];
      for (const p of players) ids.push((await p.identify("P", tableId)).playerId);

      // Every player's own view, and every view's idea of who the owner is.
      const views = await Promise.all(
        players.map((p, i) => p.until((s) => s.youPlayerId === ids[i])),
      );
      expect(views.filter((v) => v.youAreOwner)).toHaveLength(1);
      expect(new Set(views.map((v) => v.ownerPlayerId)).size).toBe(1);
      expect(views[0]!.ownerPlayerId).toBe(ids[0]); // the creator
    } finally {
      shutdown(server, lobby.sock, ...players.map((p) => p.sock));
    }
  }, 15_000);

  it("keeps owners separate across two tables", async () => {
    const { server, port } = await makeEmptyServer();
    const lobby = watch(port);
    const a = watch(port);
    const b = watch(port);
    try {
      const tableA = await createTable(lobby.sock, "A");
      const tableB = await createTable(lobby.sock, "B");
      const ida = await a.identify("A", tableA);
      const idb = await b.identify("B", tableB);

      const viewA = await a.until((s) => s.tableId === tableA);
      const viewB = await b.until((s) => s.tableId === tableB);
      expect(viewA.youAreOwner).toBe(true);
      expect(viewB.youAreOwner).toBe(true);
      // Each owns their own table only — not one owner across the server.
      expect(viewA.ownerPlayerId).toBe(ida.playerId);
      expect(viewB.ownerPlayerId).toBe(idb.playerId);
      expect(ida.playerId).not.toBe(idb.playerId);
    } finally {
      shutdown(server, lobby.sock, a.sock, b.sock);
    }
  }, 15_000);
});

describe("table ownership", () => {
  it("gives the table to the first arrival and lets only them change settings", async () => {
    const { server, port, tableId } = await makeServer({ nextHandDelayMs: 60_000 });
    const owner = watch(port);
    const guest = watch(port);
    try {
      const o = await owner.identify("Owner", tableId);
      await guest.identify("Guest", tableId);

      const asOwner = await owner.until((s) => s.youPlayerId === o.playerId);
      expect(asOwner.youAreOwner).toBe(true);
      expect(asOwner.ownerPlayerId).toBe(o.playerId);

      const asGuest = await guest.until((s) => s.ownerPlayerId !== null);
      expect(asGuest.youAreOwner).toBe(false);
      expect(asGuest.ownerPlayerId).toBe(o.playerId);

      // The guest is refused, and the table is left exactly as it was.
      const denied = await guest.send(EVENTS.UpdateSettings, { config: { bigBlind: 50 } });
      expect(denied).toEqual({ ok: false, error: "Only the table owner can change settings" });

      const ok = await owner.send(EVENTS.UpdateSettings, { config: { smallBlind: 5, bigBlind: 10 } });
      expect(ok.ok).toBe(true);

      const after = await owner.until((s) => s.config.bigBlind === 10);
      expect(after.config.smallBlind).toBe(5);
    } finally {
      shutdown(server, owner.sock, guest.sock);
    }
  }, 15_000);

  it("rejects nonsense settings with a readable message", async () => {
    const { server, port, tableId } = await makeServer();
    const owner = watch(port);
    try {
      await owner.identify("Owner", tableId);
      const res = await owner.send(EVENTS.UpdateSettings, {
        config: { smallBlind: 10, bigBlind: 10 },
      });
      expect(res).toEqual({ ok: false, error: "Big blind must be larger than the small blind" });
    } finally {
      shutdown(server, owner.sock);
    }
  }, 15_000);

  it("applies nothing at all when one field of a change is bad", async () => {
    const { server, port, tableId } = await makeServer({ turnTimeMs: 20_000 });
    const owner = watch(port);
    try {
      await owner.identify("Owner", tableId);
      const before = await owner.until((s) => s.turnTimeMs > 0);
      expect(before.turnTimeMs).toBe(20_000);

      // A valid turn time riding along with a bad blind must not sneak through.
      const res = await owner.send(EVENTS.UpdateSettings, {
        turnTimeMs: 45_000,
        config: { smallBlind: 10, bigBlind: 10 },
      });
      expect(res.ok).toBe(false);

      const after = await owner.send(EVENTS.ListTables, {});
      expect(after).toBeTruthy(); // round-trip to let any broadcast land
      expect(server.tables.get(tableId)!.stateFor(null).turnTimeMs).toBe(20_000);
    } finally {
      shutdown(server, owner.sock);
    }
  }, 15_000);

  it("holds a mid-hand change until the hand ends, then applies it", async () => {
    const { server, port, tableId } = await makeServer({
      nextHandDelayMs: 60_000, // leave the table parked on HAND_COMPLETE
      turnTimeMs: 60_000,
    });
    const owner = watch(port);
    const guest = watch(port);
    try {
      const o = await owner.identify("Owner", tableId);
      await guest.identify("Guest", tableId);
      await owner.send(EVENTS.Sit, { seatIndex: 0 });
      await guest.send(EVENTS.Sit, { seatIndex: 1 });
      await owner.until((s) => s.phase === "PREFLOP");

      const res = await owner.send(EVENTS.UpdateSettings, {
        config: { smallBlind: 5, bigBlind: 10 },
        stacks: { [o.playerId]: 999 },
      });
      expect(res.ok).toBe(true);

      // Held: a live hand's blinds and stacks are what its pot is built from.
      const held = await owner.until((s) => s.settingsPending);
      expect(held.phase).toBe("PREFLOP");
      expect(held.config.bigBlind).toBe(2);

      // Fold the hand out; the change should land as it completes.
      const actor = held.seats.find((s) => s?.isActing)!.playerId === o.playerId ? owner : guest;
      await actor.send(EVENTS.Action, { type: "fold" });

      const done = await owner.until((s) => s.phase === "HAND_COMPLETE");
      expect(done.config.bigBlind).toBe(10);
      expect(done.config.smallBlind).toBe(5);
      expect(done.seats[0]!.stack).toBe(999);
      expect(done.settingsPending).toBe(false);
    } finally {
      shutdown(server, owner.sock, guest.sock);
    }
  }, 15_000);

  it("hands the table on once a departed owner's grace expires", async () => {
    const { server, port, tableId } = await makeServer({ disconnectGraceMs: 120 });
    const owner = watch(port);
    const guest = watch(port);
    try {
      await owner.identify("Owner", tableId);
      const g = await guest.identify("Guest", tableId);
      await guest.until((s) => s.ownerPlayerId !== null);

      owner.sock.close();
      const handed = await guest.until((s) => s.ownerPlayerId === g.playerId);
      expect(handed.youAreOwner).toBe(true);

      expect((await guest.send(EVENTS.UpdateSettings, { config: { bigBlind: 20 } })).ok).toBe(true);
    } finally {
      shutdown(server, owner.sock, guest.sock);
    }
  }, 15_000);
});

describe("all-in runout pacing", () => {
  it("deals the board one street at a time instead of all at once", async () => {
    const { server, port, tableId } = await makeServer({
      nextHandDelayMs: 60_000,
      turnTimeMs: 60_000,
      runoutRevealMs: 60,
      config: { startingStack: 100, smallBlind: 1, bigBlind: 2, maxSeats: 6, minPlayers: 2 },
    });
    const a = watch(port);
    const b = watch(port);
    try {
      await a.identify("A", tableId);
      await b.identify("B", tableId);
      await a.send(EVENTS.Sit, { seatIndex: 0 });
      await b.send(EVENTS.Sit, { seatIndex: 1 });
      await a.until((s) => s.phase === "PREFLOP");

      await a.send(EVENTS.Action, { type: "raise", amount: 100 }); // button/SB shoves
      await b.send(EVENTS.Action, { type: "call" });

      const done = await a.until((s) => s.phase === "HAND_COMPLETE");
      expect(done.board).toHaveLength(5);

      // Every street got its own broadcast: an unpaced runout would jump 0 → 5.
      expect([...new Set(a.states().map((s) => s.board.length))]).toEqual([0, 3, 4, 5]);
    } finally {
      shutdown(server, a.sock, b.sock);
    }
  }, 15_000);
});
