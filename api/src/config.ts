import path from 'node:path';
import { config } from 'dotenv';

// One .env at the repo root is shared by every service. Works from src/ and dist/,
// which both sit one level below api/. Real environment variables win over the file,
// so Docker can pass settings directly later.
config({ path: path.resolve(import.meta.dirname, '..', '..', '.env'), quiet: true });

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}
