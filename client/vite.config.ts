import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client talks to the Socket.IO server directly (default http://localhost:3001,
// override with VITE_SERVER_URL). No proxy needed since the server allows CORS.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
