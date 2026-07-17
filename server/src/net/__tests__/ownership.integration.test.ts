import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket } from "socket.io-client";
import { createServer, type CreatedServer } from "../../server.js";
import type { RoomOptions } from "../room.js";
import { EVENTS, type Ack, type IdentifyResult, type PublicTableState } from "../protocol.js";

async function makeServer(
  opts: RoomOptions = {},
): Promise<{ server: CreatedServer; port: number; tableId: string }> {
  const server = createServer({ roomDefaults: opts, seedTables: [{ name: "Test Table" }] });
  await new Promise<void>((r) => server.httpServer.listen(0, r));
  const port = (server.httpServer.address() as AddressInfo).port;
  const tableId = server.tables.list()[0]!.tableId;
  return { server, port, tableId };
}

function shutdown(server: CreatedServer, ...socks: Socket[]): void {
  for (const s of socks) s.close();
  server.tables.disposeAll();
  server.io.close();
  server.httpServer.close();
}

/**
 * A socket plus a running log of every state it was pushed. The log matters:
 * identify broadcasts immediately, so a listener attached afterwards misses the
 * table's opening state and waits forever for a change that already happened.
 */
function watch(port: number) {
  const sock = ioClient(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true });
  const seen: PublicTableState[] = [];
  const waiters: Array<{
    pred: (s: PublicTableState) => boolean;
    resolve: (s: PublicTableState) => void;
  }> = [];

  sock.on(EVENTS.State, (s: PublicTableState) => {
    seen.push(s);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(s)) {
        waiters[i]!.resolve(s);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    sock,
    /** Board sizes across every state pushed, in order, deduped. */
    boardSteps: () => [...new Set(seen.map((s) => s.board.length))],
    identify(name: string, tableId: string): Promise<IdentifyResult> {
      return new Promise((resolve, reject) => {
        sock.emit(EVENTS.Identify, { name, tableId }, (res: IdentifyResult) =>
          res?.ok ? resolve(res) : reject(new Error("identify failed")),
        );
      });
    },
    send(event: string, payload: unknown): Promise<Ack> {
      return new Promise((resolve) => sock.emit(event, payload, (a: Ack) => resolve(a)));
    },
    /** Resolve with the first state — already seen or yet to arrive — matching. */
    until(pred: (s: PublicTableState) => boolean, timeoutMs = 4000): Promise<PublicTableState> {
      const already = seen.find(pred);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for state")), timeoutMs);
        waiters.push({
          pred,
          resolve: (s) => {
            clearTimeout(timer);
            resolve(s);
          },
        });
      });
    },
  };
}

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
      expect(a.boardSteps()).toEqual([0, 3, 4, 5]);
    } finally {
      shutdown(server, a.sock, b.sock);
    }
  }, 15_000);
});
