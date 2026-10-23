import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Every database connection goes through here.
 *
 * The pg adapter sends timestamps without a zone offset, and Postgres reads them
 * in the session time zone. If the server's zone is not UTC (a local install
 * picks up the Windows zone), every stored time silently shifts by hours.
 * Forcing the session to UTC makes storage independent of where Postgres runs.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, options: '-c timezone=UTC' }),
  });
}
