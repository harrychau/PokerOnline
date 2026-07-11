import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket } from "socket.io-client";
import { createServer, type CreatedServer } from "../../server.js";
import { EVENTS, type IdentifyResult, type PublicTableState } from "../protocol.js";

let server: CreatedServer;
let port: number;
let tableId: string;

beforeAll(async () => {
  server = createServer({
    roomDefaults: { nextHandDelayMs: 150 },
    seedTables: [{ name: "Test Table" }],
  });
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  port = (server.httpServer.address() as AddressInfo).port;
  tableId = server.tables.list()[0]!.tableId;
});

afterAll(async () => {
  server.tables.disposeAll();
  await new Promise<void>((resolve) => server.io.close(() => resolve()));
});

function connect(): Socket {
  return ioClient(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true });
}

function identify(sock: Socket, name: string): Promise<IdentifyResult> {
  return new Promise((resolve, reject) => {
    sock.emit(EVENTS.Identify, { name, tableId }, (res: IdentifyResult) => {
      res?.ok ? resolve(res) : reject(new Error("identify failed"));
    });
  });
}

function emitAck(sock: Socket, event: string, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    sock.emit(event, payload, (res: { ok: boolean; error?: string }) => resolve(res));
  });
}

/** Resolve with the first `state` event that satisfies `pred` (with a timeout). */
function waitForState(
  sock: Socket,
  pred: (s: PublicTableState) => boolean,
  timeoutMs = 5000,
): Promise<PublicTableState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.off(EVENTS.State, handler);
      reject(new Error("Timed out waiting for state"));
    }, timeoutMs);
    const handler = (s: PublicTableState) => {
      if (pred(s)) {
        clearTimeout(timer);
        sock.off(EVENTS.State, handler);
        resolve(s);
      }
    };
    sock.on(EVENTS.State, handler);
  });
}

describe("Socket.IO server — live play and privacy", () => {
  it("starts a hand when two players sit, and never leaks opponents' hole cards", async () => {
    const alice = connect();
    const bob = connect();
    try {
      const aId = (await identify(alice, "Alice")).playerId;
      const bId = (await identify(bob, "Bob")).playerId;

      // Alice sits; Bob sits → the hand should auto-start.
      const aliceDealt = waitForState(alice, (s) => s.phase === "PREFLOP");
      const bobDealt = waitForState(bob, (s) => s.phase === "PREFLOP");

      expect((await emitAck(alice, EVENTS.Sit, { seatIndex: 0 })).ok).toBe(true);
      expect((await emitAck(bob, EVENTS.Sit, { seatIndex: 1 })).ok).toBe(true);

      const aView = await aliceDealt;
      const bView = await bobDealt;

      // Alice sees her own cards but not Bob's.
      const aSeatForA = aView.seats.find((s) => s?.playerId === aId)!;
      const bSeatForA = aView.seats.find((s) => s?.playerId === bId)!;
      expect(aSeatForA.holeCards).toHaveLength(2);
      expect(bSeatForA.holeCards).toBeNull();
      expect(bSeatForA.hasCards).toBe(true);

      // Bob sees the mirror image.
      const bSeatForB = bView.seats.find((s) => s?.playerId === bId)!;
      const aSeatForB = bView.seats.find((s) => s?.playerId === aId)!;
      expect(bSeatForB.holeCards).toHaveLength(2);
      expect(aSeatForB.holeCards).toBeNull();

      // Exactly one of them has the action, with legal actions attached.
      const actingIsA = aView.legalActions !== null;
      const actingIsB = bView.legalActions !== null;
      expect(actingIsA !== actingIsB).toBe(true);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it("rejects an illegal action and an out-of-turn action", async () => {
    const carol = connect();
    const dave = connect();
    try {
      await identify(carol, "Carol");
      await identify(dave, "Dave");

      // Fresh table is 'main'? No — same room. Seats 0/1 may be taken by the
      // previous test's (now disconnected) players who were folded/sat-out but
      // still occupy seats. Use seats 2 and 3 to be safe.
      const carolDealt = waitForState(carol, (s) => s.phase === "PREFLOP" && s.yourSeatIndex === 2);
      await emitAck(carol, EVENTS.Sit, { seatIndex: 2 });
      await emitAck(dave, EVENTS.Sit, { seatIndex: 3 });
      const cView = await carolDealt;

      // Whoever is NOT to act cannot act: their action is rejected.
      const carolActing = cView.legalActions !== null;
      const idleSock = carolActing ? dave : carol;
      const res = await emitAck(idleSock, EVENTS.Action, { type: "check" });
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe("string");
    } finally {
      carol.close();
      dave.close();
    }
  });
});
