/**
 * Server entry point. Binds the Phase-2 poker server to a port.
 *
 *   npm run dev --workspace server   # tsx watch
 *   npm start   --workspace server   # compiled
 */
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3001);

const tableConfig = { maxSeats: 6, smallBlind: 1, bigBlind: 2, startingStack: 200, minPlayers: 2 };

const { httpServer } = createServer({
  roomDefaults: { config: tableConfig },
  // One table exists at boot so players have somewhere to sit immediately;
  // anyone can create more or close this one from the lobby.
  seedTables: [{ name: "Main Table", config: tableConfig }],
});

httpServer.listen(PORT, () => {
  console.log(`♠  Poker server listening on http://localhost:${PORT}`);
  console.log(`   Socket.IO ready — open the lobby to create or join a table.`);
});
