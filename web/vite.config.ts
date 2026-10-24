/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = process.env.API_URL ?? 'http://localhost:3000';

// The browser talks to one site. Requests for these API paths are passed on to the
// clinic API, so its cookies are first-party and no cross-site (CORS) setup is needed.
// Page routes (/, /calendar, /my, /results, /profile, /login, /admin) never use these prefixes.
const apiPaths = ['auth', 'me', 'chat', 'clinic', 'availability', 'appointment-types', 'staff'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(apiPaths.map((p) => [`^/${p}(/|\\?|$)`, { target: API, changeOrigin: false }])),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
});
