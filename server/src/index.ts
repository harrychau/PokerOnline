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
  // No table exists at boot, deliberately. A seeded table has no creator, so
  // ownership of it would fall to whoever happened to connect first — arbitrary,
  // and the one table on the server nobody chose to make. With none, every table
  // is created by a player, and that player owns it.
});

httpServer.listen(PORT, () => {
  console.log(`♠  Poker server listening on http://localhost:${PORT}`);
  console.log(`   Socket.IO ready — open the lobby to create or join a table.`);
});
