/**
 * A minimal interactive terminal client for the Phase-2 server, so a human can
 * play a real networked hand before the Phase-3 browser UI exists.
 *
 * Usage (run the server first with `npm run dev`), then in two+ terminals:
 *   npm run client --workspace server -- --name Alice
 *   npm run client --workspace server -- --name Bob   --url http://localhost:3001
 *
 * Commands once connected:
 *   sit <seat>      take a seat (0-5)
 *   fold | check | call
 *   bet <n> | raise <n>     amounts are the TOTAL to raise TO
 *   sitout | sitin | leave | help | quit
 */
import readline from "node:readline";
import { io as ioClient } from "socket.io-client";
import { cardToString } from "./engine/cards.js";
import { EVENTS, type IdentifyResult, type PublicTableState } from "./net/protocol.js";

const args = process.argv.slice(2);
const getArg = (flag: string, def: string): string => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const name = getArg("--name", `Player${Math.floor(Math.random() * 1000)}`);
const url = getArg("--url", "http://localhost:3001");

// Let Socket.IO negotiate transport (polling → upgrade to websocket). This is
// the most compatible default; forcing websocket-only can silently fail on some
// Windows network setups.
const socket = ioClient(url);
let myId: string | null = null;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/** Commands typed before identify completes are queued, then flushed. */
const pending: string[] = [];

console.log(`Connecting to ${url} ...`);

socket.on("connect", () => {
  socket.emit(EVENTS.Identify, { name }, (res: IdentifyResult) => {
    if (res?.ok) {
      myId = res.playerId;
      console.log(`\nConnected as "${name}".`);
      console.log(`>>> To join the game, type:  sit 0   (then another player types  sit 1 )`);
      console.log(`    Full command list: help\n`);
      for (const line of pending.splice(0)) handleLine(line);
      prompt();
    }
  });
});

// Surface connection problems instead of hanging silently.
socket.on("connect_error", (err: Error) => {
  console.log(`\n!! Could not connect to ${url}`);
  console.log(`   ${err.message}`);
  console.log(`   Is the server running?  npm run dev --workspace server`);
  console.log(`   (retrying...)`);
});

socket.on(EVENTS.ErrorMsg, (msg: { message: string }) => {
  console.log(`\n!! ${msg.message}`);
  prompt();
});

socket.on(EVENTS.State, (s: PublicTableState) => {
  render(s);
  prompt();
});

socket.on("disconnect", () => console.log("\nDisconnected from server."));

function render(s: PublicTableState): void {
  // ASCII-only output so it renders identically in every terminal (including
  // the classic Windows console, which garbles box-drawing/card glyphs).
  const board = s.board.map(cardToString).join(" ") || "-";
  const lines: string[] = [];
  lines.push("");
  lines.push(`========== Table "${s.tableId}"  hand #${s.handNumber} ==========`);
  lines.push(`Phase: ${s.phase}   Board: ${board}   Pot: ${s.pot}`);
  for (let i = 0; i < s.config.maxSeats; i++) {
    const seat = s.seats[i];
    if (!seat) {
      lines.push(`  [${i}] (empty)`);
      continue;
    }
    const marks = [
      seat.isButton ? "D" : " ",
      seat.isActing ? "*" : " ",
      seat.connected ? " " : "x",
    ].join("");
    const cards = seat.holeCards
      ? seat.holeCards.map(cardToString).join(" ")
      : seat.hasCards
        ? "[?] [?]"
        : "-";
    const you = seat.playerId === myId ? " (you)" : "";
    const bet = seat.streetCommitted > 0 ? ` bet ${seat.streetCommitted}` : "";
    lines.push(
      `  [${i}]${marks} ${seat.name}${you}  $${seat.stack}${bet}  ${cards}  ${seat.status}`,
    );
  }

  if (s.lastResult && s.phase === "HAND_COMPLETE") {
    for (const pot of s.lastResult.potResults) {
      for (const w of pot.winners) {
        const tag = pot.uncontested ? " (uncontested)" : "";
        lines.push(`  -> ${seatName(s, w.playerId)} wins ${w.amountWon}${tag}`);
      }
    }
  }

  // Impossible-to-miss nudge when you haven't taken a seat yet.
  if (s.yourSeatIndex === null) {
    const openSeat = s.seats.findIndex((x) => x === null);
    lines.push(`  >>> You are not seated. Type "sit ${openSeat < 0 ? 0 : openSeat}" to join. <<<`);
  } else if (!s.legalActions && s.phase !== "HAND_COMPLETE") {
    lines.push(`  (waiting for other players...)`);
  }

  if (s.legalActions) {
    const a = s.legalActions;
    const opts: string[] = [];
    if (a.canFold) opts.push("fold");
    if (a.canCheck) opts.push("check");
    if (a.canCall) opts.push(`call ${a.callAmount}`);
    if (a.canBet) opts.push(`bet ${a.minBetTo}..${a.maxBetTo}`);
    if (a.canRaise) opts.push(`raise ${a.minBetTo}..${a.maxBetTo}`);
    lines.push(`  YOUR ACTION → ${opts.join("  |  ")}`);
  }
  console.log(lines.join("\n"));
}

function seatName(s: PublicTableState, playerId: string): string {
  return s.seats.find((x) => x?.playerId === playerId)?.name ?? playerId;
}

function ack(res: { ok: boolean; error?: string }): void {
  if (!res?.ok) console.log(`⚠  ${res?.error ?? "action failed"}`);
}

function prompt(): void {
  rl.setPrompt("> ");
  rl.prompt();
}

rl.on("line", (line) => {
  // Hold input until we have an identity, so early keystrokes aren't rejected.
  if (myId === null && line.trim() !== "" && !/^(quit|exit|help)$/.test(line.trim())) {
    pending.push(line);
    return;
  }
  handleLine(line);
});

function handleLine(line: string): void {
  const [cmd, arg] = line.trim().split(/\s+/);
  switch (cmd) {
    case "sit":
      socket.emit(EVENTS.Sit, { seatIndex: Number(arg) }, ack);
      break;
    case "leave":
      socket.emit(EVENTS.LeaveSeat, {}, ack);
      break;
    case "sitout":
      socket.emit(EVENTS.SitOut, { sitOut: true }, ack);
      break;
    case "sitin":
      socket.emit(EVENTS.SitOut, { sitOut: false }, ack);
      break;
    case "fold":
    case "check":
    case "call":
      socket.emit(EVENTS.Action, { type: cmd }, ack);
      break;
    case "bet":
    case "raise":
      socket.emit(EVENTS.Action, { type: cmd, amount: Number(arg) }, ack);
      break;
    case "help":
      console.log("Commands: sit <seat> | fold | check | call | bet <n> | raise <n> | sitout | sitin | leave | quit");
      break;
    case "quit":
    case "exit":
      socket.close();
      rl.close();
      process.exit(0);
      break;
    case "":
      break;
    default:
      console.log(`Unknown command "${cmd}". Type "help".`);
  }
  prompt();
}
