/**
 * A tiny CLI demo that plays one self-driving hand and prints the engine state
 * at each step. This exists so Phase 1 is observable without any networking:
 *
 *   npm run demo --workspace server
 *
 * The "strategy" is trivial (check when possible, otherwise call, and the first
 * player open-raises once) — it's just here to exercise the state machine.
 */
import { GameEngine } from "./engine/gameEngine.js";
import { mulberry32 } from "./engine/rng.js";
import { cardToString } from "./engine/cards.js";
import { HAND_CATEGORY_NAMES } from "./engine/handEvaluator.js";
import { Phase } from "./engine/types.js";

const engine = new GameEngine(
  { smallBlind: 1, bigBlind: 2, startingStack: 200, maxSeats: 6 },
  mulberry32(Date.now() >>> 0),
);

engine.seatPlayer({ id: "alice", name: "Alice", seatIndex: 0 });
engine.seatPlayer({ id: "bob", name: "Bob", seatIndex: 1 });
engine.seatPlayer({ id: "carol", name: "Carol", seatIndex: 2 });

engine.startHand();
console.log(`\n=== Hand #${engine.state.handNumber} ===`);
console.log("Button:", engine.state.buttonIndex);
for (const p of engine.state.seats) {
  if (p) console.log(`  Seat ${p.seatIndex} ${p.name}: ${p.holeCards!.map(cardToString).join(" ")} (stack ${p.stack})`);
}

let lastPhase: Phase | null = null;
let openedThisStreet = false;

while (engine.isHandInProgress()) {
  if (engine.state.phase !== lastPhase) {
    lastPhase = engine.state.phase;
    openedThisStreet = false;
    const board = engine.state.board.map(cardToString).join(" ") || "(none)";
    console.log(`\n-- ${engine.state.phase} -- board: ${board} | pot: ${engine.totalPot()}`);
  }

  const legal = engine.legalActionsForCurrent();
  if (!legal) break;
  const { playerId, actions } = legal;

  // Trivial actor: open a single min-raise once per hand, else check/call.
  if (!openedThisStreet && actions.canBet) {
    openedThisStreet = true;
    engine.applyAction(playerId, { type: "bet", amount: actions.minBetTo });
    console.log(`  ${playerId} bets ${actions.minBetTo}`);
  } else if (actions.canCheck) {
    engine.applyAction(playerId, { type: "check" });
    console.log(`  ${playerId} checks`);
  } else {
    engine.applyAction(playerId, { type: "call" });
    console.log(`  ${playerId} calls ${actions.callAmount}`);
  }
}

console.log(`\n== Result ==`);
const result = engine.state.lastResult!;
console.log("Final board:", result.board.map(cardToString).join(" ") || "(none)");
for (const pot of result.potResults) {
  const tag = pot.uncontested ? " (uncontested)" : "";
  for (const w of pot.winners) {
    const handName = w.hand ? ` with ${HAND_CATEGORY_NAMES[w.hand.category]}` : "";
    console.log(`  ${w.playerId} wins ${w.amountWon}${handName}${tag}`);
  }
}
console.log("\nFinal stacks:");
for (const p of engine.state.seats) {
  if (p) console.log(`  ${p.name}: ${p.stack}`);
}
