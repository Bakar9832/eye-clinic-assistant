// npm run eval -- [--variant full|minimal] [--repeats 3] [--only <id or category>] [--threshold 0.8]
//
// Starts the clinic API on the eval database and the real Python agent pointed at it, runs
// every case through POST /chat, writes evals/results/<variant>.{json,md}, and exits
// non-zero when the pass rate is below the threshold (so CI fails).

import { spawn, type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { requireEnv } from '../src/config.js';
import { EvalCaseSchema, type EvalCase } from './case-schema.js';
import { createEvalApp, RecordingHttpAgent } from './eval-app.js';
import { createGrader } from './grader.js';
import { caseResult, comparisonTable, markdownReport, passRate, type EvalResults } from './report.js';
import { runCase, type Pace } from './runner.js';

// Run from api/ (npm run eval). The compiled runner lives in .eval-build/, so paths are
// taken from the working directory, not from this file.
const API_ROOT = process.cwd();
const HERE = path.join(API_ROOT, 'evals');
const AGENT_DIR = path.resolve(API_ROOT, '..', 'agent');
if (!fs.existsSync(path.join(HERE, 'cases'))) throw new Error('Run the evals from the api folder: npm run eval');

const { values: args } = parseArgs({
  options: {
    variant: { type: 'string', default: 'full' },
    repeats: { type: 'string', default: '1' },
    only: { type: 'string' },
    threshold: { type: 'string', default: '0' },
  },
});
const variant = args.variant === 'minimal' ? 'minimal' : 'full';
const repeats = Math.max(1, Number(args.repeats));

function loadCases(): EvalCase[] {
  const dir = path.join(HERE, 'cases');
  const cases = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      try {
        return EvalCaseSchema.parse(YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch (error) {
        throw new Error(`Invalid case file ${f}: ${(error as Error).message}`);
      }
    });
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`Duplicate case id ${c.id}`);
    ids.add(c.id);
  }
  return args.only ? cases.filter((c) => c.id.includes(args.only!) || c.category === args.only) : cases;
}

/** Keeps model calls under the free tier's per-minute limit. */
function pacer(maxPerMinute: number): Pace & { record: (calls: number) => void } {
  const stamps: number[] = [];
  const pace = async (expected: number) => {
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] > 60_000) stamps.shift();
      if (stamps.length + expected <= maxPerMinute || stamps.length === 0) return;
      await new Promise((r) => setTimeout(r, Math.max(500, 60_000 - (now - stamps[0]) + 200)));
    }
  };
  return Object.assign(pace, { record: (calls: number) => stamps.push(...Array(calls).fill(Date.now())) });
}

function pythonFor(agentDir: string): string {
  if (process.env.EVAL_PYTHON) return process.env.EVAL_PYTHON;
  for (const candidate of [path.join(agentDir, '.venv', 'Scripts', 'python.exe'), path.join(agentDir, '.venv', 'bin', 'python')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'python';
}

async function waitFor(url: string, child: ChildProcess, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (child.exitCode !== null) throw new Error(`The agent exited early (code ${child.exitCode})`);
    if (await fetch(url).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  const databaseUrl = requireEnv('EVAL_DATABASE_URL');
  const dbName = new URL(databaseUrl).pathname.slice(1);
  if (!/eval|test/i.test(dbName) || databaseUrl === process.env.DATABASE_URL) {
    throw new Error(`Refusing to run evals on "${dbName}": EVAL_DATABASE_URL must be its own database with "eval" in the name.`);
  }
  const cases = loadCases();
  if (cases.length === 0) throw new Error('No cases matched');

  execSync('npx prisma migrate deploy', { cwd: API_ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'ignore' });

  const apiPort = Number(process.env.EVAL_API_PORT ?? 3999);
  const agentPort = Number(process.env.EVAL_AGENT_PORT ?? 8999);
  process.env.AGENT_URL = `http://127.0.0.1:${agentPort}`;
  const t = await createEvalApp({ databaseUrl, agent: new RecordingHttpAgent(), port: apiPort });

  const agent = spawn(
    pythonFor(AGENT_DIR),
    ['-m', 'uvicorn', 'eye_agent.app:create_app', '--factory', '--port', String(agentPort), '--log-level', 'warning'],
    {
      cwd: AGENT_DIR,
      env: { ...process.env, CLINIC_API_URL: t.baseUrl, AGENT_PROMPT: variant, LOG_LEVEL: 'WARNING' },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  const model = requireEnv('LLM_MODEL');
  const pace = pacer(Number(process.env.EVAL_MAX_LLM_CALLS_PER_MINUTE ?? 12));
  const grade = createGrader({
    baseUrl: requireEnv('LLM_BASE_URL'),
    apiKey: requireEnv('LLM_API_KEY'),
    models: [process.env.EVAL_GRADER_MODEL || model, process.env.LLM_FALLBACK_MODEL].filter(Boolean) as string[],
  });

  const results: EvalResults = { variant, model, repeats, startedAt: new Date().toISOString(), cases: [] };
  try {
    await waitFor(`${process.env.AGENT_URL}/health`, agent);
    console.log(`Running ${cases.length} case(s) × ${repeats}, ${variant} prompt, model ${model}\n`);

    for (const evalCase of cases) {
      const runs = [];
      for (let i = 0; i < repeats; i++) {
        const run = await runCase(t, evalCase, grade, pace);
        pace.record(run.usage.llmCalls + (evalCase.expect.graded?.length ? 1 : 0));
        runs.push(run);
      }
      const result = caseResult(evalCase.id, evalCase.category, runs);
      results.cases.push(result);
      const mark = result.pass ? (result.flaky ? '~' : '✓') : '✗';
      console.log(`${mark} ${evalCase.category.padEnd(18)} ${evalCase.id}${result.pass ? '' : `  — ${runs.find((r) => !r.pass)?.failures.join('; ')}`}`);
    }
  } finally {
    agent.kill();
    await t.app.close();
  }

  const outDir = path.join(HERE, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${variant}.json`), JSON.stringify(results, null, 2));
  const report = markdownReport(results);
  fs.writeFileSync(path.join(outDir, `${variant}.md`), report);

  const other = path.join(outDir, `${variant === 'full' ? 'minimal' : 'full'}.json`);
  if (fs.existsSync(other)) {
    const otherResults = JSON.parse(fs.readFileSync(other, 'utf8')) as EvalResults;
    const [full, minimal] = variant === 'full' ? [results, otherResults] : [otherResults, results];
    fs.writeFileSync(path.join(outDir, 'comparison.md'), comparisonTable(full, minimal) + '\n');
  }

  const overall = passRate(results);
  console.log(`\n${report.split('\n').slice(4, 18).join('\n')}`);
  const threshold = Number(args.threshold);
  if (overall.rate < threshold) {
    console.error(`\nPass rate ${Math.round(overall.rate * 100)}% is below the threshold of ${Math.round(threshold * 100)}%.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
