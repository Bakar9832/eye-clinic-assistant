// Every case file is valid, ids are unique, and each category is covered. Runs in normal
// CI (no model calls), so a broken case is caught before a nightly eval run wastes quota.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { CATEGORIES, EvalCaseSchema } from './case-schema.js';

const dir = path.join(import.meta.dirname, 'cases');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
const cases = files.map((f) => ({ file: f, data: YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));

describe('the eval cases', () => {
  it.each(cases)('$file is a valid case', ({ data }) => {
    expect(() => EvalCaseSchema.parse(data)).not.toThrow();
  });

  it('ids are unique', () => {
    const ids = cases.map((c) => c.data.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every category has at least three cases (two for slot_taken)', () => {
    for (const category of CATEGORIES) {
      const count = cases.filter((c) => c.data.category === category).length;
      expect(count, category).toBeGreaterThanOrEqual(category === 'slot_taken' ? 2 : 3);
    }
  });

  it('setup bookings and {ref:...} placeholders refer to labels that exist', () => {
    for (const { file, data } of cases) {
      const parsed = EvalCaseSchema.parse(data);
      const labels = new Set(parsed.setup.bookings.map((b) => b.label));
      const referenced = [
        ...parsed.turns.flatMap((turn) => [...turn.matchAll(/\{ref:([a-z0-9-]+)\}/gi)].map((m) => m[1])),
        ...(parsed.expect.moved ?? []).map((m) => m.label),
        ...(parsed.expect.cancelled ?? []),
        ...(parsed.expect.unchanged ?? []),
      ];
      for (const label of referenced) expect(labels.has(label), `${file}: unknown label "${label}"`).toBe(true);
    }
  });

  it('there are 30 to 50 cases, as the project brief asks', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.length).toBeLessThanOrEqual(50);
  });
});
