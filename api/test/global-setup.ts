// Runs once before any test file. Gets the test database ready.

import { execSync } from 'node:child_process';
import pg from 'pg';
import { requireEnv } from '../src/config.js';

export default async function setup() {
  const url = requireEnv('TEST_DATABASE_URL');

  // Tests wipe this database, so make very sure it isn't the real one.
  const name = new URL(url).pathname.slice(1);
  if (url === process.env.DATABASE_URL || !/test/i.test(name)) {
    throw new Error(`Refusing to run tests against "${name}": TEST_DATABASE_URL must be a separate database with "test" in its name.`);
  }

  // Always test against the latest schema.
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' });

  // Give the server a non-UTC default zone, like a local install has. If the code
  // stopped forcing UTC per connection, the round-trip test would catch it.
  const client = new pg.Client({ connectionString: url.replace(/\?.*$/, '') });
  await client.connect();
  await client.query(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Karachi'); END $$`);
  await client.end();
}
