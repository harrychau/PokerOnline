import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  EVENTS,
  type Ack,
  type ActionPayload,
  type ChatMessage,
  type IdentifyResult,
  type PublicTableState,
} from "./protocol";

// In a production build the client is served by the same Node process as the
// socket server, so connect same-origin (SERVER_URL undefined → socket.io uses
// window.location). In dev the Vite server is a separate origin, so fall back to
// the local server port. Override either with VITE_SERVER_URL.
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ??
  (import.meta.env.DEV ? "http://localhost:3001" : undefined);
const TOKEN_KEY = "poker.sessionToken";

export interface UseSocket {
  connected: boolean;
  state: PublicTableState | null;
  error: string | null;
  chat: ChatMessage[];
  sit: (seatIndex: number, buyIn?: number) => void;
  leave: () => void;
  sitOut: (v: boolean) => void;
  act: (payload: ActionPayload) => void;
  sendChat: (text: string) => void;
}

/**
 * Owns the single Socket.IO connection. Identifies on connect (reusing a saved
 * session token so a page refresh reclaims the same seat), keeps the latest
 * server-pushed PublicTableState, and exposes intent submitters. All game logic
 * stays on the server — this hook only relays.
 */
export function useSocket(name: string): UseSocket {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<PublicTableState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);

  useEffect(() => {
    const socket = io(SERVER_URL, { autoConnect: true });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      const saved = localStorage.getItem(TOKEN_KEY) ?? undefined;
      socket.emit(
        EVENTS.Identify,
        { name, sessionToken: saved },
        (res: IdentifyResult) => {
          if (res?.ok) localStorage.setItem(TOKEN_KEY, res.sessionToken);
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

    return () => {
      socket.removeAllListeners();
      socket.close();
    };
    // Reconnect only if the display name changes.
  }, [name]);

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

  return { connected, state, error, chat, sit, leave, sitOut, act, sendChat };
}
