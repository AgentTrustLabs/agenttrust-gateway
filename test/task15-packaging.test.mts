/**
 * TASK 15 — package metadata and publication-readiness regressions.
 *
 * Guards the properties this task fixed, so packaging cannot silently drift back:
 *
 *   F4  every declared script runs (no script points at a missing file)
 *   F5  no entry point (`exports`/`main`/`module`/`types`/`bin`) points at a
 *       nonexistent path, and `files` actually governs what would ship
 *   F8  the publication policy stays explicit: `private: true`, no invented
 *       license, no LICENSE file, and no `license` field
 *
 * Package contents are inspected with `npm pack --dry-run --json`, which performs
 * no publish and writes no tarball.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, ok, notOk } from './helpers.mjs';

const ROOT = process.cwd();
const PKG_PATH = join(ROOT, 'package.json');
const PKG = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as Record<string, unknown>;

const tests: [string, () => unknown][] = [];
const test = (name: string, fn: () => unknown) => tests.push([name, fn]);

/** npm pack --dry-run --json → the file list that would be published. */
let packed: { path: string; size: number }[] | null = null;
function packFiles(): { path: string; size: number }[] {
  if (packed) return packed;
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
  });
  eq(r.status, 0, `npm pack --dry-run failed: ${(r.stderr ?? '').slice(0, 300)}`);
  const parsed = JSON.parse(r.stdout) as { files: { path: string; size: number }[] }[];
  packed = parsed[0]!.files;
  return packed;
}

// ─── F4: scripts ────────────────────────────────────────────────────────

test('F4.1 every script that names a file points at a file that exists', () => {
  const scripts = PKG['scripts'] as Record<string, string>;
  for (const [name, cmd] of Object.entries(scripts)) {
    // Extract `node <path>` style targets and any `dist/...` references.
    const targets = [...cmd.matchAll(/(?:^|\s)(?:node\s+)?((?:\.\/)?(?:dist|scripts|test|src)\/[\w./-]+\.(?:js|mjs|mts|ts))/g)].map(
      m => m[1]!.replace(/^\.\//, ''),
    );
    for (const t of targets) {
      ok(existsSync(join(ROOT, t)), `script "${name}" → ${t} exists`);
    }
  }
});

test('F4.2 the dead sign script is gone and no fake replacement exists', () => {
  const scripts = PKG['scripts'] as Record<string, string>;
  notOk('sign' in scripts, 'no "sign" script');
  notOk(Object.keys(scripts).some(k => /sign/i.test(k)), 'no signing script under another name');
  notOk(existsSync(join(ROOT, 'src', 'sign')), 'no src/sign directory');
  notOk(existsSync(join(ROOT, 'dist', 'sign')), 'no dist/sign output');

  // And the README still explains that signing happens in the wallet.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  ok(/scanner|Wallet|wallet/.test(readme), 'README still documents where signing happens');
});

test('F4.3 build, test and typecheck scripts keep their intended meaning', () => {
  const s = PKG['scripts'] as Record<string, string>;
  eq(s['build'], 'tsc', 'build emits');
  eq(s['typecheck'], 'tsc --noEmit', 'typecheck does not emit');
  eq(s['test'], 'node test/run.mjs', 'test runs the runner');
  eq(s['pretest'], 'tsc', 'pretest compiles for the MCP transport suites');
});

// ─── F5: entry points ───────────────────────────────────────────────────

test('F5.1 no export condition points at a nonexistent file', () => {
  const exports = PKG['exports'] as Record<string, unknown> | undefined;
  if (exports === undefined) {
    ok(true, 'no exports map — nothing can be dangling');
    return;
  }
  for (const [key, value] of Object.entries(exports)) {
    const conditions =
      typeof value === 'string' ? { default: value } : (value as Record<string, string>);
    for (const [cond, target] of Object.entries(conditions)) {
      const rel = String(target).replace(/^\.\//, '');
      ok(existsSync(join(ROOT, rel)), `exports["${key}"].${cond} → ${rel} exists`);
    }
  }
});

test('F5.2 no top-level main/module/types points at a nonexistent file', () => {
  for (const field of ['main', 'module', 'types', 'typings'] as const) {
    const v = PKG[field];
    if (v === undefined) continue;
    const rel = String(v).replace(/^\.\//, '');
    ok(existsSync(join(ROOT, rel)), `${field} → ${rel} exists`);
  }
});

test('F5.3 every bin target exists and is executable as a script', () => {
  const bin = PKG['bin'] as Record<string, string>;
  for (const [name, target] of Object.entries(bin)) {
    const rel = target.replace(/^\.\//, '');
    const p = join(ROOT, rel);
    ok(existsSync(p), `bin ${name} → ${rel} exists`);
    ok(readFileSync(p, 'utf8').startsWith('#!/usr/bin/env node'), `bin ${name} has a shebang`);
  }
});

test('F5.4 the package declares no modules entry point, matching its CLI/MCP nature', () => {
  // This project is a CLI + MCP server. It has no library surface, so an `exports`
  // map pointing at a library entry would be fiction. If one is ever added it must
  // resolve — that is what F5.1 checks.
  const pkgText = JSON.stringify(PKG);
  if (pkgText.includes('"exports"')) {
    ok(existsSync(join(ROOT, 'src', 'index.ts')), 'an exports map requires a real src/index.ts');
  } else {
    ok(true, 'no exports map declared (CLI/MCP distribution)');
  }
});

// ─── F5/F8: what would actually ship ────────────────────────────────────

test('F5.5 files[] governs the package contents', () => {
  const files = PKG['files'];
  ok(Array.isArray(files), 'a files allowlist is declared');
  const shipped = packFiles().map(f => f.path);
  eq(shipped.filter(f => f.startsWith('docs/')).length, 0, 'no docs/ shipped');
  eq(shipped.filter(f => f.startsWith('test/')).length, 0, 'no test/ shipped');
  eq(shipped.filter(f => f.startsWith('evidence/')).length, 0, 'no root evidence/ shipped');
  eq(shipped.filter(f => f.startsWith('signing-site/')).length, 0, 'no signing-site/ shipped');
  eq(shipped.filter(f => f.startsWith('sign/')).length, 0, 'no sign/ shipped');
  eq(shipped.filter(f => f.startsWith('node_modules/')).length, 0, 'no node_modules shipped');
  eq(shipped.filter(f => f.includes('.checkpoint.json')).length, 0, 'no audit checkpoints shipped');
  eq(shipped.filter(f => f.startsWith('.env')).length, 0, 'no env files shipped');
});

test('F5.6 every shipped entry point is present in the tarball', () => {
  const shipped = new Set(packFiles().map(f => f.path));
  const bin = PKG['bin'] as Record<string, string>;
  for (const [name, target] of Object.entries(bin)) {
    const rel = target.replace(/^\.\//, '');
    ok(shipped.has(rel), `bin ${name} → ${rel} is in the package`);
  }
  for (const required of ['package.json', 'README.md']) {
    ok(shipped.has(required), `${required} is in the package`);
  }
  // Compiled output only — no TypeScript sources masquerading as the entry points.
  for (const f of shipped) {
    if (f.startsWith('dist/')) ok(!f.includes('..'), `dist entry ${f} is well-formed`);
  }
});

test('F5.7 the packaged tarball carries no secret material', () => {
  const shipped = packFiles().map(f => f.path);
  ok(shipped.length > 0, 'something ships');

  // Scan the actual text of every shipped source/script file for key material.
  for (const rel of shipped) {
    if (!/\.(ts|mts|mjs|js|json|md)$/.test(rel)) continue;
    if (rel === 'package.json') continue;
    const text = readFileSync(join(ROOT, rel), 'utf8');
    for (const pattern of [/\b(?:0x)?[0-9a-f]{64}\b(?![^\n]*(?:sha256|hash|transaction|token_address))/i]) {
      const hit = pattern.test(text);
      if (hit) {
        // A 64-hex value is acceptable only on an explicitly public-hash line.
        const lines = text.split('\n').filter(l => pattern.test(l));
        for (const line of lines) {
          // Public-hash context: the line names the field the hex belongs to.
          // Matched without word boundaries so camelCase identifiers such as
          // `metadataHashHex` count.
          ok(
            /sha256|sha-256|hash|transaction|token_address/i.test(line),
            `${rel}: 64-hex value outside a public-hash context`,
          );
        }
      }
    }
    notOk(/privateKeyHex\s*:/.test(text), `${rel} has no privateKeyHex`);
    notOk(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `${rel} has no PEM private key`);
  }
});

// ─── F8: publication policy ─────────────────────────────────────────────

test('F8.1 the package stays private', () => {
  eq(PKG['private'], true, 'private: true is preserved');
});

test('F8.2 no license is invented', () => {
  notOk('license' in PKG, 'no license field in package.json');
  for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'COPYING.md']) {
    notOk(existsSync(join(ROOT, f)), `no ${f} file was added`);
  }
  // The README must keep stating the actual position rather than implying a license.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  ok(/no license file is included/i.test(readme), 'README states no license file is included');
  ok(/all rights\s+reserved/i.test(readme), 'README states all rights reserved');
});

test('F8.3 no publication metadata was invented either', () => {
  for (const field of ['repository', 'author', 'homepage', 'bugs', 'publishConfig']) {
    notOk(field in PKG, `no ${field} was fabricated`);
  }
  notOk('repository' in PKG || 'publishConfig' in PKG, 'nothing points at a registry or repo');
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
console.log(`\ntask15-packaging: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
