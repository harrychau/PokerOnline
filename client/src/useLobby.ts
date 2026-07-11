import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  EVENTS,
  type CreateTableResult,
  type ListTablesResult,
  type TableSummary,
} from "./protocol";

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ??
  (import.meta.env.DEV ? "http://localhost:3001" : undefined);

export interface UseLobby {
  connected: boolean;
  error: string | null;
  tables: TableSummary[];
  refresh: () => void;
  /** Resolves with the new table's id once the server confirms creation. */
  createTable: (name: string) => Promise<string>;
}

/**
 * A short-lived connection used only to browse/create tables before a player
 * has picked one to join. The Game view opens its own dedicated connection
 * (see useSocket) once a table is chosen.
 */
export function useLobby(): UseLobby {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tables, setTables] = useState<TableSummary[]>([]);

  const refresh = useCallback(() => {
    socketRef.current?.emit(EVENTS.ListTables, {}, (res: ListTablesResult) => {
      if (res?.ok) setTables(res.tables);
    });
  }, []);

  useEffect(() => {
    const socket = io(SERVER_URL, { autoConnect: true });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      refresh();
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (e: Error) => setError(`Connection failed: ${e.message}`));

    return () => {
      socket.removeAllListeners();
      socket.close();
    };
  }, [refresh]);

  const createTable = useCallback((name: string) => {
    return new Promise<string>((resolve, reject) => {
      socketRef.current?.emit(
        EVENTS.CreateTable,
        { name },
        (res: CreateTableResult | { ok: false; error: string }) => {
          if (res?.ok) resolve((res as CreateTableResult).tableId);
          else reject(new Error((res as { error: string })?.error ?? "Could not create table"));
        },
      );
    });
  }, []);

  return { connected, error, tables, refresh, createTable };
}
