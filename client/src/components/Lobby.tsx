import { useState } from "react";
import { useLobby } from "../useLobby";

/** Name entry + table browser: pick an existing table or start a new one. */
export function Lobby({
  initialName,
  onJoin,
}: {
  initialName: string;
  onJoin: (name: string, tableId: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [newTableName, setNewTableName] = useState("");
  const [busy, setBusy] = useState(false);
  const { connected, error, tables, refresh, createTable } = useLobby();

  const trimmedName = name.trim().slice(0, 20);
  const canJoin = trimmedName.length > 0;

  const join = (tableId: string) => {
    if (canJoin) onJoin(trimmedName, tableId);
  };

  const create = async () => {
    if (!canJoin || busy) return;
    setBusy(true);
    try {
      const tableId = await createTable(newTableName.trim());
      onJoin(trimmedName, tableId);
    } catch {
      // useLobby surfaces the failure via `error`; nothing else to do here.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lobby">
      <h1>♠ Poker Online</h1>
      <input
        autoFocus
        value={name}
        placeholder="Your name"
        onChange={(e) => setName(e.target.value)}
      />
      {error && <p className="hint lobby-error">{error}</p>}

      <div className="table-list">
        <div className="table-list-header">
          <span>Tables{connected ? "" : " (connecting…)"}</span>
          <button className="btn btn-small" onClick={refresh}>
            Refresh
          </button>
        </div>
        {tables.length === 0 && <p className="hint">No tables yet — start one below.</p>}
        {tables.map((t) => (
          <div key={t.tableId} className="table-row">
            <div className="table-row-info">
              <span className="table-row-name">{t.name}</span>
              <span className="table-row-meta">
                {t.playerCount}/{t.maxSeats} players ·{" "}
                {t.phase === "WAITING_FOR_PLAYERS" ? "waiting" : `hand #${t.handNumber}`}
              </span>
            </div>
            <button className="btn btn-small" disabled={!canJoin} onClick={() => join(t.tableId)}>
              Join
            </button>
          </div>
        ))}
      </div>

      <div className="table-create">
        <input
          value={newTableName}
          placeholder="New table name (optional)"
          onChange={(e) => setNewTableName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
        <button className="btn btn-primary" disabled={!canJoin || busy} onClick={create}>
          Create table
        </button>
      </div>
    </div>
  );
}
