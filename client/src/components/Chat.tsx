import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../protocol";

interface ChatProps {
  messages: ChatMessage[];
  youPlayerId: string | null;
  onSend: (text: string) => void;
  /** Closes the mobile drawer (no-op on desktop where the panel is docked). */
  onClose?: () => void;
}

/** A simple table chat panel: scrolling message list + input. */
export function Chat({ messages, youPlayerId, onSend, onClose }: ChatProps) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };

  return (
    <aside className="chat">
      <div className="chat-title">
        <span>Table chat</span>
        <button className="chat-close" aria-label="Close chat" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && <div className="chat-empty">No messages yet. Say hi 👋</div>}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.playerId === youPlayerId ? "mine" : ""}`}>
            <span className="chat-name">{m.name}:</span> <span className="chat-text">{m.text}</span>
          </div>
        ))}
      </div>
      <div className="chat-input">
        <input
          value={text}
          maxLength={200}
          placeholder="Type a message…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button className="btn btn-small" onClick={send}>
          Send
        </button>
      </div>
    </aside>
  );
}
