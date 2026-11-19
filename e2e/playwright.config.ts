import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Locally: the root .env gives the database password and the seed passwords. In CI the
// workflow sets them. Values already in the environment win.
const rootEnv = path.resolve(import.meta.dirname, '..', '.env');
if (fs.existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Its own database, wiped and seeded on every run: never the development or test one.
const databaseUrl = process.env.E2E_DATABASE_URL ?? (process.env.TEST_DATABASE_URL ?? '').replace(/_test(\?|$)/, '_e2e$1');
if (!process.env.SEED_PATIENT_PASSWORD || !process.env.SEED_STAFF_PASSWORD) {
  throw new Error('Set SEED_PATIENT_PASSWORD and SEED_STAFF_PASSWORD (root .env locally, the workflow in CI).');
}

const PORTS = { api: 3100, web: 5174, agent: 8102 };
const AGENT_SERVICE_KEY = 'e2e-only-agent-service-key';

/** The API's settings for these tests only. Empty SMTP_HOST: emails go to the log. */
const apiEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  PORT: String(PORTS.api),
  NODE_ENV: 'development',
  AUTH_SECRET: 'e2e-only-auth-secret',
  AGENT_TOKEN_SECRET: 'e2e-only-agent-token-secret',
  AGENT_SERVICE_KEY,
  AGENT_URL: `http://127.0.0.1:${PORTS.agent}`,
  DEMO_MODE: 'false',
  SMTP_HOST: '',
  NOTIFICATIONS_EVERY_SECONDS: '0',
  RETENTION_EVERY_HOURS: '0',
  TRUST_PROXY_HOPS: '0',
} as Record<string, string>;

export const BASE_URL = `http://127.0.0.1:${PORTS.web}`;

export default defineConfig({
  testDir: './tests',
  // One seeded database shared by every test: run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: 'node stub-agent.mjs',
      url: `http://127.0.0.1:${PORTS.agent}/health`,
      env: { STUB_AGENT_PORT: String(PORTS.agent), CLINIC_API_URL: `http://127.0.0.1:${PORTS.api}`, AGENT_SERVICE_KEY },
      reuseExistingServer: false,
    },
    {
      command: 'node start-api.mjs',
      url: `http://127.0.0.1:${PORTS.api}/clinic`,
      env: apiEnv,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: 'ignore',
    },
    {
      command: `npm run dev -- --port ${PORTS.web} --strictPort --host 127.0.0.1`,
      cwd: path.resolve(import.meta.dirname, '..', 'web'),
      url: BASE_URL,
      env: { ...process.env, API_URL: `http://127.0.0.1:${PORTS.api}` } as Record<string, string>,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
