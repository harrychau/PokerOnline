/**
 * A tiny auto-playing bot used only for local end-to-end testing of the server
 * + browser client. It connects, sits at the given seat, and always takes the
 * cheapest legal action (check, else call, else fold). Not a real strategy —
 * just something to keep a hand moving so a human at the browser can play.
 *
 *   npx tsx src/autobot.ts --name Bot --seat 1 --url http://localhost:3001
 */
import { io } from "socket.io-client";
import { EVENTS, type IdentifyResult, type PublicTableState } from "./net/protocol.js";

const args = process.argv.slice(2);
const arg = (f: string, d: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const name = arg("--name", "Bot");
const seat = Number(arg("--seat", "1"));
const url = arg("--url", "http://localhost:3001");

const socket = io(url);

socket.on("connect", () => {
  socket.emit(EVENTS.Identify, { name }, (res: IdentifyResult) => {
    if (res?.ok) {
      console.log(`[${name}] connected, sitting at seat ${seat}`);
      socket.emit(EVENTS.Sit, { seatIndex: seat }, () => {});
    }
  });
});

socket.on(EVENTS.State, (s: PublicTableState) => {
  const a = s.legalActions;
  if (!a) return; // not our turn
  // Cheapest legal action, with a tiny delay so a human can watch it happen.
  setTimeout(() => {
    if (a.canCheck) socket.emit(EVENTS.Action, { type: "check" }, () => {});
    else if (a.canCall) socket.emit(EVENTS.Action, { type: "call" }, () => {});
    else socket.emit(EVENTS.Action, { type: "fold" }, () => {});
  }, 600);
});

socket.on(EVENTS.ErrorMsg, (m: { message: string }) => console.log(`[${name}] ! ${m.message}`));
console.log(`[${name}] connecting to ${url} ...`);
