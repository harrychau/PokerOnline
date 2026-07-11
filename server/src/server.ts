/**
 * Express + Socket.IO server hosting a single poker Room (Phase 2).
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
import { Room, type RoomOptions } from "./net/room.js";
import {
  EVENTS,
  type Ack,
  type ActionPayload,
  type ChatPayload,
  type IdentifyPayload,
  type SitOutPayload,
  type SitPayload,
} from "./net/protocol.js";

export interface CreatedServer {
  httpServer: HttpServer;
  io: IOServer;
  room: Room;
}

export function createServer(roomOpts: RoomOptions = {}): CreatedServer {
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

  const room = new Room(io, roomOpts);

  io.on("connection", (socket) => {
    // A connected-but-unidentified socket is already a spectator; it will
    // receive redacted state once it identifies (or another event triggers a
    // broadcast).

    socket.on(EVENTS.Identify, (payload: IdentifyPayload, ack?: (r: unknown) => void) => {
      try {
        const result = room.identify(socket.id, payload);
        // Send recent chat history so a joiner/reconnecter sees the conversation.
        socket.emit(EVENTS.ChatHistory, room.chatHistory());
        ack?.(result);
      } catch (err) {
        replyError(socket, ack, err);
      }
    });

    socket.on(EVENTS.Sit, (payload: SitPayload, ack?: (r: Ack) => void) => {
      guarded(socket, ack, (playerId) => room.sit(playerId, payload));
    });

    socket.on(EVENTS.LeaveSeat, (_payload: unknown, ack?: (r: Ack) => void) => {
      guarded(socket, ack, (playerId) => room.leaveSeat(playerId));
    });

    socket.on(EVENTS.SitOut, (payload: SitOutPayload, ack?: (r: Ack) => void) => {
      guarded(socket, ack, (playerId) => room.setSitOut(playerId, !!payload?.sitOut));
    });

    socket.on(EVENTS.Action, (payload: ActionPayload, ack?: (r: Ack) => void) => {
      guarded(socket, ack, (playerId) => room.action(playerId, payload));
    });

    socket.on(EVENTS.Chat, (payload: ChatPayload, ack?: (r: Ack) => void) => {
      guarded(socket, ack, (playerId) => room.chat(playerId, payload?.text ?? ""));
    });

    socket.on("disconnect", () => {
      room.disconnect(socket.id);
    });
  });

  return { httpServer, io, room };

  /** Run a room mutation on behalf of the socket's player, reporting errors. */
  function guarded(
    socket: { id: string; emit: (ev: string, ...a: unknown[]) => void },
    ack: ((r: Ack) => void) | undefined,
    fn: (playerId: string) => void,
  ): void {
    const playerId = room.playerIdForSocket(socket.id);
    if (!playerId) {
      const error = "Identify before acting";
      ack?.({ ok: false, error });
      socket.emit(EVENTS.ErrorMsg, { message: error });
      return;
    }
    try {
      fn(playerId);
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
