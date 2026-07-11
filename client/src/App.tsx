import { useState } from "react";
import { useSocket } from "./useSocket";
import { Lobby } from "./components/Lobby";
import { Table } from "./components/Table";
import { ActionBar } from "./components/ActionBar";
import { Chat } from "./components/Chat";

const NAME_KEY = "poker.name";

export default function App() {
  const [name, setName] = useState<string | null>(() => localStorage.getItem(NAME_KEY));

  if (!name) {
    return (
      <Lobby
        onJoin={(n) => {
          localStorage.setItem(NAME_KEY, n);
          setName(n);
        }}
      />
    );
  }
  return <Game name={name} onLeaveTable={() => setName(null)} />;
}

function Game({ name, onLeaveTable }: { name: string; onLeaveTable: () => void }) {
  const { connected, state, error, chat, sit, leave, sitOut, act, sendChat } = useSocket(name);

  if (!connected || !state) {
    return (
      <div className="status-screen">
        <p>{error ? `⚠ ${error}` : "Connecting to the server…"}</p>
        <p className="hint">Make sure the server is running: <code>npm run dev --workspace server</code></p>
      </div>
    );
  }

  const you = state.yourSeatIndex !== null ? state.seats[state.yourSeatIndex] : null;
  const yourTurn = state.legalActions !== null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">♠ Poker Online</span>
        <span className="table-meta">
          Table "{state.tableId}" · Blinds {state.config.smallBlind}/{state.config.bigBlind}
        </span>
        <span className="conn">{connected ? "● online" : "○ offline"}</span>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="main-area">
        <Table state={state} onSit={sit} />
        <Chat messages={chat} youPlayerId={state.youPlayerId} onSend={sendChat} />
      </div>

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
            <button className="btn btn-small" onClick={() => sitOut(true)}>
              Sit out
            </button>
          )}
          {you && you.willSitOutNextHand && (
            <button className="btn btn-small" onClick={() => sitOut(false)}>
              Sit back in
            </button>
          )}
          {you && (
            <button className="btn btn-small" onClick={leave}>
              Leave seat
            </button>
          )}
          <button className="btn btn-small" onClick={onLeaveTable}>
            Change name
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
