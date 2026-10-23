import type { PoolCandidate } from './types.js';

/**
 * Chooses which resource from a pool takes a step. All candidates are already known
 * to be free and qualified; this only decides between them.
 *
 * Order of preference:
 * 1. Fewest appointments today (spread the work).
 * 2. Fewest skills (keep versatile staff free for work only they can do).
 * 3. Lowest id (so the same input always gives the same answer, which makes it testable).
 *
 * Returns undefined when there are no candidates.
 */
export function pickResource<T extends PoolCandidate>(candidates: readonly T[]): T | undefined {
  // Copy first: sort() reorders in place, and the caller's list must not change.
  const ranked = [...candidates].sort(
    (a, b) =>
      // Each comparison is 0 on a tie, so || falls through to the next rule.
      a.appointmentsToday - b.appointmentsToday ||
      a.skills.length - b.skills.length ||
      compareIds(a.id, b.id),
  );
  return ranked[0];
}

/** Plain character-code order, so the result never depends on the machine's language settings. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
