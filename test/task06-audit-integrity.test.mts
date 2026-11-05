/**
 * TASK 06 — audit trail integrity, truncation detection, concurrency.
 *
 * Deterministic, offline, temp directories only. Every test constructs a real
 * trail on disk, tampers with it, and asserts the verifier reports it.
 */

import {
  AuditTrail,
  eventHash,
  canonicalize,
  GENESIS_HASH,
  checkpointPathFor,
  withFileLock,
  AuditLockTimeoutError,
  type AuditEvent,
} from '../src/audit/trail.js';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  unlinkSync,
  utimesSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { eq, ok, notOk, throws } from './helpers.mjs';

const roots: string[] = [];
function tmp(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t06-'));
  roots.push(dir);
  return { dir, file: join(dir, 'trail.jsonl') };
}

/** Fixed clock + ids so hashes are reproducible across runs. */
function fixedTrail(file: string, session = 'cs_fixed') {
  let n = 0;
  let t = Date.parse('2026-11-05T00:00:00.000Z');
  return new AuditTrail({
    filePath: file,
    sessionId: session,
    now: () => new Date((t += 1000)),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
}

function writeTrail(file: string, kinds: string[] = ['a', 'b', 'c', 'd', 'e']) {
  const trail = fixedTrail(file);
  for (const k of kinds) {
    trail.record('agent.discovered', { outcome: 'PASS', reason: `step ${k}` });
  }
  return trail;
}

const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(l => l.trim());
const readEvents = (f: string) => lines(f).map(l => JSON.parse(l) as AuditEvent);
const putEvents = (f: string, evs: AuditEvent[]) =>
  writeFileSync(f, evs.map(e => JSON.stringify(e)).join('\n') + '\n');

/** Recompute hash + relink a chain, simulating a competent forger. */
function relink(evs: AuditEvent[]): AuditEvent[] {
  let prev = GENESIS_HASH;
  return evs.map(e => {
    const next = { ...e, prev_hash: prev };
    (next as AuditEvent).hash = eventHash(next);
    prev = next.hash;
    return next;
  });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ─── canonical serialization + chain basics ──────────────────────────────

test('canonical form is stable and key-order independent', () => {
  eq(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}', 'keys sorted');
  eq(canonicalize({ a: 2, b: 1 }), canonicalize({ b: 1, a: 2 }), 'order independent');
  eq(canonicalize([3, 1, 2]), '[3,1,2]', 'arrays keep order');
  eq(canonicalize({ x: undefined, y: 1 }), '{"y":1}', 'undefined omitted, not null');
  eq(canonicalize({ n: null }), '{"n":null}', 'null preserved');
  eq(canonicalize('é'), '"é"', 'strings JSON-escaped');
});

test('a fresh trail chains correctly and verifies', () => {
  const { file } = tmp();
  writeTrail(file);
  const evs = readEvents(file);
  eq(evs.length, 5, 'five events');
  eq(evs[0].prev_hash, GENESIS_HASH, 'first links to genesis');
  for (let i = 1; i < evs.length; i++) eq(evs[i].prev_hash, evs[i - 1].hash, `link ${i}`);
  for (const e of evs) eq(eventHash(e), e.hash, 'self hash');

  const v = AuditTrail.verify(file);
  ok(v.ok, `should verify: ${v.problems.join('; ')}`);
  eq(v.problems.length, 0, 'no problems');
  eq(v.checkpoint.present, true, 'checkpoint written');
  eq(v.checkpoint.matches, true, 'checkpoint matches');
});

test('hashes are deterministic for identical input', () => {
  const a = tmp();
  const b = tmp();
  writeTrail(a.file);
  writeTrail(b.file);
  eq(readFileSync(a.file, 'utf8'), readFileSync(b.file, 'utf8'), 'byte-identical trails');
});

// ─── required tamper cases ───────────────────────────────────────────────

test('1. modified event content is detected', () => {
  const { file } = tmp();
  writeTrail(file);
  const evs = readEvents(file);
  evs[2].reason = 'tampered reason';
  putEvents(file, evs);
  const v = AuditTrail.verify(file);
  notOk(v.ok, 'must fail');
  ok(v.problems.some(p => p.includes('hash mismatch')), `problems: ${v.problems.join('; ')}`);
});

test('2. modified event hash is detected', () => {
  const { file } = tmp();
  writeTrail(file);
  const evs = readEvents(file);
  evs[1].hash = 'f'.repeat(64);
  putEvents(file, evs);
  const v = AuditTrail.verify(file);
  notOk(v.ok, 'must fail');
  ok(v.problems.some(p => p.includes('hash mismatch')), 'hash mismatch reported');
});

test('3. broken previous-hash link is detected', () => {
  const { file } = tmp();
  writeTrail(file);
  const evs = readEvents(file);
  evs[3].prev_hash = 'a'.repeat(64);
  putEvents(file, evs);
  const v = AuditTrail.verify(file);
  notOk(v.ok, 'must fail');
  ok(v.problems.some(p => p.includes('prev_hash mismatch')), `problems: ${v.problems.join('; ')}`);
});

test('4. deleted middle event is detected', () => {
  const { file } = tmp();
  writeTrail(file);
  const evs = readEvents(file);
  putEvents(file, [evs[0], evs[1], evs[3], evs[4]]);
  const v = AuditTrail.verify(file);
  notOk(v.ok, 'must fail');
  ok(v.problems.some(p => p.includes('prev_hash mismatch')), 'link break at the gap');
  ok(v.problems.some(p => p.includes('seq')), 'sequence gap also reported');
  ok(v.problems.some(p => p.includes('truncated') || p.includes('count')), 'checkpoint count mismatch');
});

test('5. inserted event is detected', () => {
  const { file } = tmp();
  writeTrail(file);
  const evs = readEvents(file);
  const forged = relink([{ ...evs[1], event_id: '11111111-1111-4111-8111-111111111111', reason: 'injected' }])[0];
  putEvents(file, [evs[0], evs[1], forged, evs[2], evs[3], evs[4]]);
  const v = AuditTrail.verify(file);
  notOk(v.ok, 'must fail');
  ok(v.problems.length > 0, 'reported');
});

test('6. reordered events are detected', () => {
  const { file } = tmp();
  writeTrail(file);
  const evs = readEvents(file);
  putEvents(file, [evs[0], evs[2], evs[1], evs[3], evs[4]]);
  const v = AuditTrail.verify(file);
  notOk(v.ok, 'must fail');
  ok(v.problems.some(p => p.includes('prev_hash mismatch') || p.includes('seq')), 'order violation reported');
});

test('7. truncated log is detected via the checkpoint', () => {
  const { file } = tmp();
  writeTrail(file);
  const evs = readEvents(file);
  putEvents(file, evs.slice(0, 3));
  const v = AuditTrail.verify(file);
  notOk(v.ok, 'must fail');
  ok(v.problems.some(p => p.includes('truncated')), `problems: ${v.problems.join('; ')}`);
});

test('8. log replaced with an older valid prefix is detected', () => {
  const { file } = tmp();
  writeTrail(file, ['a', 'b', 'c']);
  // capture a genuinely valid 2-event prefix
  const prefix = lines(file).slice(0, 2);
  const later = fixedTrail(file, 'cs_fixed');
  later.record('agent.discovered', { outcome: 'PASS', reason: 'step d' });
  later.record('agent.discovered', { outcome: 'PASS', reason: 'step e' });
  eq(lines(file).length, 5, 'log grew to 5');

  // Roll back to the earlier, internally valid prefix.
  writeFileSync(file, prefix.join('\n') + '\n');
  const v = AuditTrail.verify(file);
  notOk(v.ok, 'rollback must be detected');
  ok(v.problems.some(p => p.includes('truncated')), 'checkpoint still vouches for 5');
});

test('9a. missing checkpoint is a problem when required, a warning otherwise', () => {
  const { file } = tmp();
  writeTrail(file);
  unlinkSync(checkpointPathFor(file));

  const strict = AuditTrail.verify(file, { requireCheckpoint: true });
  notOk(strict.ok, 'strict mode fails');
  ok(strict.problems.some(p => p.includes('checkpoint missing')), 'reported');

  const loose = AuditTrail.verify(file);
  ok(loose.ok, 'chain alone still verifies');
  ok(loose.warnings.some(w => w.includes('truncation is undetectable')), 'limitation surfaced');
});

test('9b. corrupted checkpoint is detected', () => {
  const { file } = tmp();
  writeTrail(file);
  writeFileSync(checkpointPathFor(file), '{ not json');
  const v = AuditTrail.verify(file);
  notOk(v.ok, 'must fail');
  ok(v.problems.some(p => p.includes('checkpoint is not valid JSON')), 'reported');
});

test('9c. malformed checkpoint is detected', () => {
  const { file } = tmp();
  writeTrail(file);
  writeFileSync(checkpointPathFor(file), JSON.stringify({ version: 1 }));
  const v = AuditTrail.verify(file);
  notOk(v.ok, 'must fail');
  ok(v.problems.some(p => p.includes('malformed')), 'reported');
});

test('10. interrupted checkpoint update is a warning, not a false alarm', () => {
  const { file } = tmp();
  writeTrail(file, ['a', 'b']);
  // Simulate: event appended, checkpoint write never happened.
  const trail = new AuditTrail({ filePath: file, sessionId: 'cs_fixed' });
  const before = readFileSync(checkpointPathFor(file), 'utf8');
  // append manually to mimic a crash between append and checkpoint
  const evs = readEvents(file);
  const extra = { ...evs[1], seq: 3, event_id: '22222222-2222-4222-8222-222222222222' };
  extra.prev_hash = evs[1].hash;
  extra.hash = eventHash(extra);
  writeFileSync(file, lines(file).join('\n') + '\n' + JSON.stringify(extra) + '\n');
  eq(readFileSync(checkpointPathFor(file), 'utf8'), before, 'checkpoint untouched');

  const v = AuditTrail.verify(file);
  ok(v.ok, `chain intact, only checkpoint lagging: ${v.problems.join('; ')}`);
  ok(v.warnings.some(w => w.includes('checkpoint lag')), 'lag surfaced as a warning');

  const cp = AuditTrail.refreshCheckpoint(file);
  eq(cp.count, 3, 'checkpoint re-anchored');
  const v2 = AuditTrail.verify(file);
  ok(v2.ok, 'verifies after repair');
  eq(v2.checkpoint.matches, true, 'matches');
});

test('10b. a torn tail line is detected, not silently ignored', () => {
  const { file } = tmp();
  writeTrail(file);
  const content = readFileSync(file, 'utf8');
  writeFileSync(file, content + '{"seq":6,"event_id":"trunc');
  const v = AuditTrail.verify(file);
  notOk(v.ok, 'must fail');
  ok(v.problems.some(p => p.includes('not valid JSON')), 'torn write reported');
});

test('10c. refreshCheckpoint refuses to launder a broken chain', () => {
  const { file } = tmp();
  writeTrail(file);
  const evs = readEvents(file);
  evs[2].reason = 'tampered';
  putEvents(file, evs);
  throws(() => AuditTrail.refreshCheckpoint(file), 'chain is broken', 'must refuse');
});

// ─── concurrency ─────────────────────────────────────────────────────────

test('11. two concurrent writers produce one continuous chain', async () => {
  const { dir, file } = tmp();
  const worker = join(dir, 'writer.mjs');
  writeFileSync(
    worker,
    `
import { AuditTrail } from '${new URL('../src/audit/trail.ts', import.meta.url).pathname}';
const t = new AuditTrail({ filePath: ${JSON.stringify(file)}, sessionId: process.argv[2] });
for (let i = 0; i < 8; i++) t.record('agent.discovered', { outcome: 'PASS', reason: String(i) });
`,
  );

  // Genuinely simultaneous: both processes start before either finishes.
  const { spawn } = await import('node:child_process');
  const run = (session: string) =>
    new Promise<{ code: number | null; err: string }>(resolve => {
      const p = spawn('npx', ['tsx', worker, session], { cwd: process.cwd() });
      let err = '';
      p.stderr.on('data', d => (err += String(d)));
      p.on('close', code => resolve({ code, err }));
    });

  const [a, b] = await Promise.all([run('cs_w1'), run('cs_w2')]);
  eq(a.code, 0, `writer 1 failed: ${a.err.slice(0, 300)}`);
  eq(b.code, 0, `writer 2 failed: ${b.err.slice(0, 300)}`);

  const v = AuditTrail.verify(file);
  ok(v.ok, `chain broken after real concurrency: ${v.problems.join('; ')}`);
  eq(v.events.length, 16, 'all 16 events landed');
  eq(v.checkpoint.count, 16, 'checkpoint anchored at the true head');
  for (const s of ['cs_w1', 'cs_w2']) {
    const seqs = v.events.filter(e => e.session_id === s).map(e => e.seq).sort((x, y) => x - y);
    eq(seqs.join(','), '1,2,3,4,5,6,7,8', `${s} sequences intact, no duplicates`);
  }
  notOk(existsSync(`${file}.lock`), 'no lock left behind');
});

test('12. lock timeout surfaces as a hard error, never an unsafe write', () => {
  const { dir, file } = tmp();
  writeTrail(file, ['a']);
  // Hold the lock from this process and try to take it with a tiny timeout.
  const lockPath = `${file}.lock`;
  // A well-formed lock owned by a LIVE process (this one).
  writeFileSync(lockPath, JSON.stringify({
    v: 1, token: 'held-by-test', pid: process.pid, host: hostname(), acquired_at: new Date().toISOString(),
  }));
  try {
    const err = throws(
      () => withFileLock(file, { timeoutMs: 120, staleMs: 60_000, retryMs: 10 }, () => 'never'),
      'audit lock timeout',
      'must throw',
    );
    ok(err instanceof AuditLockTimeoutError, 'typed error');
  } finally {
    unlinkSync(lockPath);
  }
  // No event was written by the failed attempt.
  eq(lines(file).length, 1, 'log unchanged');
});

test('12b. a stale lock is broken, not respected forever', () => {
  const { file } = tmp();
  writeTrail(file, ['a']);
  const lockPath = `${file}.lock`;
  // Provably dead owner on this host, with an old mtime.
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  eq(dead.status, 0, 'spawned helper exited');
  writeFileSync(lockPath, JSON.stringify({
    v: 1, token: 'abandoned', pid: 2147483646, host: hostname(), acquired_at: '2000-01-01T00:00:00.000Z',
  }));
  utimesSync(lockPath, new Date('2000-01-01T00:00:00.000Z'), new Date('2000-01-01T00:00:00.000Z'));
  const out = withFileLock(file, { timeoutMs: 500, staleMs: 50, retryMs: 10 }, () => 'acquired');
  eq(out, 'acquired', 'stale lock broken');
  notOk(existsSync(lockPath), 'lock released');
});

test('12c. a failed append leaves no checkpoint/log divergence', () => {
  const { file } = tmp();
  writeTrail(file, ['a', 'b']);
  const before = readFileSync(file, 'utf8');
  const cpBefore = readFileSync(checkpointPathFor(file), 'utf8');

  // Poison the lock with unreadable content: ownership cannot be established,
  // so the append must fail closed rather than delete it.
  writeFileSync(`${file}.lock`, '{ not a lock record');
  try {
    const t = new AuditTrail({ filePath: file, sessionId: 'cs_x', lock: { timeoutMs: 80, retryMs: 10, staleMs: 60_000 } });
    throws(
      () => t.record('agent.discovered', { outcome: 'PASS' }),
      'cannot be reclaimed safely',
      'append refused',
    );
  } finally {
    unlinkSync(`${file}.lock`);
  }
  eq(readFileSync(file, 'utf8'), before, 'log untouched');
  eq(readFileSync(checkpointPathFor(file), 'utf8'), cpBefore, 'checkpoint untouched');
  ok(AuditTrail.verify(file).ok, 'trail still verifies');
});

// ─── secret redaction still holds ────────────────────────────────────────

test('13. secret redaction still blocks key material with the chain in place', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_secret' });
  throws(
    () => t.record('payment.payload.received', { outcome: 'PASS', payment: { payer: 'A'.repeat(64) } }),
    'key material',
    'bare hex refused',
  );
  throws(
    () => t.record('payment.payload.received', { outcome: 'PASS', reason: 'x', agent: { privateKey: 'x' } as never }),
    'secret-bearing field',
    'forbidden field refused',
  );
  // Nothing was written by the refused calls.
  notOk(existsSync(file), 'no log created by refused events');
  // Public hashes are still allowed and chained.
  const e = t.record('payment.settlement.simulated', { outcome: 'PASS', payment: { transaction: 'B'.repeat(64) } });
  ok(e.hash.length === 64, 'event hashed');
  ok(AuditTrail.verify(file).ok, 'verifies');
});

test('13b. checkpoint content carries no secrets', () => {
  const { file } = tmp();
  writeTrail(file);
  const cp = readFileSync(checkpointPathFor(file), 'utf8');
  ok(cp.length < 400, 'checkpoint is compact');
  for (const needle of ['reason', 'agent', 'payment', 'signedTransaction']) {
    notOk(cp.includes(needle), `checkpoint must not embed ${needle}`);
  }
});

// ─── compatibility with TASK 05 ──────────────────────────────────────────

test('14. TASK 05 commerce run still produces a verifiable chained trail', async () => {
  const { runCommerce } = await import('../src/commerce/orchestrator.js');
  const { CCD_TESTNET_CAIP2, X402_VERSION } = await import('../src/payments/x402.js');
  const { readFileSync: rf } = await import('node:fs');

  const FIX = new URL('./fixtures/task03/', import.meta.url).pathname;
  const card = new Uint8Array(rf(`${FIX}agent-card.raw.json`));
  const search = JSON.parse(rf(`${FIX}discovery-search.raw.json`, 'utf8'));

  const { file } = tmp();
  const audit = new AuditTrail({ filePath: file, sessionId: 'cs_task05_compat' });

  const facilitator = {
    async verify() { return { isValid: true, payer: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d' }; },
    async settle(_p: unknown, r: { network: string }) {
      return { success: true, transaction: 'c'.repeat(64), network: r.network };
    },
    async getSupported() { return { kinds: [{ x402Version: X402_VERSION, scheme: 'exact', network: CCD_TESTNET_CAIP2 }] }; },
  };

  const result = await runCommerce(
    { mcpBase: 'https://registry.invalid', network: 'testnet', caip2: CCD_TESTNET_CAIP2, cis8004: '12802.0', cis8: '12801.0' },
    { tokenId: 1004 },
    { resourceUrl: 'https://provider.invalid/p', amountMicroCcd: '250000' },
    {
      fetchImpl: (async () => ({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        arrayBuffer: async () => card.buffer.slice(card.byteOffset, card.byteOffset + card.byteLength),
      })) as never,
      facilitator: facilitator as never,
      createPaymentPayload: async req => ({
        x402Version: 2, accepted: req,
        payload: { signedTransaction: { version: 1, header: { sender: 'x', nonce: 1, expiry: Math.floor(Date.now() / 1000) + 300, sponsor: { account: 'x', numSignatures: 1 } }, payload: {}, signatures: { sender: {}, sponsor: {} } } },
      }) as never,
      discover: async () => search,
      contractInfo: async () => ({ cis8004_contract: { index: 12802, subindex: 0 }, cis8_contract: { index: 12801, subindex: 0 } }),
      audit,
    },
  );

  ok(result.granted, `commerce failed: ${result.reason}`);
  const v = AuditTrail.verify(file);
  ok(v.ok, `trail invalid: ${v.problems.join('; ')}`);
  eq(v.events.length, 8, 'same 8 events as TASK 05');
  eq(
    v.events.map(e => e.type).join(','),
    'agent.discovered,agent.card.retrieved,agent.trust.verified,payment.requirement.created,' +
    'payment.payload.received,payment.verified,payment.settlement.simulated,commerce.access.granted',
    'event order unchanged',
  );
  eq(v.events[0].prev_hash, GENESIS_HASH, 'chain starts at genesis');
});

// ─── threat-model honesty ────────────────────────────────────────────────

test('forgery of the whole log plus checkpoint is NOT detected — documented limit', () => {
  const { file } = tmp();
  writeTrail(file);
  // A fully competent attacker rewrites both files consistently.
  const evs = relink(readEvents(file).slice(0, 3));
  putEvents(file, evs);
  writeFileSync(
    checkpointPathFor(file),
    JSON.stringify({
      version: 1, count: 3, head_hash: evs[2].hash,
      updated_at: '2026-11-05T00:00:03.000Z', session_id: 'cs_fixed',
    }) + '\n',
  );
  // Verification passes: this is the honest limitation of a co-located checkpoint.
  const v = AuditTrail.verify(file);
  ok(v.ok, 'documented: a consistent rewrite of log+checkpoint is undetectable here');
});

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e.message).replace(/\n/g, '\n       ')}`);
  }
}
for (const d of roots) rmSync(d, { recursive: true, force: true });
console.log(`\ntask06-audit-integrity: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
