/**
 * Shared harness for the socket-level integration tests. Not a test file itself
 * (vitest only collects *.test.ts).
 */
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket } from "socket.io-client";
import { createServer, type CreatedServer } from "../../server.js";
import type { RoomOptions } from "../room.js";
import { EVENTS, type Ack, type IdentifyResult, type PublicTableState } from "../protocol.js";

/** Spin up a fully isolated server on an ephemeral port with one seeded table. */
export async function makeServer(
  opts: RoomOptions = {},
): Promise<{ server: CreatedServer; port: number; tableId: string }> {
  const server = createServer({ roomDefaults: opts, seedTables: [{ name: "Test Table" }] });
  await new Promise<void>((r) => server.httpServer.listen(0, r));
  const port = (server.httpServer.address() as AddressInfo).port;
  const tableId = server.tables.list()[0]!.tableId;
  return { server, port, tableId };
}

/**
 * A server with no tables at all — what production actually boots as. Tables
 * only exist here once a player creates one, which is what makes the creator
 * their owner.
 */
export async function makeEmptyServer(
  opts: RoomOptions = {},
): Promise<{ server: CreatedServer; port: number }> {
  const server = createServer({ roomDefaults: opts });
  await new Promise<void>((r) => server.httpServer.listen(0, r));
  return { server, port: (server.httpServer.address() as AddressInfo).port };
}

/** Create a table the way the lobby does — from a socket that never identifies. */
export function createTable(sock: Socket, name?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sock.emit(EVENTS.CreateTable, { name }, (res: { ok: boolean; tableId?: string }) =>
      res?.ok && res.tableId ? resolve(res.tableId) : reject(new Error("createTable failed")),
    );
  });
}

export function shutdown(server: CreatedServer, ...socks: Socket[]): void {
  for (const s of socks) s.close();
  server.tables.disposeAll();
  server.io.close();
  server.httpServer.close();
}

export interface Watcher {
  sock: Socket;
  states: () => PublicTableState[];
  identify: (name: string, tableId: string) => Promise<IdentifyResult>;
  send: (event: string, payload: unknown) => Promise<Ack>;
  until: (pred: (s: PublicTableState) => boolean, timeoutMs?: number) => Promise<PublicTableState>;
}

/**
 * A socket plus a running log of every state it was pushed. The log matters:
 * identify broadcasts immediately, so a listener attached afterwards misses the
 * table's opening state and waits forever for a change that already happened.
 */
export function watch(port: number): Watcher {
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
    states: () => seen.slice(),
    identify(name, tableId) {
      return new Promise((resolve, reject) => {
        sock.emit(EVENTS.Identify, { name, tableId }, (res: IdentifyResult) =>
          res?.ok ? resolve(res) : reject(new Error("identify failed")),
        );
      });
    },
    send(event, payload) {
      return new Promise((resolve) => sock.emit(event, payload, (a: Ack) => resolve(a)));
    },
    /** Resolve with the first state — already seen or yet to arrive — matching. */
    until(pred, timeoutMs = 4000) {
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
