/**
 * Runner for the regression suite: node test/run.mjs   (or: npm test)
 *
 * .test.mjs  → run with plain node (no TypeScript)
 * .test.mts  → run with tsx (these import TypeScript modules from src/)
 *
 * Requirements: the MCP transport tests (task08) spawn `node dist/mcp/server.js`,
 * so the project must be compiled first. `npm test` does this via the `pretest`
 * script (`tsc`); running this file directly requires `npm run build` beforehand.
 *
 * No network access, no chain calls: every fetch is an injected mock and no live
 * host is contacted. The MCP server IS exercised, as a local subprocess over stdio.
 * Exit code 1 if any suite fails.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

// Preflight: the MCP transport suites need compiled output. Fail loudly instead of
// letting them report "no output; stderr: …MODULE_NOT_FOUND" five times over.
const required = 'dist/mcp/server.js';
if (!existsSync(required)) {
  console.error(
    `${required} is missing — the test suite exercises the compiled MCP server.\n` +
      `Run \`npm run build\` (or \`npm test\`, which builds first via pretest), then retry.`,
  );
  process.exit(1);
}

const dir = new URL('.', import.meta.url).pathname;
const root = new URL('..', import.meta.url).pathname;
const files = readdirSync(dir)
  .filter(f => f.endsWith('.test.mjs') || f.endsWith('.test.mts'))
  .sort();

let failedSuites = 0;
const results = [];

for (const file of files) {
  console.log(`\n▶ ${file}`);
  const isTs = file.endsWith('.mts');
  const r = isTs
    ? spawnSync('npx', ['tsx', `${dir}${file}`], { encoding: 'utf8', cwd: root })
    : spawnSync(process.execPath, [`${dir}${file}`], { encoding: 'utf8', cwd: root });
  process.stdout.write(r.stdout ?? '');
  if (r.stderr) process.stderr.write(String(r.stderr).replace(/.*DeprecationWarning.*\n?/g, ''));
  const pass = r.status === 0;
  if (!pass) failedSuites++;
  const summary = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  results.push({ file, pass, summary });
}

console.log('\n' + '─'.repeat(64));
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.file.padEnd(46)} ${r.summary}`);
}
console.log('─'.repeat(64));
console.log(failedSuites ? `${failedSuites} suite(s) failed` : 'all suites passed');
process.exit(failedSuites ? 1 : 0);
