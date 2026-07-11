/**
 * Express + Socket.IO server hosting any number of poker Rooms (tables),
 * managed by a TableManager.
 *
 * `createServer` is exported (rather than listening immediately) so tests can
 * spin the whole stack up on an ephemeral port. `index.ts` is the real entry
 * point that binds to a fixed port.
 */
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import express from "express";
import { Server as IOServer } from "socket.io";
import { TableManager, type TableManagerOptions } from "./net/tableManager.js";
import type { Room, RoomOptions } from "./net/room.js";
import {
  EVENTS,
  type Ack,
  type ActionPayload,
  type ChatPayload,
  type CreateTablePayload,
  type IdentifyPayload,
  type SitOutPayload,
  type SitPayload,
} from "./net/protocol.js";

export interface CreatedServer {
  httpServer: HttpServer;
  io: IOServer;
  tables: TableManager;
}

export interface ServerOptions {
  /** Applied to every table (turn timing, grace period, next-hand delay). */
  roomDefaults?: TableManagerOptions["defaults"];
  /** Tables to auto-create at boot, e.g. a default "Main Table". */
  seedTables?: Array<{ name: string; config?: RoomOptions["config"] }>;
}

export function createServer(opts: ServerOptions = {}): CreatedServer {
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // In production the same process serves the built React client, so players
  // open a single URL and the socket connects same-origin (no CORS split).
  // Falls back gracefully in dev/tests where no build exists.
  serveClient(app);

  const httpServer = createHttpServer(app);
  const io = new IOServer(httpServer, {
    // The React client (Phase 3) runs on a different dev-server origin, so allow
    // cross-origin sockets. Tighten this to a specific origin in production.
    cors: { origin: "*" },
  });

  const tables = new TableManager(io, { defaults: opts.roomDefaults });
  for (const seed of opts.seedTables ?? []) tables.create(seed);

  // Which table each connected socket is currently identified to.
  const socketTable = new Map<string, string>();

  io.on("connection", (socket) => {
    // A connected-but-unidentified socket can still browse/create tables; it
    // only joins a Room's roster once it identifies.

    socket.on(EVENTS.ListTables, (_payload: unknown, ack?: (r: unknown) => void) => {
      ack?.({ ok: true, tables: tables.list() });
    });

    socket.on(EVENTS.CreateTable, (payload: CreateTablePayload, ack?: (r: unknown) => void) => {
      try {
        const room = tables.create(payload ?? {});
        ack?.({ ok: true, tableId: room.tableId });
      } catch (err) {
        replyError(socket, ack, err);
      }
    });

    socket.on(EVENTS.Identify, (payload: IdentifyPayload, ack?: (r: unknown) => void) => {
      try {
        const room = tables.get(payload?.tableId);
        if (!room) throw new Error("That table no longer exists");
        const result = room.identify(socket.id, payload);
        socket.join(room.tableId); // scopes chat + the table-closed notice
        socketTable.set(socket.id, room.tableId);
        // Send recent chat history so a joiner/reconnecter sees the conversation.
        socket.emit(EVENTS.ChatHistory, room.chatHistory());
        ack?.(result);
      } catch (err) {
        replyError(socket, ack, err);
      }
    });

    socket.on(EVENTS.Sit, (payload: SitPayload, ack?: (r: Ack) => void) => {
      guarded(socket, ack, (room, playerId) => room.sit(playerId, payload));
    });

    socket.on(EVENTS.LeaveSeat, (_payload: unknown, ack?: (r: Ack) => void) => {
      guarded(socket, ack, (room, playerId) => room.leaveSeat(playerId));
    });

    socket.on(EVENTS.SitOut, (payload: SitOutPayload, ack?: (r: Ack) => void) => {
      guarded(socket, ack, (room, playerId) => room.setSitOut(playerId, !!payload?.sitOut));
    });

    socket.on(EVENTS.Action, (payload: ActionPayload, ack?: (r: Ack) => void) => {
      guarded(socket, ack, (room, playerId) => room.action(playerId, payload));
    });

    socket.on(EVENTS.Chat, (payload: ChatPayload, ack?: (r: Ack) => void) => {
      guarded(socket, ack, (room, playerId) => room.chat(playerId, payload?.text ?? ""));
    });

    // Anyone at a table can close it — there are no accounts to gate this on.
    socket.on(EVENTS.CloseTable, (_payload: unknown, ack?: (r: Ack) => void) => {
      guarded(socket, ack, (room) => {
        if (!tables.close(room.tableId)) throw new Error("Table already closed");
      });
    });

    socket.on("disconnect", () => {
      const tableId = socketTable.get(socket.id);
      socketTable.delete(socket.id);
      if (tableId) tables.get(tableId)?.disconnect(socket.id);
    });
  });

  return { httpServer, io, tables };

  /** Run a mutation on the socket's current table on behalf of its player. */
  function guarded(
    socket: { id: string; emit: (ev: string, ...a: unknown[]) => void },
    ack: ((r: Ack) => void) | undefined,
    fn: (room: Room, playerId: string) => void,
  ): void {
    const tableId = socketTable.get(socket.id);
    const room = tableId ? tables.get(tableId) : undefined;
    const playerId = room?.playerIdForSocket(socket.id);
    if (!room || !playerId) {
      const error = "Identify before acting";
      ack?.({ ok: false, error });
      socket.emit(EVENTS.ErrorMsg, { message: error });
      return;
    }
    try {
      fn(room, playerId);
      ack?.({ ok: true });
    } catch (err) {
      replyError(socket, ack, err);
    }
  }
}

/**
 * Serve the built React client (client/dist) as static files with a SPA
 * fallback, so one Node service hosts both API and UI on a single origin.
 * The directory only exists after `npm run build --workspace client`; when it's
 * absent (dev, tests) this is a no-op and the Vite dev server serves the UI.
 */
function serveClient(app: express.Express): void {
  const here = dirname(fileURLToPath(import.meta.url)); // server/dist
  const clientDist = process.env.CLIENT_DIST
    ? resolve(process.env.CLIENT_DIST)
    : resolve(here, "..", "..", "client", "dist");

  const indexHtml = join(clientDist, "index.html");
  if (!existsSync(indexHtml)) {
    console.log(`(client build not found at ${clientDist} — UI not served by this process)`);
    return;
  }

  app.use(express.static(clientDist));
  // SPA fallback: any non-asset, non-socket.io request returns index.html.
  // Registered last so it doesn't shadow /health or static assets; Socket.IO
  // intercepts its own /socket.io/ path before Express sees it.
  app.use((_req, res) => {
    res.sendFile(indexHtml);
  });
  console.log(`Serving client UI from ${clientDist}`);
}

function replyError(
  socket: { emit: (ev: string, ...a: unknown[]) => void },
  ack: ((r: any) => void) | undefined,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  ack?.({ ok: false, error: message });
  socket.emit(EVENTS.ErrorMsg, { message });
}
