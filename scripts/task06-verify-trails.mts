/**
 * TASK 06 — verify a trail directory and emit a machine-readable report.
 * Read-only. Run: npx tsx scripts/task06-verify-trails.mts <dir> [<dir> ...]
 */

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditTrail } from '../src/audit/trail.js';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: task06-verify-trails.mts <dir> [<dir> ...]');
  process.exit(3);
}

function findTrails(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...findTrails(p));
    else if (name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const report: Record<string, unknown> = {};
let bad = 0;

for (const dir of targets) {
  for (const file of findTrails(dir)) {
    const v = AuditTrail.verify(file, { requireCheckpoint: true });
    report[file] = {
      ok: v.ok,
      events: v.events.length,
      problems: v.problems,
      warnings: v.warnings,
      checkpoint: v.checkpoint,
      head_hash: v.events.length ? v.events[v.events.length - 1]!.hash : null,
    };
    console.log(`${v.ok ? 'OK  ' : 'FAIL'}  ${file}`);
    console.log(`      events=${v.events.length} checkpoint=${v.checkpoint.present ? `${v.checkpoint.count} @ ${String(v.checkpoint.head_hash).slice(0, 12)}…` : 'absent'} matches=${v.checkpoint.matches}`);
    for (const p of v.problems) console.log(`      PROBLEM: ${p}`);
    for (const w of v.warnings) console.log(`      warn   : ${w}`);
    if (!v.ok) bad++;
  }
}

const out = targets[0]!.replace(/\/?$/, '/audit-verification.json');
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`\nreport: ${out}`);
console.log(bad === 0 ? 'ALL TRAILS VERIFIED' : `${bad} trail(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
