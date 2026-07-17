import { useState } from "react";
import type { PublicTableState, UpdateSettingsPayload } from "../protocol";

interface TableMenuProps {
  state: PublicTableState;
  onClose: () => void;
  onSitOut: (v: boolean) => void;
  onLeaveSeat: () => void;
  onBackToLobby: () => void;
  onCloseTable: () => void;
  onUpdateSettings: (payload: UpdateSettingsPayload) => void;
}

/**
 * The table's control panel: everything that isn't a betting decision. Seat and
 * table controls used to sit permanently under the action bar, where they
 * competed with fold/call/raise for attention and for thumb room on a phone.
 * Tucking them behind one button leaves the footer to the only choice that is
 * ever urgent, and gives the owner's settings somewhere to live.
 */
export function TableMenu({
  state,
  onClose,
  onSitOut,
  onLeaveSeat,
  onBackToLobby,
  onCloseTable,
  onUpdateSettings,
}: TableMenuProps) {
  const you = state.yourSeatIndex !== null ? state.seats[state.yourSeatIndex] : null;
  const ownerName =
    state.seats.find((s) => s?.playerId === state.ownerPlayerId)?.name ?? null;

  return (
    <div className="menu-backdrop" onClick={onClose}>
      <aside
        className="menu"
        role="dialog"
        aria-label="Table menu"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="menu-title">
          <span>Table menu</span>
          <button className="chat-close" aria-label="Close menu" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="menu-body">
          {you && (
            <section className="menu-section">
              <h3 className="menu-heading">Your seat</h3>
              <div className="menu-row">
                {you.willSitOutNextHand ? (
                  <button className="btn btn-ghost btn-small" onClick={() => onSitOut(false)}>
                    Sit back in
                  </button>
                ) : (
                  <button className="btn btn-ghost btn-small" onClick={() => onSitOut(true)}>
                    Sit out
                  </button>
                )}
                <button className="btn btn-ghost btn-small" onClick={onLeaveSeat}>
                  Leave seat
                </button>
              </div>
            </section>
          )}

          <section className="menu-section">
            <h3 className="menu-heading">Table</h3>
            <div className="menu-row">
              <button className="btn btn-ghost btn-small" onClick={onBackToLobby}>
                Back to lobby
              </button>
              <button
                className="btn btn-danger btn-small"
                onClick={() => {
                  if (window.confirm(`Close "${state.tableName}" for everyone?`)) onCloseTable();
                }}
              >
                Close table
              </button>
            </div>
          </section>

          {state.youAreOwner ? (
            <OwnerSettings state={state} onUpdateSettings={onUpdateSettings} />
          ) : (
            <section className="menu-section">
              <h3 className="menu-heading">Table settings</h3>
              <p className="menu-note">
                {ownerName
                  ? `${ownerName} owns this table and sets the blinds and stakes.`
                  : "This table has no owner right now."}
              </p>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

/** Blinds, stakes and stacks — the owner's half of the menu. */
function OwnerSettings({
  state,
  onUpdateSettings,
}: {
  state: PublicTableState;
  onUpdateSettings: (payload: UpdateSettingsPayload) => void;
}) {
  const c = state.config;
  // Held as strings so a half-typed number doesn't get coerced to 0 mid-keystroke.
  const [form, setForm] = useState({
    smallBlind: String(c.smallBlind),
    bigBlind: String(c.bigBlind),
    startingStack: String(c.startingStack),
    maxSeats: String(c.maxSeats),
    minPlayers: String(c.minPlayers),
    turnSeconds: String(Math.round(state.turnTimeMs / 1000)),
  });
  const [stacks, setStacks] = useState<Record<string, string>>({});

  const seated = state.seats.filter((s): s is NonNullable<typeof s> => s !== null);

  const save = () => {
    const num = (v: string) => Number(v.trim());
    const payload: UpdateSettingsPayload = {
      config: {
        smallBlind: num(form.smallBlind),
        bigBlind: num(form.bigBlind),
        startingStack: num(form.startingStack),
        maxSeats: num(form.maxSeats),
        minPlayers: num(form.minPlayers),
      },
      turnTimeMs: num(form.turnSeconds) * 1000,
    };

    // Only send stacks the owner actually retyped — sending every seat back
    // unchanged would fight with chips players are winning as they type.
    const changed: Record<string, number> = {};
    for (const s of seated) {
      const raw = stacks[s.playerId];
      if (raw === undefined || raw.trim() === "") continue;
      const v = Number(raw);
      if (v !== s.stack) changed[s.playerId] = v;
    }
    if (Object.keys(changed).length > 0) payload.stacks = changed;

    onUpdateSettings(payload);
    setStacks({});
  };

  const field = (label: string, key: keyof typeof form, hint?: string) => (
    <label className="menu-field">
      <span className="menu-field-label">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      />
      {hint && <span className="menu-field-hint">{hint}</span>}
    </label>
  );

  return (
    <section className="menu-section">
      <h3 className="menu-heading">
        Table settings <span className="menu-owner-tag">you own this table</span>
      </h3>

      <div className="menu-grid">
        {field("Small blind", "smallBlind")}
        {field("Big blind", "bigBlind")}
        {field("Buy-in", "startingStack", "stack new players start with")}
        {field("Seats", "maxSeats", "2–10")}
        {field("Min players", "minPlayers", "to start a hand")}
        {field("Turn time", "turnSeconds", "seconds")}
      </div>

      {seated.length > 0 && (
        <>
          <h4 className="menu-subheading">Player stacks</h4>
          <div className="menu-stacks">
            {seated.map((s) => (
              <label key={s.playerId} className="menu-stack-row">
                <span className="menu-stack-name">{s.name}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={stacks[s.playerId] ?? String(s.stack)}
                  onChange={(e) =>
                    setStacks((prev) => ({ ...prev, [s.playerId]: e.target.value }))
                  }
                />
              </label>
            ))}
          </div>
        </>
      )}

      <div className="menu-row menu-row--save">
        <button className="btn btn-primary btn-small" onClick={save}>
          Save settings
        </button>
      </div>

      <p className="menu-note">
        {state.settingsPending
          ? "⏳ Saved — your changes land as soon as this hand finishes."
          : "Blinds, seats and stacks change between hands, so a save during a hand takes effect once it ends."}
      </p>
    </section>
  );
}
