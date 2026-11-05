/**
 * TASK 07 — read-only facilitator probe. Writes evidence JSON.
 *
 * Only `/supported` is contacted. This script has no code path that reaches
 * `/verify` or `/settle`; the two `/verify` observations recorded in the report
 * were made once by hand with an empty/stub body and are not repeated here.
 *
 *   npx tsx scripts/task07-facilitator-probe.mts <url> [out.json]
 */

import { writeFileSync } from 'node:fs';
import { probeFacilitator, classifyCompatibility } from '../src/payments/facilitator.js';
import { CCD_TESTNET_CAIP2 } from '../src/payments/x402.js';

const url = process.argv[2];
const out = process.argv[3];

if (!url) {
  console.error('usage: task07-facilitator-probe <base-url> [out.json]');
  process.exit(3);
}

const probe = await probeFacilitator({ url, timeoutMs: 15_000 });

const record: Record<string, unknown> = {
  probed_at: new Date().toISOString(),
  base_url: url,
  endpoint: `${url.replace(/\/+$/, '')}/supported`,
  network_under_test: CCD_TESTNET_CAIP2,
  method: 'GET',
  outcome: probe.ok ? 'reachable' : 'unreachable',
  http_status: probe.status,
  elapsed_ms: probe.elapsedMs,
};

if (probe.ok) {
  const compat = classifyCompatibility(probe.body);
  record.kinds = probe.body.kinds;
  record.networks = [...new Set(probe.body.kinds.map(k => k.network))].sort();
  record.schemes = [...new Set(probe.body.kinds.map(k => k.scheme))].sort();
  record.signers = probe.body.signers ? Object.keys(probe.body.signers) : null;
  record.compatibility = {
    usable: compat.usable,
    code: compat.code,
    reason: compat.reason,
    feePayer: compat.feePayer ?? null,
  };
} else {
  record.failure_kind = probe.kind;
  record.error = probe.error;
}

const text = JSON.stringify(record, null, 2);
if (out) {
  writeFileSync(out, text + '\n');
  console.log(`wrote ${out}`);
}
console.log(text);
