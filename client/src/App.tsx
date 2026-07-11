import { useEffect, useState } from "react";
import { useSocket } from "./useSocket";
import { Lobby } from "./components/Lobby";
import { Table } from "./components/Table";
import { ActionBar } from "./components/ActionBar";
import { Chat } from "./components/Chat";

const NAME_KEY = "poker.name";
const TABLE_KEY = "poker.tableId";

export default function App() {
  const [name, setName] = useState<string | null>(() => localStorage.getItem(NAME_KEY));
  const [tableId, setTableId] = useState<string | null>(() => localStorage.getItem(TABLE_KEY));

  const leaveTable = () => {
    localStorage.removeItem(TABLE_KEY);
    setTableId(null);
  };

  if (!name || !tableId) {
    return (
      <Lobby
        initialName={name ?? ""}
        onJoin={(n, t) => {
          localStorage.setItem(NAME_KEY, n);
          localStorage.setItem(TABLE_KEY, t);
          setName(n);
          setTableId(t);
        }}
      />
    );
  }
  return <Game name={name} tableId={tableId} onLeaveTable={leaveTable} />;
}

function Game({
  name,
  tableId,
  onLeaveTable,
}: {
  name: string;
  tableId: string;
  onLeaveTable: () => void;
}) {
  const { connected, state, error, chat, closed, sit, leave, sitOut, act, sendChat, closeTable } =
    useSocket(name, tableId);
  const [chatOpen, setChatOpen] = useState(false);

  // The table was closed (by us or anyone else at it) — drop back to the lobby.
  useEffect(() => {
    if (closed) onLeaveTable();
  }, [closed, onLeaveTable]);

  if (!connected || !state) {
    return (
      <div className="status-screen">
        <p>{error ? `⚠ ${error}` : "Connecting to the server…"}</p>
        <p className="hint">
          Make sure the server is running: <code>npm run dev --workspace server</code>
        </p>
        <button className="btn btn-small" onClick={onLeaveTable}>
          Back to lobby
        </button>
      </div>
    );
  }

  const you = state.yourSeatIndex !== null ? state.seats[state.yourSeatIndex] : null;
  const yourTurn = state.legalActions !== null;

  return (
    <div className={`app ${chatOpen ? "app--chat-open" : ""}`}>
      <header className="topbar">
        <span className="brand">♠ Poker Online</span>
        <span className="table-meta">
          {state.tableName} · Blinds {state.config.smallBlind}/{state.config.bigBlind}
        </span>
        <div className="topbar-actions">
          <button
            className="icon-btn"
            aria-label="Toggle chat"
            onClick={() => setChatOpen((v) => !v)}
          >
            💬
          </button>
          <span className={`conn ${connected ? "" : "off"}`}>{connected ? "online" : "offline"}</span>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="main-area">
        <Table state={state} onSit={sit} />
        <Chat
          messages={chat}
          youPlayerId={state.youPlayerId}
          onSend={sendChat}
          onClose={() => setChatOpen(false)}
        />
      </div>
      <div className="chat-backdrop" onClick={() => setChatOpen(false)} />

      <footer className="controls">
        {yourTurn && state.legalActions ? (
          <ActionBar
            legal={state.legalActions}
            currentBet={state.currentBet}
            pot={state.pot}
            onAct={act}
          />
        ) : (
          <div className="controls-idle">
            {you ? whyIdle(state.phase, you.status, you.willSitOutNextHand) : "Pick an empty seat to join."}
          </div>
        )}

        <div className="controls-secondary">
          {you && !you.willSitOutNextHand && (
            <button className="btn btn-ghost" onClick={() => sitOut(true)}>
              Sit out
            </button>
          )}
          {you && you.willSitOutNextHand && (
            <button className="btn btn-ghost" onClick={() => sitOut(false)}>
              Sit back in
            </button>
          )}
          {you && (
            <button className="btn btn-ghost" onClick={leave}>
              Leave seat
            </button>
          )}
          <button className="btn btn-ghost" onClick={onLeaveTable}>
            Back to lobby
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              if (window.confirm(`Close "${state.tableName}" for everyone?`)) closeTable();
            }}
          >
            Close table
          </button>
        </div>
      </footer>
    </div>
  );
}

function whyIdle(phase: string, status: string, willSitOut: boolean): string {
  if (status === "SITTING_OUT") {
    return willSitOut
      ? "You are sitting out. Sit back in to be dealt next hand."
      : "Waiting for another player to join…";
  }
  if (status === "FOLDED") return "You folded — waiting for the next hand.";
  if (status === "ALL_IN") return "You're all in — waiting for the hand to play out.";
  if (phase === "WAITING_FOR_PLAYERS") return "Waiting for another player to join…";
  return "Waiting for your turn…";
}
