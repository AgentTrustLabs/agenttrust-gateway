/**
 * TASK 12 — repository hygiene: ignore rules and evidence integrity.
 *
 * Guards the two properties this task is responsible for, so they cannot silently
 * regress:
 *
 *   1. `.gitignore` excludes dependencies, build output, local secrets and runtime
 *      logs — and nothing else. All source, tests, docs, lockfiles and committed
 *      evidence must remain addable.
 *   2. The placeholder manifest stays labelled and unreferenced by any active
 *      workflow, and committed evidence stays on disk.
 *
 * Ignore rules are checked with `git check-ignore` against a scratch repository, so
 * the assertions test git's actual behaviour rather than a text diff.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk } from './helpers.mjs';

const ROOT = process.cwd();
const GITIGNORE = join(ROOT, '.gitignore');

const tests: [string, () => unknown][] = [];
const test = (name: string, fn: () => unknown) => tests.push([name, fn]);

/** Create a throwaway git repo containing .gitignore plus one file per path given. */
function scratchRepo(paths: string[]): { dir: string; isIgnored: (p: string) => boolean; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t12-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });

  writeFileSync(join(dir, '.gitignore'), readFileSync(GITIGNORE, 'utf8'));
  for (const p of paths) {
    const full = join(dir, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, 'x');
  }

  const isIgnored = (p: string) => {
    const r = spawnSync('git', ['check-ignore', '-q', p], { cwd: dir });
    return r.status === 0;
  };
  return { dir, isIgnored, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── the file exists and is minimal ─────────────────────────────────────

test('01. .gitignore exists and covers the four required categories', () => {
  ok(existsSync(GITIGNORE), '.gitignore exists');
  const text = readFileSync(GITIGNORE, 'utf8');
  ok(/^node_modules\/$/m.test(text), 'dependencies');
  ok(/^dist\/$/m.test(text), 'build output');
  ok(/^\.env$/m.test(text), 'local env file');
  ok(/^\*\.log$/m.test(text), 'runtime logs');

  // Minimal: no blanket catch that would hide source, docs or evidence. `*.log` is
  // the one extension-wide rule, and it is required (see test 04).
  for (const bad of [/^\*$/m, /^docs\/$/m, /^evidence\/$/m, /^\*\*\//m, /^\*\.(json|ts|mts|mjs|md|html)$/m]) {
    notOk(bad.test(text), `no blanket rule matching ${bad}`);
  }
});

test('02. dependencies and build output are ignored', () => {
  const s = scratchRepo(['node_modules/pkg/index.js', 'dist/mcp/server.js', 'dist/cli/verify.js']);
  try {
    ok(s.isIgnored('node_modules/pkg/index.js'), 'node_modules ignored');
    ok(s.isIgnored('dist/mcp/server.js'), 'dist ignored');
    ok(s.isIgnored('dist/cli/verify.js'), 'dist ignored (nested)');
  } finally {
    s.cleanup();
  }
});

test('03. local secrets are ignored but .env.example is not', () => {
  const s = scratchRepo(['.env', '.env.local', '.env.production', '.env.example', 'a.pem', 'a.key']);
  try {
    ok(s.isIgnored('.env'), '.env ignored');
    ok(s.isIgnored('.env.local'), '.env.local ignored');
    ok(s.isIgnored('.env.production'), '.env.production ignored');
    ok(s.isIgnored('a.pem'), 'pem ignored');
    ok(s.isIgnored('a.key'), 'key ignored');

    notOk(s.isIgnored('.env.example'), '.env.example must stay committable');
  } finally {
    s.cleanup();
  }
});

test('04. runtime logs are ignored', () => {
  const s = scratchRepo(['npm-debug.log', 'server.log']);
  try {
    ok(s.isIgnored('npm-debug.log'), 'npm-debug.log ignored');
    ok(s.isIgnored('server.log'), 'arbitrary .log ignored');
  } finally {
    s.cleanup();
  }
});

// ─── nothing legitimate is hidden ───────────────────────────────────────

test('05. source, tests, docs, lockfile and evidence remain addable', () => {
  const paths = [
    'src/audit/trail.ts',
    'src/mcp/server.ts',
    'test/task08-mcp-interface.test.mts',
    'test/fixtures/cis8004-module-schema.bin',
    'docs/TASK08-result.md',
    'docs/evidence/task02/agent-card.v2.json',
    'docs/evidence/task05/audit-trail.jsonl',
    'evidence/healthz.json',
    'sign/tx-manifest.json',
    'signing-site/index.html',
    'scripts/task08-demo.mjs',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'README.md',
    '.gitignore',
  ];
  const s = scratchRepo(paths);
  try {
    for (const p of paths) notOk(s.isIgnored(p), `${p} must not be ignored`);
  } finally {
    s.cleanup();
  }
});

test('06. a real-tree staging dry run stages no generated artifact', () => {
  // Mirrors the tree in a scratch repo (without node_modules) and stages everything.
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t12-stage-'));
  try {
    const tar = spawnSync('bash', ['-c', `tar --exclude=node_modules --exclude=dist -cf - . | (cd ${dir} && tar -xf -)`], {
      cwd: ROOT,
    });
    eq(tar.status, 0, 'tree copied');

    spawnSync('git', ['init', '-q'], { cwd: dir });
    const add = spawnSync('git', ['add', '-A'], { cwd: dir });
    eq(add.status, 0, 'staging succeeded');

    const list = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' })
      .stdout.trim()
      .split('\n')
      .filter(Boolean);

    ok(list.length > 100, `a substantial tree is staged (${list.length} files)`);
    eq(list.filter(f => f.startsWith('node_modules/')).length, 0, 'no node_modules staged');
    eq(list.filter(f => f.startsWith('dist/')).length, 0, 'no dist staged');

    // Evidence and the labelled placeholder survive.
    ok(list.some(f => f.startsWith('docs/evidence/task02/')), 'task02 evidence staged');
    ok(list.some(f => f === 'evidence/healthz.json'), 'root evidence staged');
    ok(list.includes('sign/tx-manifest.json'), 'the labelled placeholder is still tracked');
    ok(list.includes('package-lock.json'), 'lockfile staged');
    ok(list.includes('.gitignore'), '.gitignore itself staged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── evidence integrity ─────────────────────────────────────────────────

test('07. every committed evidence file is still on disk and parses where JSON', () => {
  const dirs = ['docs/evidence', 'evidence'];
  let count = 0;
  for (const d of dirs) {
    const base = join(ROOT, d);
    ok(existsSync(base), `${d} exists`);
    for (const rel of walk(base)) {
      count++;
      const p = join(base, rel);
      // TASK 06 deliberately stores a corrupted checkpoint as tamper evidence; that
      // file is *supposed* to be unparseable and is exempt from the validity check.
      const deliberatelyCorrupt = /10-checkpoint-corrupted|11-torn-tail/.test(rel);
      if (rel.endsWith('.json') && !deliberatelyCorrupt) {
        // Historical evidence must be valid JSON; a parse failure means corruption.
        JSON.parse(readFileSync(p, 'utf8'));
      } else {
        ok(readFileSync(p).length > 0, `${d}/${rel} is non-empty`);
      }
    }
  }
  // 82 files at the time of this task: 72 under docs/evidence, 10 under evidence/.
  // The floor guards against accidental deletion, not against growth.
  ok(count >= 82, `evidence inventory is intact (${count} files)`);
});

test('08. the TASK 02 evidence a test reads is present', () => {
  for (const f of ['docs/evidence/task02/registration-manifest.json', 'docs/evidence/task02/repin-manifest.v2.json']) {
    ok(existsSync(join(ROOT, f)), `${f} exists`);
  }
});

test('09. the placeholder manifest is labelled and still has its markers', () => {
  const p = join(ROOT, 'sign', 'tx-manifest.json');
  ok(existsSync(p), 'file retained');
  const manifest = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

  ok(String(manifest['_status']).includes('PLACEHOLDER'), 'labelled as a placeholder');
  ok(typeof manifest['_note'] === 'string' && manifest['_note'].length > 40, 'explains why it is not usable');
  eq(manifest['_superseded_by'], 'signing-site/registration.json', 'names the live manifest');

  // The original placeholders are untouched — no fabricated transaction data.
  eq(manifest['parameterHex'], 'PARAM_HEX_REPLACE', 'parameterHex still a marker');
  eq(manifest['metadataHashHex'], 'METADATA_HASH_REPLACE', 'metadataHashHex still a marker');
  eq(manifest['agentUri'], 'AGENT_URI_REPLACE', 'agentUri still a marker');
  eq(manifest['cardJson'], 'CARD_JSON_REPLACE', 'cardJson still a marker');
});

test('10. no active script or page reads the placeholder manifest', () => {
  const sources = [...walk(join(ROOT, 'src')).map(f => join('src', f)), ...walk(join(ROOT, 'scripts')).map(f => join('scripts', f))];
  for (const rel of sources) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    notOk(/tx-manifest/.test(src), `${rel} does not reference tx-manifest`);
  }
  // The signing page loads registration.json, not the placeholder.
  const page = readFileSync(join(ROOT, 'signing-site', 'index.html'), 'utf8');
  ok(page.includes('registration.json'), 'the signing page loads the live manifest');
  notOk(page.includes('tx-manifest'), 'and never the placeholder');
});

test('11. the live signing manifest named as the replacement exists', () => {
  ok(existsSync(join(ROOT, 'signing-site', 'registration.json')), 'signing-site/registration.json exists');
  const writer = readFileSync(join(ROOT, 'scripts', 'build-signing-manifest.mjs'), 'utf8');
  ok(writer.includes("writeFileSync('signing-site/registration.json'"), 'and is produced by its documented writer');
});

// ─── runner ─────────────────────────────────────────────────────────────

function walk(base: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(base, rel || '.'), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(base, next));
    else out.push(next);
  }
  return out.sort();
}

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
console.log(`\ntask12-repo-hygiene: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
