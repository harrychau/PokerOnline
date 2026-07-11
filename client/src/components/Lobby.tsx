import { useState } from "react";

/** Simple name-entry gate shown before connecting. */
export function Lobby({ onJoin }: { onJoin: (name: string) => void }) {
  const [name, setName] = useState("");
  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onJoin(trimmed.slice(0, 20));
  };
  return (
    <div className="lobby">
      <h1>♠ Poker Online</h1>
      <p>Enter a display name to join the table.</p>
      <input
        autoFocus
        value={name}
        placeholder="Your name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <button className="btn btn-primary" onClick={submit} disabled={!name.trim()}>
        Join
      </button>
    </div>
  );
}
