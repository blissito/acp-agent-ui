import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// El backend (web/server.mjs, Node http + SSE) corre en :4000.
// Vite sirve el SPA en :5173 y proxya /conversations* al backend (así el
// navegador ve un solo origen y no hay líos de CORS para SSE/fetch).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/conversations": "http://127.0.0.1:4000",
    },
  },
});
