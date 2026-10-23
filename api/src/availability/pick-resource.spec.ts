import { pickResource } from './pick-resource.js';
import type { PoolCandidate } from './types.js';

const candidate = (id: string, appointmentsToday: number, skills: PoolCandidate['skills']): PoolCandidate => ({
  id,
  appointmentsToday,
  skills,
});

describe('pickResource', () => {
  it('returns undefined when nobody is available', () => {
    expect(pickResource([])).toBeUndefined();
  });

  it('17. picks whoever has the fewest appointments today', () => {
    const busy = candidate('tech-a', 3, ['PRETEST']);
    const quiet = candidate('tech-b', 1, ['PRETEST', 'SCAN']);
    expect(pickResource([busy, quiet])).toBe(quiet);
  });

  it('18. on a tie, prefers fewer skills (Usman pre-tests, Sara stays free for scans)', () => {
    const sara = candidate('tech-sara', 2, ['PRETEST', 'SCAN']);
    const usman = candidate('tech-usman', 2, ['PRETEST']);
    expect(pickResource([sara, usman])).toBe(usman);
  });

  it('19. on a full tie, picks the lowest id whatever the input order', () => {
    const a = candidate('dr-ayesha', 0, ['PAEDIATRIC']);
    const b = candidate('dr-bilal', 0, ['CONTACT_LENS']);
    expect(pickResource([a, b])).toBe(a);
    expect(pickResource([b, a])).toBe(a);
  });

  it("19b. doesn't reorder the caller's array", () => {
    const list = [candidate('z', 5, []), candidate('a', 0, [])];
    pickResource(list);
    expect(list.map((c) => c.id)).toEqual(['z', 'a']);
  });
});
