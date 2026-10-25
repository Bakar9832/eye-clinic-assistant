// The models table: what the README shows when a local model and Gemini are compared.

import { modelsTable, type EvalResults } from './report.js';
import type { CaseRun } from './runner.js';

const run = (pass: boolean, seconds = 2): CaseRun =>
  ({
    pass,
    failures: pass ? [] : ['x'],
    transcript: [],
    tools: [],
    latencyMs: [seconds * 1000],
    usage: { llmCalls: 2, toolCalls: 1, promptTokens: 900, completionTokens: 100 },
  }) as unknown as CaseRun;

const results = (model: string, variant: 'full' | 'minimal', passes: boolean[], startedAt = '2026-10-25T07:00:00Z'): EvalResults => ({
  variant,
  model,
  repeats: 1,
  startedAt,
  cases: passes.map((pass, i) => ({
    id: `case-${i}`,
    category: i === 0 ? 'identity' : 'correct_booking',
    pass,
    flaky: false,
    runs: [run(pass)],
  })),
});

describe('modelsTable', () => {
  const table = modelsTable([
    results('qwen', 'minimal', [true, false]),
    results('gemini', 'full', [true, true], '2026-10-24T07:00:00Z'),
    results('qwen', 'full', [true, true]),
  ]);
  const lines = table.split('\n');

  it('has one column per model and prompt, each full prompt before its baseline', () => {
    expect(lines[0]).toBe('| Category | gemini · full prompt | qwen · full prompt | qwen · minimal baseline |');
  });

  it('shows pass rates per category and overall', () => {
    expect(lines).toContain('| correct booking | 100% | 100% | 0% |');
    expect(lines).toContain('| identity | 100% | 100% | 100% |');
    expect(lines).toContain('| **Overall** | **100%** | **100%** | **50%** |');
    expect(lines).toContain('| urgent | – | – | – |');
  });

  it('says how many runs and when, since older results may be on an older prompt', () => {
    expect(lines).toContain('| Cases × runs | 2 × 1 | 2 × 1 | 2 × 1 |');
    expect(lines).toContain('| Measured | 2026-10-24 | 2026-10-25 | 2026-10-25 |');
    expect(lines).toContain('| Tokens per conversation | 1000 | 1000 | 1000 |');
  });
});
