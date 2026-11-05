/**
 * TASK 14 — audit trail API strictness (finding S7).
 *
 * Proves the record() contract is fail-closed, that a rejected event leaves no
 * trace (no seq burn, no hash, no checkpoint write), and that the existing
 * chain/checkpoint/lock/secret guarantees still hold.
 */

import { AuditTrail, GENESIS_HASH, canonicalize, eventHash, assertNoSecrets } from '../src/audit/trail.js';
import {
  validateRecordFields,
  assertEventType,
  AuditEventValidationError,
  RECORD_FIELDS,
  AGENT_FIELDS,
  PAYMENT_FIELDS,
} from '../src/audit/validate.js';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk, throws } from './helpers.mjs';

const roots: string[] = [];
function tmp(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t14-'));
  roots.push(dir);
  return { dir, file: join(dir, 'trail.jsonl') };
}

const tests: [string, () => unknown][] = [];
const test = (name: string, fn: () => unknown) => tests.push([name, fn]);

/** Assert the throw came from the strict validator, not from somewhere else. */
function rejects(fn: () => unknown, match: string, label: string): AuditEventValidationError {
  try {
    fn();
  } catch (e) {
    ok(e instanceof AuditEventValidationError, `${label}: expected AuditEventValidationError, got ${(e as Error).name}`);
    ok(
      String((e as Error).message).toLowerCase().includes(match.toLowerCase()),
      `${label}: message lacked "${match}" — got "${(e as Error).message}"`,
    );
    return e as AuditEventValidationError;
  }
  throw new Error(`${label}: expected a rejection, nothing was thrown`);
}

// ─── the defect, reproduced ─────────────────────────────────────────────

test('01. an unknown top-level field is rejected instead of silently dropped', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_s7' });

  // The exact S7 shape: a field the caller believes will be recorded.
  rejects(
    () => t.record('agent.discovered', { outcome: 'PASS', privateKey: 'x' } as never),
    'secret-bearing field',
    'secret-named unknown key',
  );
  rejects(
    () => t.record('agent.discovered', { outcome: 'PASS', note: 'caller thinks this persists' } as never),
    'unknown field',
    'benign unknown key',
  );

  eq(t.all().length, 0, 'nothing was recorded');
  notOk(existsSync(file), 'no file was created');
});

test('02. a rejected event burns no sequence number and no hash', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_seq' });

  t.record('agent.discovered', { outcome: 'PASS', reason: 'first' });
  rejects(() => t.record('agent.discovered', { outcome: 'PASS', bogus: 1 } as never), 'unknown field', 'rejected');
  const third = t.record('agent.discovered', { outcome: 'PASS', reason: 'third' });

  eq(third.seq, 2, 'the rejected call did not consume seq 2');
  eq(t.all().length, 2, 'two events recorded');

  const p = AuditTrail.verify(file, { requireCheckpoint: true });
  ok(p.ok, `chain still valid: ${p.problems.join('; ')}`);
  eq(p.checkpoint.count, 2, 'checkpoint agrees with the two real events');
});

test('03. an event rejected mid-session leaves the file byte-identical', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_bytes' });
  t.record('agent.discovered', { outcome: 'PASS' });
  const before = readFileSync(file, 'utf8');
  const cpBefore = readFileSync(`${file}.checkpoint.json`, 'utf8');

  rejects(() => t.record('agent.discovered', { outcome: 'PASS', smuggled: 'x' } as never), 'unknown field', 'rejected');

  eq(readFileSync(file, 'utf8'), before, 'log unchanged');
  eq(readFileSync(`${file}.checkpoint.json`, 'utf8'), cpBefore, 'checkpoint unchanged');
});

// ─── the contract, field by field ───────────────────────────────────────

test('04. unknown nested fields are rejected in agent and payment', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_nested' });

  rejects(
    () => t.record('agent.discovered', { outcome: 'PASS', agent: { token_id: 1004, extra: 'x' } } as never),
    'unknown field',
    'agent.extra',
  );
  rejects(
    () => t.record('payment.verified', { outcome: 'PASS', payment: { amount: '1', note: 'x' } } as never),
    'unknown field',
    'payment.note',
  );
  rejects(
    () => t.record('payment.verified', { outcome: 'PASS', payment: { privateKey: 'x' } } as never),
    'secret-bearing field',
    'payment.privateKey',
  );
  rejects(
    () => t.record('agent.discovered', { outcome: 'PASS', agent: { seedPhrase: 'x' } } as never),
    'secret-bearing field',
    'agent.seedPhrase',
  );

  eq(t.all().length, 0, 'no partial writes');
});

test('05. the accepted field sets match the documented schema exactly', () => {
  eq(RECORD_FIELDS.join(','), 'outcome,reason,agent,payment,evidence_ref', 'record() fields');
  eq(AGENT_FIELDS.join(','), 'token_id,token_address,owner_account,agent_uri,metadata_sha256', 'agent fields');
  eq(
    PAYMENT_FIELDS.join(','),
    'requirement_id,amount,asset,network,pay_to,payer,transaction',
    'payment fields',
  );
});

test('06. a missing or invalid outcome is rejected', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_outcome' });

  rejects(() => t.record('agent.discovered', {} as never), 'required', 'missing outcome');
  rejects(() => t.record('agent.discovered', { outcome: 'OK' } as never), 'must be one of', 'unknown outcome');
  rejects(() => t.record('agent.discovered', { outcome: 1 } as never), 'must be one of', 'numeric outcome');
  eq(t.all().length, 0, 'nothing recorded');
});

test('07. invalid field types are rejected', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_types' });

  rejects(() => t.record('agent.discovered', { outcome: 'PASS', reason: 42 } as never), 'must be a string', 'reason number');
  rejects(
    () => t.record('agent.discovered', { outcome: 'PASS', evidence_ref: { nested: true } } as never),
    'must be a string',
    'evidence_ref object',
  );
  rejects(
    () => t.record('agent.discovered', { outcome: 'PASS', agent: 'not-an-object' } as never),
    'must be a plain object',
    'agent string',
  );
  rejects(
    () => t.record('agent.discovered', { outcome: 'PASS', agent: [] } as never),
    'must be a plain object',
    'agent array',
  );
  rejects(
    () => t.record('agent.discovered', { outcome: 'PASS', agent: { token_id: '1004' } } as never),
    'must be a number',
    'token_id string',
  );
  rejects(
    () => t.record('payment.verified', { outcome: 'PASS', payment: { amount: 1000 } } as never),
    'must be a string',
    'amount number',
  );
  rejects(() => t.record('agent.discovered', null as never), 'must be a plain object', 'null fields');
  rejects(() => t.record('agent.discovered', [] as never), 'must be a plain object', 'array fields');

  eq(t.all().length, 0, 'nothing recorded');
});

test('08. an unknown event type is rejected', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_type' });

  rejects(() => t.record('agent.discoverd' as never, { outcome: 'PASS' }), 'unknown event type', 'typo');
  rejects(() => t.record('' as never, { outcome: 'PASS' }), 'unknown event type', 'empty');
  rejects(() => t.record(123 as never, { outcome: 'PASS' }), 'must be a string', 'number');
  eq(t.all().length, 0, 'nothing recorded');
});

// ─── valid events still work, unchanged ─────────────────────────────────

test('09. every valid event shape from the orchestrator is accepted', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_valid' });

  const refs = {
    token_id: 1004,
    token_address: 'JyP9YLib1wYgFmztkcKJL',
    owner_account: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    agent_uri: 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json',
    metadata_sha256: '3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564',
  };
  const payment = {
    requirement_id: 'req_1',
    amount: '250000',
    asset: 'CCD',
    network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    pay_to: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    payer: '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8',
    transaction: '5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0',
  };

  t.record('agent.discovered', { outcome: 'PASS', reason: 'found', agent: refs, evidence_ref: 'evidence.discovery' });
  t.record('agent.trust.verified', { outcome: 'PASS', reason: 'all checks pass', agent: refs });
  t.record('payment.requirement.created', { outcome: 'PASS', payment, evidence_ref: 'requirements' });
  t.record('payment.settlement.simulated', { outcome: 'PASS', reason: 'mock', payment });
  t.record('commerce.access.granted', { outcome: 'PASS', reason: 'ok', agent: refs });

  eq(t.all().length, 5, 'all five accepted');
  ok(AuditTrail.verify(file).ok, 'chain valid');
});

test('10. absent optional values behave exactly as before (undefined is "absent")', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_undef' });

  // Callers legitimately pass `cond ? x : undefined`.
  t.record('agent.discovered', { outcome: 'PASS', reason: undefined, agent: undefined, payment: undefined });
  const e = t.all()[0]!;

  notOk('reason' in e, 'reason omitted, not null');
  notOk('agent' in e, 'agent omitted');
  notOk('payment' in e, 'payment omitted');
  eq(canonicalize(e).includes('undefined'), false, 'canonical form has no undefined');
});

test('11. an empty agent/payment object is accepted and serialised as {}', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_empty' });

  t.record('agent.discovered', { outcome: 'INCONCLUSIVE', agent: {} });
  eq(canonicalize(t.all()[0]).includes('"agent":{}'), true, 'empty object preserved');
  ok(AuditTrail.verify(file).ok, 'still verifies');
});

// ─── integrity guarantees unchanged ─────────────────────────────────────

test('12. canonicalization and hashing are untouched', () => {
  // A frozen expectation: if these change, every existing trail breaks.
  eq(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}', 'keys sorted, no whitespace');
  eq(canonicalize([1, { z: 1, a: 2 }]), '[1,{"a":2,"z":1}]', 'arrays keep order, nested objects sorted');
  eq(canonicalize({ a: undefined, b: 1 }), '{"b":1}', 'undefined omitted');
  eq(canonicalize(null), 'null', 'null');

  const event = {
    seq: 1,
    event_id: 'e1',
    timestamp: '2026-11-05T00:00:00.000Z',
    session_id: 'cs',
    type: 'agent.discovered' as const,
    outcome: 'PASS' as const,
    prev_hash: GENESIS_HASH,
    hash: '',
  };
  // Recomputed independently to prove the digest contract is stable.
  const expected = eventHash(event);
  eq(expected.length, 64, 'sha256 hex');
  eq(eventHash({ ...event, hash: 'ignored' }), expected, 'hash field excluded from its own digest');
  eq(eventHash({ ...event, reason: 'x' }) === expected, false, 'content affects the digest');
});

test('13. existing on-disk evidence still verifies byte-for-byte', () => {
  // Historical trails were written before strict validation. They must still verify:
  // verification reads and re-hashes; it does not re-validate input shape.
  for (const f of [
    'docs/evidence/task05/audit-trail.jsonl',
    'docs/evidence/task05/rejections/trust/audit-trail.jsonl',
    'docs/evidence/task05/rejections/payment/audit-trail.jsonl',
  ]) {
    const v = AuditTrail.verify(join(process.cwd(), f), { requireCheckpoint: true });
    ok(v.ok, `${f}: ${v.problems.join('; ')}`);
    ok(v.events.length > 0, `${f}: has events`);
    ok(v.checkpoint.matches === true, `${f}: checkpoint matches`);
  }
});

test('14. a legacy record with a non-string reason still verifies', () => {
  // Old trails may contain shapes the new writer would refuse. Reading them must not
  // throw — only writing new invalid shapes is rejected. Verified against a file with
  // no checkpoint, since the point is shape tolerance, not checkpoint agreement.
  const { dir, file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_legacy' });
  const e = t.record('agent.discovered', { outcome: 'PASS', reason: 'ok' });

  const legacyFile = join(dir, 'legacy.jsonl');
  const tampered = { ...e, reason: 7 } as Record<string, unknown>;
  delete tampered['hash'];
  const resealed = { ...tampered, hash: eventHash(tampered as never) };
  writeFileSync(legacyFile, JSON.stringify(resealed) + '\n');

  const v = AuditTrail.verify(legacyFile, { requireCheckpoint: false });
  ok(v.ok, `legacy shape verifies without shape validation: ${v.problems.join('; ')}`);
  eq((v.events[0] as unknown as { reason: unknown }).reason, 7, 'the legacy value is read back as stored');
});

test('15. concurrent writers keep one chain with strict validation on', async () => {
  const { dir, file } = tmp();
  const { writeFileSync } = await import('node:fs');
  const worker = join(dir, 'w.mjs');
  writeFileSync(
    worker,
    `
import { AuditTrail } from ${JSON.stringify(new URL('../src/audit/trail.ts', import.meta.url).pathname)};
const t = new AuditTrail({ filePath: ${JSON.stringify(file)}, sessionId: process.argv[2] });
for (let i = 0; i < 5; i++) t.record('agent.discovered', { outcome: 'PASS', reason: String(i) });
`,
  );
  const { spawn } = await import('node:child_process');
  const run = (session: string) =>
    new Promise<{ code: number | null; err: string }>(resolve => {
      const p = spawn('npx', ['tsx', worker, session], { cwd: process.cwd() });
      let err = '';
      p.stderr.on('data', d => (err += String(d)));
      p.on('close', code => resolve({ code, err }));
    });

  const [a, b] = await Promise.all([run('cs_s1'), run('cs_s2')]);
  eq(a.code, 0, `writer 1: ${a.err.slice(0, 200)}`);
  eq(b.code, 0, `writer 2: ${b.err.slice(0, 200)}`);

  const v = AuditTrail.verify(file, { requireCheckpoint: true });
  ok(v.ok, `chain valid: ${v.problems.join('; ')}`);
  eq(v.events.length, 10, 'all events landed');
  eq(v.checkpoint.count, 10, 'checkpoint matches');
  notOk(existsSync(`${file}.lock`), 'no lock leaked');
});

test('16. assertNoSecrets is unchanged and still applied to accepted events', () => {
  const { file } = tmp();
  const t = new AuditTrail({ filePath: file, sessionId: 'cs_secrets' });

  // A bare 64-hex value in a non-public field is still refused, by the same guard.
  throws(
    () => t.record('payment.payload.received', { outcome: 'PASS', payment: { payer: 'A'.repeat(64) } }),
    'key material',
    'bare hex refused',
  );
  // Public hash fields are still allowed through.
  t.record('agent.trust.verified', {
    outcome: 'PASS',
    agent: { metadata_sha256: '3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564' },
  });
  t.record('payment.settlement.simulated', {
    outcome: 'PASS',
    payment: { transaction: '5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0' },
  });
  eq(t.all().length, 2, 'public hashes accepted');

  // The guard itself still behaves as documented.
  throws(() => assertNoSecrets({ a: { seedPhrase: 'x' } }), 'secret-bearing field', 'nested secret');
  eq(assertNoSecrets({ ok: 'value' }), undefined, 'clean input passes');
});

test('17. validation is exposed for direct use and matches record()', () => {
  ok(validateRecordFields({ outcome: 'PASS' }) === undefined, 'valid fields accepted');
  rejects(() => validateRecordFields({ outcome: 'PASS', x: 1 }), 'unknown field', 'direct call');
  rejects(() => validateRecordFields(null), 'must be a plain object', 'direct null');
  eq(assertEventType('payment.verified'), undefined, 'known type');
  rejects(() => assertEventType('nope'), 'unknown event type', 'unknown type');
});

test('18. an in-memory trail enforces the same contract', () => {
  const t = new AuditTrail({ sessionId: 'cs_mem' });
  rejects(() => t.record('agent.discovered', { outcome: 'PASS', extra: 1 } as never), 'unknown field', 'in-memory');
  eq(t.all().length, 0, 'nothing stored');
  t.record('agent.discovered', { outcome: 'PASS' });
  eq(t.all().length, 1, 'valid event stored');
  eq(t.toJsonl().trim().split('\n').length, 1, 'jsonl has one line');
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
for (const d of roots) rmSync(d, { recursive: true, force: true });
console.log(`\ntask14-audit-strictness: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
