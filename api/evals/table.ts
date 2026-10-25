// npm run eval:table -- [result.json ...]
//
// One table across models for the README: every complete result in evals/results/ (or
// the files given), each model's full prompt next to its minimal baseline. Writes
// evals/results/models.md.

import fs from 'node:fs';
import path from 'node:path';
import { modelsTable, type EvalResults } from './report.js';

const dir = path.join(process.cwd(), 'evals', 'results');
if (!fs.existsSync(dir)) throw new Error('Run from the api folder: npm run eval:table');

const given = process.argv.slice(2);
const files = given.length
  ? given.map((f) => path.resolve(f))
  : fs
      .readdirSync(dir)
      // Stopped runs (.incomplete.json) are never shown as results.
      .filter((f) => /^(full|minimal)-.+\.json$/.test(f) && !f.endsWith('.incomplete.json'))
      .map((f) => path.join(dir, f));
if (files.length === 0) throw new Error('No results yet: run npm run eval first.');

const results = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as EvalResults);
const table = modelsTable(results) + '\n';
fs.writeFileSync(path.join(dir, 'models.md'), table);
console.log(table);
