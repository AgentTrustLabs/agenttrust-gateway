/**
 * TASK 10 — packaging and clean-checkout reliability regressions.
 *
 * Covers the four defects fixed in this task:
 *   F1  npm run build emits dist/
 *   F2  npm test builds first; run.mjs explains the prerequisite
 *   F3  the demo fails visibly when the compiled server is missing
 *   F6  the CLI entry point never exits 0 having done nothing
 *
 * Tests spawn real subprocesses. The demo's missing-`dist` path is exercised by
 * running it with a temporary working directory, so the repository's own build
 * output is never deleted.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk } from './helpers.mjs';

const ROOT = process.cwd();
const DEMO = join(ROOT, 'scripts', 'task08-demo.mjs');

const tests: [string, () => unknown][] = [];
const test = (name: string, fn: () => unknown) => tests.push([name, fn]);

function run(cmd: string, args: string[], cwd = ROOT): { code: number | null; out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agenttrust-t10-'));
}

// ─── F1: build emits ─────────────────────────────────────────────────────

test('F1.1 the build script emits rather than type-checking only', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  eq(pkg.scripts.build, 'tsc', 'build runs tsc without --noEmit');
  ok(
    typeof pkg.scripts.typecheck === 'string' && pkg.scripts.typecheck.includes('--noEmit'),
    'a separate no-emit type-check script is preserved',
  );
  ok(pkg.scripts.test !== pkg.scripts.typecheck, 'test is not the type-checker');
});

test('F1.2 the compiled entry points exist after a build', () => {
  // The suite runs under `pretest: tsc`, so these must already be present.
  for (const artifact of [
    'dist/mcp/server.js',
    'dist/mcp/tools.js',
    'dist/cli/index.js',
    'dist/cli/verify.js',
    'dist/cli/commerce.js',
  ]) {
    ok(existsSync(join(ROOT, artifact)), `${artifact} exists`);
  }
});

test('F1.3 every declared bin points at a file that exists', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const [name, rel] of Object.entries(pkg.bin as Record<string, string>)) {
    const p = join(ROOT, rel.replace(/^\.\//, ''));
    ok(existsSync(p), `bin ${name} → ${rel} exists`);
    ok(readFileSync(p, 'utf8').startsWith('#!/usr/bin/env node'), `bin ${name} has a shebang`);
  }
});

// ─── F2: test workflow ───────────────────────────────────────────────────

test('F2.1 npm test builds first via pretest', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  ok(typeof pkg.scripts.pretest === 'string', 'pretest is declared');
  ok(pkg.scripts.pretest.includes('tsc'), 'pretest compiles');
});

test('F2.2 run.mjs states the compiled-artifact prerequisite', () => {
  const src = readFileSync(join(ROOT, 'test', 'run.mjs'), 'utf8');
  ok(/dist\/mcp\/server\.js/.test(src), 'names the artifact it needs');
  ok(/npm run build/.test(src), 'tells the reader how to produce it');
  notOk(
    /No network, no chain, no MCP\./.test(src),
    'no longer claims the suite does not exercise MCP',
  );
});

test('F2.3 run.mjs fails loudly, not per-suite, when dist is missing', () => {
  const dir = tempDir();
  try {
    // Copy only the runner, so dist/ genuinely does not exist next to it.
    mkdirSync(join(dir, 'test'), { recursive: true });
    copyFileSync(join(ROOT, 'test', 'run.mjs'), join(dir, 'test', 'run.mjs'));

    const r = run('node', [join(dir, 'test', 'run.mjs')], dir);
    notOk(r.code === 0, 'nonzero exit');
    ok(r.err.includes('dist/mcp/server.js'), `stderr names the missing artifact: ${r.err.slice(0, 120)}`);
    ok(r.err.includes('npm run build'), 'stderr names the fix');
    notOk(/▶/.test(r.out), 'no suite was attempted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── F3: demo fails visibly ──────────────────────────────────────────────

test('F3.1 the demo fails loudly when the compiled server is absent', () => {
  const dir = tempDir();
  try {
    const out = join(dir, 'evidence');
    const r = run('node', [DEMO, '--out', out], dir); // cwd has no dist/
    notOk(r.code === 0, `nonzero exit (got ${r.code})`);
    eq(r.code, 3, 'demo/transport failure code');
    ok(r.err.includes('dist/mcp/server.js not found'), `actionable message: ${r.err.slice(0, 160)}`);
    ok(r.err.includes('npm run build'), 'message says how to fix it');
    ok(!existsSync(out) || readdirSync(out).length === 0, 'no evidence artifact was written');
    notOk(/NO REAL PAYMENT/.test(r.out), 'does not print the success banner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F3.2 the demo treats an early server exit as fatal', () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, 'dist', 'mcp'), { recursive: true });
    // A "server" that dies immediately: no JSON-RPC, no response.
    writeFileSync(join(dir, 'dist', 'mcp', 'server.js'), 'process.exit(1);\n');

    const out = join(dir, 'evidence');
    const r = run('node', [DEMO, '--out', out], dir);
    notOk(r.code === 0, `nonzero exit (got ${r.code})`);
    ok(/exited unexpectedly/.test(r.err), `reports the exit: ${r.err.slice(0, 160)}`);
    ok(!existsSync(out) || readdirSync(out).length === 0, 'no evidence artifact was written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F3.3 the demo has bounded request and shutdown timeouts', () => {
  const src = readFileSync(DEMO, 'utf8');
  ok(/REQUEST_TIMEOUT_MS/.test(src), 'request timeout declared');
  ok(/SHUTDOWN_TIMEOUT_MS/.test(src), 'shutdown timeout declared');
  ok(/timed out after/.test(src), 'timeouts surface as errors');
  ok(/on\('error'/.test(src), 'spawn errors are handled');
  ok(/malformed JSON-RPC/.test(src), 'malformed stdout is a failure');
  ok(/settled !== false/.test(src), 'evidence is re-read and checked for settled=false');
});

// ─── F6: CLI never no-ops ────────────────────────────────────────────────

test('F6.1 direct CLI execution without --owner prints usage and exits 1', () => {
  const r = run('node', [join(ROOT, 'dist', 'cli', 'index.js')]);
  eq(r.code, 1, 'usage error exit code');
  ok(r.err.includes('Usage: agenttrust'), `prints usage: ${r.err.slice(0, 120)}`);
  ok(r.err.includes('--owner'), 'names the missing flag');
});

test('F6.2 direct CLI execution with --owner is not gated on the invoked path', () => {
  const r = run('node', [join(ROOT, 'dist', 'cli', 'index.js'), '--owner', '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d']);
  // It must attempt the registration flow (and fail on the network/registry path),
  // never exit 0 having silently done nothing.
  notOk(r.code === 0 && r.out === '' && r.err === '', 'did not silently no-op');
  ok(r.code !== 0 || r.err.length > 0 || r.out.length > 0, 'produced output or a nonzero exit');
});

test('F6.3 the argv gate is gone from the source', () => {
  const src = readFileSync(join(ROOT, 'src', 'cli', 'index.ts'), 'utf8');
  notOk(/process\.argv\[1\]\?\.includes\('agenttrust'\)/.test(src), 'no path-name gate');
});

// ─── documentation ───────────────────────────────────────────────────────

test('DOC.1 a root README exists and points at the real documentation', () => {
  const p = join(ROOT, 'README.md');
  ok(existsSync(p), 'README.md exists');
  const md = readFileSync(p, 'utf8');
  for (const target of ['docs/MCP-GUIDE.md', 'docs/TASK08-result.md']) {
    ok(md.includes(target), `links ${target}`);
  }
  for (const cmd of ['npm ci', 'npm run build', 'npm test']) {
    ok(md.includes(cmd), `documents \`${cmd}\``);
  }
  ok(/SIMULATED|simulated/.test(md), 'states settlement is simulated');
  ok(/facilitator/i.test(md), 'states the facilitator limitation');
  notOk(/licen[cs]e:?\s*MIT/i.test(md), 'does not invent a license');
});

test('DOC.2 the guide no longer prescribes a no-emit build', () => {
  const md = readFileSync(join(ROOT, 'docs', 'MCP-GUIDE.md'), 'utf8');
  notOk(
    /npm run build\s+# tsc --noEmit/.test(md),
    'setup section does not describe build as --noEmit',
  );
  ok(/npm run typecheck/.test(md) || /tsc --noEmit/.test(md), 'documents the type-check command');
});

// ─── runner ─────────────────────────────────────────────────────────────

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String((e as Error).message).replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\ntask10-packaging: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
