import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El edge de EasyBits (Caddy) negocia HTTP/2 por ALPN, y goose serve NO
// soporta upgrade WebSocket sobre h2 (devuelve 406). Por HTTP/1.1 sí (101).
// El navegador siempre ofrece h2, así que hablamos ws://localhost:5173/acp
// y Vite reenvía al edge por HTTP/1.1 (node usa h1 por defecto).
const TARGET = 'https://sb-48f0a5d0-53d9-419e-bc1d-f1ac90e3d0da-3000.sandboxes.easybits.cloud';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/acp': {
        target: TARGET,
        // changeOrigin true: reescribe Host → el edge enruta correcto.
        // No toca Origin (http://localhost:5173), que goose acepta como loopback.
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
