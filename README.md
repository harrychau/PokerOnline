# Poker Online — Real-time Multiplayer Texas Hold'em

A server-authoritative, real-time multiplayer No-Limit Texas Hold'em cash game
(play money). Built as a monorepo:

```
/server   Node + TypeScript. Game engine (pure logic) + networking (Phase 2+).
/client   React + TypeScript UI (Phase 3+).
```

## Status

| Phase | Scope | State |
|-------|-------|-------|
| **1** | Core engine (state machine + hand evaluator) with unit tests, no I/O | ✅ Done |
| **2** | Socket.IO networking, one table, redacted per-player state | ✅ Done |
| **3** | Minimal React table UI | ✅ Done |
| **4** | Turn timers, reconnection, chat, visuals | ✅ Done |
| 5 | Bot seat, hand-history persistence | ⏳ Next |

---

## Phase 1 — Core Engine

Everything lives in [`server/src/engine`](server/src/engine) and is **pure**:
no sockets, no timers, no wall-clock. All randomness goes through an injectable
[`RNG`](server/src/engine/rng.ts) so hands are fully reproducible in tests.

| File | Responsibility |
|------|----------------|
| [`cards.ts`](server/src/engine/cards.ts) | Card/deck types, string codes (`As`, `Th`), Fisher–Yates shuffle |
| [`rng.ts`](server/src/engine/rng.ts) | Seedable `mulberry32` PRNG (deterministic tests) |
| [`handEvaluator.ts`](server/src/engine/handEvaluator.ts) | Best 5-of-7 evaluation → comparable rank; all 9 categories, wheel straights |
| [`pots.ts`](server/src/engine/pots.ts) | Side-pot construction + winner distribution (odd-chip rule) |
| [`betting.ts`](server/src/engine/betting.ts) | Legal-action computation, min-raise validation, all-in normalization |
| [`gameEngine.ts`](server/src/engine/gameEngine.ts) | The state machine: blinds, button, streets, showdown, busting |
| [`types.ts`](server/src/engine/types.ts) | Shared engine types (`Phase`, `Player`, `Pot`, `HandResult`, …) |

### Design notes / poker rules handled explicitly

- **Server-authoritative:** `validateAction` is the single gate. The engine
  never trusts a submitted amount; it re-derives legality and normalizes chips.
- **Heads-up blinds are reversed:** the button posts the small blind and acts
  first preflop (commented in `gameEngine.ts:postBlinds`).
- **Side pots:** built from each player's total hand contribution, layered by
  distinct all-in levels; folded players' chips stay in the pot but they're
  never eligible to win. See `pots.ts:buildPots`.
- **Min-raise + all-in-doesn't-reopen:** a raise must increase the bet by at
  least the last full-raise size. An all-in *short* of a full raise is legal but
  does **not** reopen betting for players who already acted — they may only call
  or fold. Tracked via a per-street "full-raise sequence" counter.
- **All-in run-out:** when no meaningful betting remains, the board is dealt out
  automatically to showdown.
- **Fold-out:** if all but one player folds, the pot is awarded uncontested with
  no cards shown.

### Run it

From the repo root:

```bash
npm install            # installs workspaces

# Unit tests (54 tests: hand ranking, side pots, betting rules, full hands)
npm test               # == npm run test --workspace server

# Type-check (strict mode)
npm run typecheck --workspace server

# Watch a single self-driving hand print to the console
npm run demo --workspace server
```

### Test coverage of the correctness-critical parts

- `handEvaluator.test.ts` — every category, wheel straights, kicker/tiebreak
  ordering, exact ties, best-5-of-7 selection.
- `pots.test.ts` — equal pots, single side pot, nested side pots, folded-player
  chips, split pots, odd-chip assignment, chip conservation.
- `betting.test.ts` — check/call/bet/raise legality, min-raise enforcement,
  short all-in under-raise, fractional/over-stack rejection.
- `gameEngine.test.ts` — blind posting & positions (incl. heads-up), fold-out,
  full street walk to showdown, three-way all-in with side pots, the
  under-raise reopen rule, button rotation.

---

## Phase 2 — Networking (Socket.IO)

The pure engine is unchanged; a thin [`net/`](server/src/net) layer wraps it.
The server is **authoritative**: clients send intents, the server validates via
the engine and pushes a **redacted** state to each socket.

| File | Responsibility |
|------|----------------|
| [`net/protocol.ts`](server/src/net/protocol.ts) | Wire types + event names, shared with the client |
| [`net/redact.ts`](server/src/net/redact.ts) | **Anti-leak boundary:** per-viewer state; own hole cards always, others' only at showdown |
| [`net/room.ts`](server/src/net/room.ts) | One table: session-token registry, seating, auto-start, broadcast |
| [`server.ts`](server/src/server.ts) | Express + Socket.IO wiring (`createServer` factory) |
| [`client-cli.ts`](server/src/client-cli.ts) | Interactive terminal client to play before the browser UI exists |

**Guarantees (unit + integration tested):**
- A player only ever receives their **own** hole cards until showdown; spectators
  see none. Verified both as a pure function (`redact.test.ts`) and over real
  sockets with two clients (`server.integration.test.ts`).
- Illegal / out-of-turn actions are rejected with an error, never applied.
- **Session tokens**: reconnecting with your token reclaims your seat.
- A hand auto-starts when ≥2 players are seated, and again ~2.5s after each hand.

### Run it — play a networked hand from the terminal

Open **three** terminals at the repo root:

```bash
# 1) start the server (http://localhost:3001)
npm run dev --workspace server

# 2) player one
npm run client --workspace server -- --name Alice

# 3) player two  (the hand auto-starts once both are seated)
npm run client --workspace server -- --name Bob
```

In each client: `sit 0` / `sit 1`, then `fold` / `check` / `call` /
`bet <n>` / `raise <n>` (amounts are the total to raise *to*). `help` lists all
commands. You'll see your own cards; opponents show as `[?]`.

> Health check: `curl http://localhost:3001/health` → `{"ok":true}`

---

## Phase 3 — Browser UI (React + Vite)

A minimal but complete table view in [`client/`](client) that consumes the exact
Phase-2 protocol. All game logic stays on the server; the client only renders
`PublicTableState` and submits intents.

| File | Responsibility |
|------|----------------|
| [`useSocket.ts`](client/src/useSocket.ts) | The one connection: identify (persists `sessionToken` → refresh keeps your seat), hold latest state, submit intents |
| [`protocol.ts`](client/src/protocol.ts) | Wire types mirrored from the server (single source noted in-file) |
| [`Table.tsx`](client/src/components/Table.tsx) | Seats around an ellipse (rotated so *you* sit at the bottom), board, pot, dealer button, turn highlight, showdown results |
| [`ActionBar.tsx`](client/src/components/ActionBar.tsx) | Fold / Check-Call / Bet-Raise with slider + ½-pot / pot / all-in presets — driven entirely by server `legalActions` |
| [`Seat.tsx`](client/src/components/Seat.tsx) · [`Card.tsx`](client/src/components/Card.tsx) | Seat box (your cards face-up, others face-down), suit-colored cards |

### Run it — play in the browser

```bash
# terminal 1: server
npm run dev --workspace server            # http://localhost:3001

# terminal 2: client (Vite)
npm run dev --workspace client            # http://localhost:5173
```

Open **http://localhost:5173**, enter a name, and click **Sit here**. Open the
same URL in a **second browser** (or a private window — the seat is tied to
`localStorage`, so two normal tabs share one identity) for player two. The hand
auto-starts once two players are seated. A page refresh keeps your seat via the
saved session token.

> Prefer not to open two browsers? A tiny auto-playing bot is included for local
> testing: `npx tsx src/autobot.ts --name Bot --seat 1` (from `server/`) sits and
> auto-checks/calls so you can play a full hand solo from the browser.

**Verified end-to-end:** a full hand (deal → bet → flop/turn/river → showdown)
was played through the browser against the bot — hole cards stayed private until
showdown, the board filled correctly, and the winner (two pair) and stack
updates matched the engine.

---

## Phase 4 — Timers, Reconnection, Chat, Polish

All wall-clock behavior lives in the `net` layer ([`room.ts`](server/src/net/room.ts)),
keeping the engine pure. Config: `turnTimeMs` (default 20s), `disconnectGraceMs`
(default 30s), `nextHandDelayMs` (2.5s) on `RoomOptions`.

| Feature | How it works |
|---------|--------------|
| **Turn timers** | The Room arms a timer when the acting seat changes and broadcasts an `actingDeadline` (epoch ms). Clients render a smooth [countdown ring](client/src/components/TurnTimer.tsx) locally — no per-tick broadcasts. On timeout the server **checks if free, else folds**. |
| **Reconnection grace** | On disconnect the seat is **held for 30s** (not folded immediately). Reconnecting with the session token cancels the grace and restores the seat. The turn timer keeps the table moving meanwhile; if grace lapses, the player is folded + sat out (seat still reclaimable). |
| **Chat** | [`Chat`](client/src/components/Chat.tsx) panel; server validates + caps the log and broadcasts `chatMessage`; new joiners receive `chatHistory`. |
| **Visuals** | Pulsing highlight + countdown ring on the acting seat, card-deal/board animations, winner pop-in, responsive chat sidebar. |

**Tested** (`phase4.integration.test.ts`, real sockets): timeout auto-folds the
acting player; disconnect holds the seat then restores it on token reconnect;
grace expiry sits the player out; chat broadcasts + history on join. Also
verified live in the browser (ring counts down, timeout advances the hand, chat
posts). **65 server tests pass.**
