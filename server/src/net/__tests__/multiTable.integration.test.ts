import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket } from "socket.io-client";
import { createServer, type CreatedServer } from "../../server.js";
import {
  EVENTS,
  type CreateTableResult,
  type IdentifyResult,
  type ListTablesResult,
} from "../protocol.js";

let server: CreatedServer;
let port: number;

beforeAll(async () => {
  server = createServer({}); // no seeded tables — this suite creates its own
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  port = (server.httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  server.tables.disposeAll();
  await new Promise<void>((resolve) => server.io.close(() => resolve()));
});

function connect(): Socket {
  return ioClient(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true });
}

function emitAck<T>(sock: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => sock.emit(event, payload, (res: T) => resolve(res)));
}

function identify(sock: Socket, name: string, tableId: string): Promise<IdentifyResult> {
  return new Promise((resolve, reject) => {
    sock.emit(EVENTS.Identify, { name, tableId }, (res: IdentifyResult) =>
      res?.ok ? resolve(res) : reject(new Error("identify failed")),
    );
  });
}

describe("Multi-table lobby", () => {
  it("creates independent tables that anyone can list, join, and close", async () => {
    const alice = connect();
    const bob = connect();
    try {
      // Create two separate tables.
      const t1 = await emitAck<CreateTableResult>(alice, EVENTS.CreateTable, { name: "Table One" });
      const t2 = await emitAck<CreateTableResult>(bob, EVENTS.CreateTable, { name: "Table Two" });
      expect(t1.tableId).not.toBe(t2.tableId);

      // Both show up in the lobby listing.
      const listed = await emitAck<ListTablesResult>(alice, EVENTS.ListTables, {});
      const names = listed.tables.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["Table One", "Table Two"]));

      // Join each player to their own table.
      await identify(alice, "Alice", t1.tableId);
      await identify(bob, "Bob", t2.tableId);

      // Chat sent on table one must NOT be received by a player on table two.
      let leaked = false;
      bob.on(EVENTS.ChatMessage, () => {
        leaked = true;
      });
      const bobHeard = new Promise<void>((resolve) => setTimeout(resolve, 300));
      alice.emit(EVENTS.Chat, { text: "hello from table one" });
      await bobHeard;
      expect(leaked).toBe(false);

      // Closing table one notifies Alice and removes it from the lobby.
      const closedNotice = new Promise<{ tableId: string }>((resolve) => {
        alice.on(EVENTS.TableClosed, (msg: { tableId: string }) => resolve(msg));
      });
      await emitAck(alice, EVENTS.CloseTable, {});
      const notice = await closedNotice;
      expect(notice.tableId).toBe(t1.tableId);

      const afterClose = await emitAck<ListTablesResult>(bob, EVENTS.ListTables, {});
      expect(afterClose.tables.some((t) => t.tableId === t1.tableId)).toBe(false);
      expect(afterClose.tables.some((t) => t.tableId === t2.tableId)).toBe(true);
    } finally {
      alice.close();
      bob.close();
    }
  });
});
