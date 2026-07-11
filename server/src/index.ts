/**
 * Server entry point. Binds the Phase-2 poker server to a port.
 *
 *   npm run dev --workspace server   # tsx watch
 *   npm start   --workspace server   # compiled
 */
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3001);

const { httpServer } = createServer({
  tableId: "main",
  config: { maxSeats: 6, smallBlind: 1, bigBlind: 2, startingStack: 200, minPlayers: 2 },
});

httpServer.listen(PORT, () => {
  console.log(`♠  Poker server listening on http://localhost:${PORT}`);
  console.log(`   Socket.IO ready — connect a client to join table "main".`);
});
