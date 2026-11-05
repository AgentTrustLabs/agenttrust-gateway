/**
 * Tamper demonstrations for TASK 06 — each case copies a real trail, applies one
 * modification, and shows the verifier's verdict. Never touches the originals.
 *
 * Run: npx tsx scripts/task06-tamper-demo.mts docs/evidence/task05
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AuditTrail, checkpointPathFor, eventHash, GENESIS_HASH, type AuditEvent } from '../src/audit/trail.js';

const SRC_DIR = process.argv[2] ?? 'docs/evidence/task05';
const OUT_DIR = process.argv[3] ?? 'docs/evidence/task06';
const SRC = join(SRC_DIR, 'audit-trail.jsonl');
const SRC_CP = checkpointPathFor(SRC);
const WORK = join(OUT_DIR, 'tamper');

if (!existsSync(SRC)) {
  console.error(`no trail at ${SRC}`);
  process.exit(3);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(l => l.trim());
const events = (f: string) => lines(f).map(l => JSON.parse(l) as AuditEvent);
const put = (f: string, evs: AuditEvent[]) =>
  writeFileSync(f, evs.map(e => JSON.stringify(e)).join('\n') + '\n');

function relink(evs: AuditEvent[]): AuditEvent[] {
  let prev = GENESIS_HASH;
  return evs.map(e => {
    const n = { ...e, prev_hash: prev };
    n.hash = eventHash(n);
    prev = n.hash;
    return n;
  });
}

/** Copy the pristine trail + checkpoint into a case directory. */
function caseDir(name: string): string {
  const d = join(WORK, name);
  mkdirSync(d, { recursive: true });
  const f = join(d, 'audit-trail.jsonl');
  copyFileSync(SRC, f);
  copyFileSync(SRC_CP, checkpointPathFor(f));
  return f;
}

const cases: { name: string; apply: (f: string) => void; expect: string }[] = [
  {
    name: '01-content-modified',
    apply: f => {
      const evs = events(f);
      evs[2]!.reason = 'TAMPERED: reason text replaced';
      put(f, evs);
    },
    expect: 'hash mismatch',
  },
  {
    name: '02-hash-modified',
    apply: f => {
      const evs = events(f);
      evs[1]!.hash = 'f'.repeat(64);
      put(f, evs);
    },
    expect: 'hash mismatch',
  },
  {
    name: '03-link-broken',
    apply: f => {
      const evs = events(f);
      evs[3]!.prev_hash = 'a'.repeat(64);
      put(f, evs);
    },
    expect: 'prev_hash mismatch',
  },
  {
    name: '04-middle-deleted',
    apply: f => {
      const evs = events(f);
      put(f, [evs[0]!, evs[1]!, evs[3]!, evs[4]!]);
    },
    expect: 'prev_hash mismatch + truncated',
  },
  {
    name: '05-event-inserted',
    apply: f => {
      const evs = events(f);
      const forged = relink([{ ...evs[1]!, event_id: '11111111-1111-4111-8111-111111111111', reason: 'INJECTED' }])[0]!;
      put(f, [evs[0]!, evs[1]!, forged, evs[2]!, evs[3]!]);
    },
    expect: 'prev_hash mismatch',
  },
  {
    name: '06-reordered',
    apply: f => {
      const evs = events(f);
      put(f, [evs[0]!, evs[2]!, evs[1]!, ...evs.slice(3)]);
    },
    expect: 'prev_hash mismatch + seq',
  },
  {
    name: '07-tail-truncated',
    apply: f => {
      const evs = events(f);
      put(f, evs.slice(0, 5));
    },
    expect: 'log truncated',
  },
  {
    name: '08-rolled-back-to-valid-prefix',
    apply: f => {
      const raw = readFileSync(f, 'utf8');
      const keep = raw.split('\n').filter(l => l.trim()).slice(0, 4);
      writeFileSync(f, keep.join('\n') + '\n');
    },
    expect: 'log truncated',
  },
  {
    name: '09-checkpoint-deleted',
    apply: f => {
      rmSync(checkpointPathFor(f), { force: true });
    },
    expect: 'checkpoint missing (strict mode)',
  },
  {
    name: '10-checkpoint-corrupted',
    apply: f => {
      writeFileSync(checkpointPathFor(f), '{ this is not json');
    },
    expect: 'checkpoint is not valid JSON',
  },
  {
    name: '11-torn-tail',
    apply: f => {
      writeFileSync(f, readFileSync(f, 'utf8') + '{"seq":9,"event_id":"tru');
    },
    expect: 'not valid JSON',
  },
];

const rows: Record<string, unknown>[] = [];
let unexpected = 0;

console.log('tamper case                        verdict  expected                        problems');
console.log('─'.repeat(112));

for (const c of cases) {
  const f = caseDir(c.name);
  c.apply(f);
  const v = AuditTrail.verify(f, { requireCheckpoint: true });
  const ok = !v.ok;
  if (!ok) unexpected++;
  rows.push({
    case: c.name,
    expected: c.expect,
    detected: !v.ok,
    problems: v.problems,
    warnings: v.warnings,
    checkpoint_present: v.checkpoint.present,
  });
  console.log(
    `${c.name.padEnd(34)} ${(v.ok ? 'PASS  ' : 'REJECT').padEnd(7)} ${c.expect.padEnd(31)} ` +
    `${v.problems[0]?.slice(0, 50) ?? '—'}`,
  );
}

// Honest limitation case: a fully consistent rewrite of log + checkpoint.
{
  const f = caseDir('12-full-rewrite-with-checkpoint');
  const evs = relink(events(f).slice(0, 4));
  put(f, evs);
  writeFileSync(
    checkpointPathFor(f),
    JSON.stringify({
      version: 1,
      count: 4,
      head_hash: evs[3]!.hash,
      updated_at: '2026-11-05T00:00:04.000Z',
      session_id: evs[3]!.session_id,
    }) + '\n',
  );
  const v = AuditTrail.verify(f, { requireCheckpoint: true });
  rows.push({
    case: '12-full-rewrite-with-checkpoint',
    expected: 'UNDETECTABLE by design (documented limitation)',
    detected: !v.ok,
    problems: v.problems,
    note: v.ok
      ? 'verifier accepts: a consistent rewrite of log+checkpoint is outside the threat model'
      : 'unexpectedly rejected',
  });
  console.log(
    `${'12-full-rewrite-with-checkpoint'.padEnd(34)} ${(v.ok ? 'ACCEPT' : 'REJECT').padEnd(7)} ` +
    `${'undetectable by design'.padEnd(31)} ${v.ok ? 'documented limitation' : 'unexpected'}`,
  );
}

writeFileSync(join(WORK, 'tamper-results.json'), JSON.stringify(rows, null, 2) + '\n');
console.log('─'.repeat(112));
console.log(`${cases.length} tamper cases, ${unexpected} unexpected`);
console.log(`results: ${join(WORK, 'tamper-results.json')}`);
process.exit(unexpected === 0 ? 0 : 1);
