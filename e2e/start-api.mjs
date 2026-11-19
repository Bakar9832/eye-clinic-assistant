// Prepares the browser tests' own database and starts the real API on it:
// migrate, seed (it wipes the clinic tables, so only a database with "e2e" in its name),
// build, start. Run by Playwright (playwright.config.ts → webServer).

import { execSync, spawn } from 'node:child_process';
import path from 'node:path';

const api = path.resolve(import.meta.dirname, '..', 'api');
const url = process.env.DATABASE_URL ?? '';
const dbName = url ? new URL(url).pathname.slice(1) : '';
if (!/e2e/i.test(dbName)) {
  throw new Error(`Refusing to seed "${dbName}": the browser tests need their own database with "e2e" in its name.`);
}

const run = (command) => execSync(command, { cwd: api, stdio: 'inherit', env: process.env });
run('npx prisma migrate deploy');
run('npx prisma db seed');
if (!process.env.E2E_SKIP_BUILD) run('npm run build');

const server = spawn(process.execPath, ['dist/main.js'], { cwd: api, stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
