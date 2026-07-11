/**
 * Owns the set of live Rooms (one per table) so the server can host more than
 * one game at once. Anyone can create a table or close one — there are no user
 * accounts in this app, so "close" is intentionally unauthenticated, matching
 * the rest of the play-money, no-login design.
 */
import { randomUUID } from "node:crypto";
import type { Server as IOServer } from "socket.io";
import { Room, type RoomOptions } from "./room.js";
import { EVENTS, type TableSummary } from "./protocol.js";

export interface TableManagerOptions {
  /** Applied to every table unless overridden at creation time. */
  defaults?: Omit<RoomOptions, "tableId" | "name">;
}

export class TableManager {
  private io: IOServer;
  private rooms = new Map<string, Room>();
  private defaults: Omit<RoomOptions, "tableId" | "name">;

  constructor(io: IOServer, opts: TableManagerOptions = {}) {
    this.io = io;
    this.defaults = opts.defaults ?? {};
  }

  create(input: { name?: string; config?: RoomOptions["config"] } = {}): Room {
    const tableId = randomUUID();
    const name = (input.name ?? "").slice(0, 40).trim() || `Table ${this.rooms.size + 1}`;
    const room = new Room(this.io, {
      ...this.defaults,
      tableId,
      name,
      config: input.config ?? this.defaults.config,
    });
    this.rooms.set(tableId, room);
    return room;
  }

  get(tableId: string): Room | undefined {
    return this.rooms.get(tableId);
  }

  list(): TableSummary[] {
    return [...this.rooms.values()].map((r) => r.summary());
  }

  /** Tear a table down, notifying anyone still connected to it. */
  close(tableId: string): boolean {
    const room = this.rooms.get(tableId);
    if (!room) return false;
    this.io.to(tableId).emit(EVENTS.TableClosed, { tableId });
    this.io.socketsLeave(tableId);
    room.dispose();
    this.rooms.delete(tableId);
    return true;
  }

  disposeAll(): void {
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }
}
