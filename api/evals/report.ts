// Turning runs into numbers: pass rate per category, the baseline comparison, time and
// tokens per conversation.

import { CATEGORIES, type Category } from './case-schema.js';
import type { CaseRun } from './runner.js';

export interface CaseResult {
  id: string;
  category: Category;
  /** Passes when a majority of its runs pass (models don't answer the same way every time). */
  pass: boolean;
  flaky: boolean;
  runs: CaseRun[];
}

export interface EvalResults {
  variant: 'full' | 'minimal';
  model: string;
  /** Which model judged the wording checks. */
  graderModel?: string;
  repeats: number;
  startedAt: string;
  cases: CaseResult[];
}

export function caseResult(id: string, category: Category, runs: CaseRun[]): CaseResult {
  const passed = runs.filter((r) => r.pass).length;
  return { id, category, pass: passed * 2 > runs.length, flaky: passed > 0 && passed < runs.length, runs };
}

export function passRate(results: EvalResults, category?: Category): { passed: number; total: number; rate: number } {
  const cases = results.cases.filter((c) => !category || c.category === category);
  const passed = cases.filter((c) => c.pass).length;
  return { passed, total: cases.length, rate: cases.length ? passed / cases.length : 0 };
}

const pct = (r: { rate: number; total: number }) => (r.total ? `${Math.round(r.rate * 100)}%` : '–');
const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** Per conversation: total time, model calls and tokens. */
export function costs(results: EvalResults) {
  const runs = results.cases.flatMap((c) => c.runs);
  const seconds = runs.map((r) => r.latencyMs.reduce((a, b) => a + b, 0) / 1000);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    conversations: runs.length,
    meanSeconds: mean(seconds),
    p95Seconds: percentile(seconds, 95),
    meanLlmCalls: mean(runs.map((r) => r.usage.llmCalls)),
    meanTokens: mean(runs.map((r) => r.usage.promptTokens + r.usage.completionTokens)),
  };
}

export function markdownReport(results: EvalResults): string {
  const overall = passRate(results);
  const c = costs(results);
  const lines = [
    `# Eval results: ${results.variant} prompt, ${results.model}`,
    '',
    `${results.startedAt} · ${results.cases.length} cases × ${results.repeats} run(s) · a case passes on a majority of its runs` +
      (results.graderModel ? ` · wording graded by ${results.graderModel}` : ''),
    '',
    '| Category | Passed | Pass rate |',
    '|---|---|---|',
    ...CATEGORIES.map((cat) => {
      const r = passRate(results, cat);
      return `| ${cat.replaceAll('_', ' ')} | ${r.passed}/${r.total} | ${pct(r)} |`;
    }),
    `| **Overall** | **${overall.passed}/${overall.total}** | **${pct(overall)}** |`,
    '',
    `Per conversation: ${c.meanSeconds.toFixed(1)} s on average (95th percentile ${c.p95Seconds.toFixed(1)} s), ` +
      `${c.meanLlmCalls.toFixed(1)} model calls, ${Math.round(c.meanTokens)} tokens.`,
  ];

  const failed = results.cases.filter((x) => !x.pass || x.flaky);
  if (failed.length) {
    lines.push('', '## Failed or flaky', '');
    for (const x of failed) {
      lines.push(`### ${x.id} (${x.category})${x.pass ? ' — flaky' : ''}`);
      x.runs.forEach((run, i) => {
        if (!run.pass) lines.push(`- run ${i + 1}: ${run.failures.join('; ')}`);
      });
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

/** The README table: the real prompt against the minimal baseline. */
export function comparisonTable(full: EvalResults, minimal: EvalResults): string {
  const rows = CATEGORIES.map((cat) => `| ${cat.replaceAll('_', ' ')} | ${pct(passRate(full, cat))} | ${pct(passRate(minimal, cat))} |`);
  const cf = costs(full);
  const cm = costs(minimal);
  return [
    `| Category | Full prompt | Minimal baseline |`,
    '|---|---|---|',
    ...rows,
    `| **Overall** | **${pct(passRate(full))}** | **${pct(passRate(minimal))}** |`,
    `| Seconds per conversation (mean / p95) | ${cf.meanSeconds.toFixed(1)} / ${cf.p95Seconds.toFixed(1)} | ${cm.meanSeconds.toFixed(1)} / ${cm.p95Seconds.toFixed(1)} |`,
    `| Tokens per conversation | ${Math.round(cf.meanTokens)} | ${Math.round(cm.meanTokens)} |`,
    '',
    `Model: ${full.model}. ${full.cases.length} cases, ${full.repeats} run(s) each.`,
  ].join('\n');
}
