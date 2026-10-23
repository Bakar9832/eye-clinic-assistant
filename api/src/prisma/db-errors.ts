// Recognising database errors by their Postgres code. Prisma wraps them, and its own
// error numbers change between versions; the Postgres codes don't.

/** The underlying Postgres error code, e.g. "23P01", if there is one. */
function postgresCode(error: unknown): string | undefined {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } })?.meta;
  return meta?.driverAdapterError?.cause?.originalCode;
}

/** The no-overlap exclusion constraint stopped a double booking. */
export function isOverlapViolation(error: unknown): boolean {
  return postgresCode(error) === '23P01';
}

/** A UNIQUE constraint was hit (e.g. a duplicate booking reference). */
export function isUniqueViolation(error: unknown): boolean {
  return postgresCode(error) === '23505';
}
