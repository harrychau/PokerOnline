import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  EVENTS,
  type Ack,
  type ActionPayload,
  type ChatMessage,
  type IdentifyResult,
  type PublicTableState,
  type UpdateSettingsPayload,
} from "./protocol";

// In a production build the client is served by the same Node process as the
// socket server, so connect same-origin (SERVER_URL undefined → socket.io uses
// window.location). In dev the Vite server is a separate origin, so fall back to
// the local server port. Override either with VITE_SERVER_URL.
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ??
  (import.meta.env.DEV ? "http://localhost:3001" : undefined);
// Session tokens are scoped per table — a token from one table is meaningless
// (and rejected) at another, so each gets its own localStorage entry.
const tokenKey = (tableId: string) => `poker.sessionToken.${tableId}`;

export interface UseSocket {
  connected: boolean;
  state: PublicTableState | null;
  error: string | null;
  chat: ChatMessage[];
  /** True once this table has been closed (by anyone); the UI should return to the lobby. */
  closed: boolean;
  sit: (seatIndex: number, buyIn?: number) => void;
  leave: () => void;
  sitOut: (v: boolean) => void;
  act: (payload: ActionPayload) => void;
  sendChat: (text: string) => void;
  closeTable: () => void;
  /** Owner-only: change blinds, stacks, and other table settings. */
  updateSettings: (payload: UpdateSettingsPayload) => void;
}

/**
 * Owns the single Socket.IO connection for one table. Identifies on connect
 * (reusing a saved session token so a page refresh reclaims the same seat),
 * keeps the latest server-pushed PublicTableState, and exposes intent
 * submitters. All game logic stays on the server — this hook only relays.
 */
export function useSocket(name: string, tableId: string): UseSocket {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<PublicTableState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const socket = io(SERVER_URL, { autoConnect: true });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      // Being connected is proof that whatever we last complained about is over.
      // Connection failures have no natural expiry the way a rejected action
      // does, so without this the "connection failed" notice would outlive the
      // reconnect and sit on screen over a perfectly working table.
      setError(null);
      const saved = localStorage.getItem(tokenKey(tableId)) ?? undefined;
      socket.emit(
        EVENTS.Identify,
        { name, tableId, sessionToken: saved },
        (res: IdentifyResult | { ok: false; error: string }) => {
          if (res?.ok) localStorage.setItem(tokenKey(tableId), (res as IdentifyResult).sessionToken);
        },
      );
    });

    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (e: Error) => setError(`Connection failed: ${e.message}`));
    socket.on(EVENTS.State, (s: PublicTableState) => setState(s));
    socket.on(EVENTS.ErrorMsg, (m: { message: string }) => {
      setError(m.message);
      // Auto-clear transient errors so the banner doesn't stick forever.
      window.setTimeout(() => setError(null), 3500);
    });
    socket.on(EVENTS.ChatHistory, (h: ChatMessage[]) => setChat(h));
    socket.on(EVENTS.ChatMessage, (m: ChatMessage) =>
      setChat((prev) => [...prev, m].slice(-100)),
    );
    socket.on(EVENTS.TableClosed, () => {
      localStorage.removeItem(tokenKey(tableId));
      setClosed(true);
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
    };
    // Reconnect if the display name or the table changes.
  }, [name, tableId]);

  const emit = useCallback((event: string, payload: unknown) => {
    socketRef.current?.emit(event, payload, (ack: Ack) => {
      if (ack && ack.ok === false) {
        setError(ack.error);
        window.setTimeout(() => setError(null), 3500);
      }
    });
  }, []);

  const sit = useCallback(
    (seatIndex: number, buyIn?: number) => emit(EVENTS.Sit, { seatIndex, buyIn }),
    [emit],
  );
  const leave = useCallback(() => emit(EVENTS.LeaveSeat, {}), [emit]);
  const sitOut = useCallback((v: boolean) => emit(EVENTS.SitOut, { sitOut: v }), [emit]);
  const act = useCallback((payload: ActionPayload) => emit(EVENTS.Action, payload), [emit]);
  const sendChat = useCallback(
    (text: string) => {
      const t = text.trim();
      if (t) emit(EVENTS.Chat, { text: t });
    },
    [emit],
  );
  const closeTable = useCallback(() => emit(EVENTS.CloseTable, {}), [emit]);
  const updateSettings = useCallback(
    (payload: UpdateSettingsPayload) => emit(EVENTS.UpdateSettings, payload),
    [emit],
  );

  return {
    connected,
    state,
    error,
    chat,
    closed,
    sit,
    leave,
    sitOut,
    act,
    sendChat,
    closeTable,
    updateSettings,
  };
}
