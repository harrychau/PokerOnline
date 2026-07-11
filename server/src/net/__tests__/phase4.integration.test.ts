import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket } from "socket.io-client";
import { createServer, type CreatedServer } from "../../server.js";
import type { RoomOptions } from "../room.js";
import {
  EVENTS,
  type ChatMessage,
  type IdentifyResult,
  type PublicTableState,
} from "../protocol.js";

/** Spin up a fully isolated server (one seeded table) on an ephemeral port. */
async function makeServer(
  opts: RoomOptions,
): Promise<{ server: CreatedServer; port: number; tableId: string }> {
  const server = createServer({ roomDefaults: opts, seedTables: [{ name: "Test Table" }] });
  await new Promise<void>((r) => server.httpServer.listen(0, r));
  const port = (server.httpServer.address() as AddressInfo).port;
  const tableId = server.tables.list()[0]!.tableId;
  return { server, port, tableId };
}

function connect(port: number): Socket {
  return ioClient(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true });
}

function identify(
  sock: Socket,
  name: string,
  tableId: string,
  token?: string,
): Promise<IdentifyResult> {
  return new Promise((resolve, reject) => {
    sock.emit(EVENTS.Identify, { name, tableId, sessionToken: token }, (res: IdentifyResult) =>
      res?.ok ? resolve(res) : reject(new Error("identify failed")),
    );
  });
}

function ack(sock: Socket, event: string, payload: unknown): Promise<void> {
  return new Promise((resolve) => sock.emit(event, payload, () => resolve()));
}

function waitForState(
  sock: Socket,
  pred: (s: PublicTableState) => boolean,
  timeoutMs = 6000,
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

describe("Phase 4 — turn timers", () => {
  it("auto-acts (folds facing a bet) when a player times out", async () => {
    const { server, port, tableId } = await makeServer({
      turnTimeMs: 350,
      nextHandDelayMs: 60_000, // don't let a new hand start during the test
    });
    const a = connect(port);
    const b = connect(port);
    try {
      await identify(a, "Alice", tableId);
      await identify(b, "Bob", tableId);
      const dealt = waitForState(a, (s) => s.phase === "PREFLOP");
      await ack(a, EVENTS.Sit, { seatIndex: 0 });
      await ack(b, EVENTS.Sit, { seatIndex: 1 });
      const view = await dealt;

      // A deadline is advertised for the acting player.
      expect(view.actingDeadline).not.toBeNull();
      expect(view.turnTimeMs).toBe(350);

      // Nobody acts → the acting player (heads-up SB facing the BB) is folded on
      // timeout, ending the hand uncontested.
      const done = await waitForState(a, (s) => s.phase === "HAND_COMPLETE", 4000);
      expect(done.lastResult?.potResults[0]?.uncontested).toBe(true);
    } finally {
      a.close();
      b.close();
      server.tables.disposeAll();
      await new Promise<void>((r) => server.io.close(() => r()));
    }
  });
});

describe("Phase 4 — reconnection grace", () => {
  it("holds the seat on disconnect and restores it on reconnect with the token", async () => {
    const { server, port, tableId } = await makeServer({ turnTimeMs: 60_000, disconnectGraceMs: 60_000 });
    const a = connect(port);
    const b = connect(port);
    try {
      const aRes = await identify(a, "Alice", tableId);
      await identify(b, "Bob", tableId);
      await ack(a, EVENTS.Sit, { seatIndex: 0 });
      await ack(b, EVENTS.Sit, { seatIndex: 1 });

      // Alice drops. Within grace her seat is still occupied (marked offline).
      const offline = waitForState(b, (s) => s.seats[0]?.connected === false, 3000);
      a.close();
      const off = await offline;
      expect(off.seats[0]?.playerId).toBe(aRes.playerId); // seat still hers

      // Alice reconnects with her saved token → reclaims the same seat.
      const a2 = connect(port);
      try {
        const online = waitForState(b, (s) => s.seats[0]?.connected === true, 3000);
        const back = await identify(a2, "Alice", tableId, aRes.sessionToken);
        expect(back.playerId).toBe(aRes.playerId);
        const onlineState = await online;
        expect(onlineState.seats[0]?.playerId).toBe(aRes.playerId);
      } finally {
        a2.close();
      }
    } finally {
      b.close();
      server.tables.disposeAll();
      await new Promise<void>((r) => server.io.close(() => r()));
    }
  });

  it("sits the player out once the grace period expires", async () => {
    const { server, port, tableId } = await makeServer({
      turnTimeMs: 60_000,
      disconnectGraceMs: 300,
      nextHandDelayMs: 60_000,
    });
    const a = connect(port);
    const b = connect(port);
    try {
      await identify(a, "Alice", tableId);
      await identify(b, "Bob", tableId);
      await ack(a, EVENTS.Sit, { seatIndex: 0 });
      await ack(b, EVENTS.Sit, { seatIndex: 1 });

      const sittingOut = waitForState(
        b,
        (s) => s.seats[0]?.willSitOutNextHand === true,
        4000,
      );
      a.close();
      const out = await sittingOut;
      expect(out.seats[0]?.willSitOutNextHand).toBe(true);
    } finally {
      b.close();
      server.tables.disposeAll();
      await new Promise<void>((r) => server.io.close(() => r()));
    }
  });
});

describe("Phase 4 — chat", () => {
  it("broadcasts messages and serves history to new joiners", async () => {
    const { server, port, tableId } = await makeServer({});
    const a = connect(port);
    const b = connect(port);
    try {
      await identify(a, "Alice", tableId);
      await identify(b, "Bob", tableId);

      const gotByBob = new Promise<ChatMessage>((resolve) => {
        b.on(EVENTS.ChatMessage, (m: ChatMessage) => resolve(m));
      });
      await ack(a, EVENTS.Chat, { text: "  hi   there  " });
      const msg = await gotByBob;
      expect(msg.name).toBe("Alice");
      expect(msg.text).toBe("hi there"); // whitespace normalized

      // A late joiner receives the history on identify.
      const c = connect(port);
      try {
        const history = new Promise<ChatMessage[]>((resolve) => {
          c.on(EVENTS.ChatHistory, (h: ChatMessage[]) => resolve(h));
        });
        await identify(c, "Carol", tableId);
        const h = await history;
        expect(h.some((m) => m.text === "hi there")).toBe(true);
      } finally {
        c.close();
      }
    } finally {
      a.close();
      b.close();
      server.tables.disposeAll();
      await new Promise<void>((r) => server.io.close(() => r()));
    }
  });
});
