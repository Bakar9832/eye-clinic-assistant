import { requireEnv } from './config.js';
import { createPrismaClient } from './prisma/create-client.js';

/** A client on the test database. test/global-setup.ts has already checked it's safe to wipe. */
export function testPrisma() {
  return createPrismaClient(requireEnv('TEST_DATABASE_URL'));
}
