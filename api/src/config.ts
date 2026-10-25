import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

// One .env at the repo root is shared by every service. Found by looking upward from this
// file, so it works from src/, dist/ and the eval build alike. Real environment variables
// win over the file, so Docker and CI can pass settings directly. No .env is fine too.
function findEnvFile(): string | undefined {
  let dir = import.meta.dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate) && fs.existsSync(path.join(dir, '.env.example'))) return candidate;
    dir = path.dirname(dir);
  }
  return undefined;
}

const envFile = findEnvFile();
if (envFile) config({ path: envFile, quiet: true });

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}
