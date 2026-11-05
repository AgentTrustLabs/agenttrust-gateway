/**
 * TASK 11 — secret-exposure hardening regressions.
 *
 * Synthetic secrets only. Nothing here generates, requests, or uses a real key,
 * and no test touches the network (the probe is run with --no-faucet).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact, redactJson, REDACTED } from '../src/core/redact.js';
import { assertNoSecrets, AuditTrail } from '../src/audit/trail.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { eq, ok, notOk, throws } from './helpers.mjs';

const ROOT = process.cwd();
const PROBE = join(ROOT, 'scripts', 'probe-agent-account.mjs');

/** Obviously-fake secret material. Never a real credential. */
const FAKE_PRIVKEY = 'a'.repeat(64);
const FAKE_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const FAKE_TOKEN = 'ghp_thisIsNotARealTokenJustFixtureText000000';

const tests: [string, () => unknown][] = [];
const test = (name: string, fn: () => unknown) => tests.push([name, fn]);

// ─── F13: the probe script ──────────────────────────────────────────────

test('01. the probe never prints a private key field or value', () => {
  const r = spawnSync('node', [PROBE, '--no-faucet'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  eq(r.status, 0, `probe exit 0 (stderr: ${r.stderr.slice(0, 200)})`);
  eq(r.stderr, '', 'probe writes nothing to stderr');

  notOk(/privateKeyHex/i.test(r.stdout), 'no privateKeyHex anywhere in stdout');
  notOk(/privKey|privRaw|secretKey|seedPhrase/i.test(r.stdout), 'no other secret-shaped field name');

  const parsed = JSON.parse(r.stdout.slice(0, r.stdout.indexOf('\n}') + 2)) as Record<string, unknown>;
  eq(parsed['privateKeyPrinted'], false, 'self-reports that no key was printed');
  eq(parsed['privateKeyPersisted'], false, 'self-reports that no key was written');

  // Every 64-hex run in the output must be the PUBLIC key, nothing else.
  const hexes = [...r.stdout.matchAll(/\b[0-9a-f]{64}\b/gi)].map(m => m[0]);
  const pub = String(parsed['publicKeyHex']);
  eq(pub.length, 64, 'public key is present and is a 64-hex value');
  for (const h of hexes) {
    eq(h.toLowerCase(), pub.toLowerCase(), 'the only 64-hex value emitted is the public key');
  }
});

test('02. the probe still emits the diagnostics it exists for', () => {
  const r = spawnSync('node', [PROBE, '--no-faucet'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  const parsed = JSON.parse(r.stdout.slice(0, r.stdout.indexOf('\n}') + 2)) as Record<string, unknown>;

  const address = String(parsed['address']);
  ok(/^[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(address), `a base58 account address is printed: ${address}`);
  eq(parsed['addressLength'], address.length, 'address length reported');
  eq(String(parsed['publicKeyHex']).length, 64, 'public key reported');
  ok(r.stdout.includes('faucet: skipped'), 'faucet skip is reported when --no-faucet is used');
});

test('03. the probe never exports the private half at all', () => {
  const src = readFileSync(PROBE, 'utf8');
  notOk(/privateKey\.export/.test(src), 'does not export the private key');
  notOk(/pkcs8/.test(src), 'does not touch PKCS#8');
  notOk(/privRaw/.test(src), 'no private-key byte buffer');
  ok(/generateKeyPairSync/.test(src), 'still generates the keypair it needs for the address');
});

// ─── redaction primitive ────────────────────────────────────────────────

test('04. redaction strips secret-named fields at any depth', () => {
  const payload = {
    ok: true,
    privateKey: FAKE_PRIVKEY,
    seedPhrase: FAKE_MNEMONIC,
    apiKey: FAKE_TOKEN,
    nested: {
      deeper: {
        signerKey: FAKE_PRIVKEY,
        credential: { password: 'hunter2', bearer: FAKE_TOKEN },
      },
    },
  };
  const out = redactJson(payload);
  notOk(out.includes(FAKE_PRIVKEY), 'private key gone');
  notOk(out.includes('hunter2'), 'password gone');
  notOk(out.includes(FAKE_TOKEN), 'api token gone');
  notOk(out.toLowerCase().includes('legal winner'), 'mnemonic gone');
  ok(out.includes(REDACTED), 'redaction is marked, not silently blanked');
  ok(out.includes('"ok":true'), 'non-secret fields survive');
});

test('05. redaction strips secret-shaped values even under a neutral field name', () => {
  const out = redactJson({ note: FAKE_PRIVKEY, words: FAKE_MNEMONIC, label: 'hello' });
  notOk(out.includes(FAKE_PRIVKEY), 'a bare 64-hex value is redacted');
  notOk(out.includes('legal winner'), 'a bare mnemonic string is redacted');
  ok(out.includes('hello'), 'ordinary text survives');
});

test('06. redaction preserves every public identifier', () => {
  const publicIds = {
    sender: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
    payTo: '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8',
    transaction: '5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0',
    metadata_hash_hex: '3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564',
    sha256: '3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564',
    prev_hash: 'e1299b4e1de23375342f4d2de6d19858d5d02217b4a87a526aa06deb539fc1fc',
    head_hash: '141b7882374148a72e87f36d2006bbd63fab1680be00eff46efca8ea3cbe4b65',
    token_address: 'JyP9YLib1wYgFmztkcKJL',
    agent_uri: 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json',
    network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    token_id: 1004,
    session_id: 'cs_abc123',
  };
  const out = redactJson(publicIds);
  for (const [k, v] of Object.entries(publicIds)) {
    ok(out.includes(String(v)), `public identifier ${k} is preserved`);
  }
  notOk(out.includes(REDACTED), 'nothing public was redacted');
});

test('07. nested secret-bearing error objects cannot bypass redaction', () => {
  // The realistic shape: an upstream error that attached the offending request.
  const err = Object.assign(new Error('upstream rejected the call'), {
    code: 'BAD_REQUEST',
    request: {
      headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'content-type': 'application/json' },
      body: { privateKey: FAKE_PRIVKEY, amount: '250000' },
    },
    cause: { secret: FAKE_PRIVKEY, mnemonic: FAKE_MNEMONIC },
  });

  const out = redactJson(err);
  notOk(out.includes(FAKE_TOKEN), 'bearer token gone');
  notOk(out.includes(FAKE_PRIVKEY), 'nested private key gone');
  notOk(out.includes('legal winner'), 'nested mnemonic gone');
  ok(out.includes('upstream rejected the call'), 'error message preserved for debugging');
  ok(out.includes('BAD_REQUEST'), 'error classification preserved');
  ok(out.includes('250000'), 'non-secret request detail preserved');
});

test('08. arrays and deep nesting are handled without leaking', () => {
  const payload = {
    attempts: [
      { n: 1, key: FAKE_PRIVKEY },
      { n: 2, tokens: [FAKE_TOKEN, 'plain'] },
      { n: 3, label: 'plain' },
    ],
    a: { b: { c: { d: { e: { f: { g: FAKE_PRIVKEY } } } } } },
  };
  const out = redactJson(payload);
  notOk(out.includes(FAKE_PRIVKEY), 'no key from arrays or depth');
  notOk(out.includes(FAKE_TOKEN), 'no token from arrays');
  // A field literally named `tokens` is treated as secret-bearing wholesale, so
  // 'plain' inside it is expected to go too; a neutrally-named sibling proves the
  // array walk itself is not over-redacting.
  ok(out.includes('"plain"'), 'plain values under neutral field names survive');
});

test('09. redaction never throws on hostile input', () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic['self'] = cyclic;

  eq(redactJson(cyclic).includes('[CIRCULAR]'), true, 'cycles are reported, not thrown');
  eq(redactJson(undefined), 'null', 'undefined serialises safely');
  eq(redactJson(() => 1), '"[FUNCTION]"', 'functions are not stringified');
  eq(redactJson(Symbol('x')), '"[SYMBOL]"', 'symbols are not stringified');
  eq(redact(BigInt(5)), '5', 'bigint becomes a string');
  ok(redactJson({ big: 1n ** 70n }).includes('big'), 'large bigints survive');
});

test('10. redaction output is bounded', () => {
  const out = redactJson({ blob: 'x'.repeat(10_000) }, 100);
  ok(out.length <= 130, `length is bounded (got ${out.length})`);
  ok(out.endsWith('…[truncated]'), 'truncation is marked');
});

// ─── existing protections must remain intact ────────────────────────────

test('11. audit assertNoSecrets still rejects secret-bearing events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t11-'));
  try {
    const trail = new AuditTrail({ filePath: join(dir, 'trail.jsonl'), sessionId: 'cs_t11' });

    throws(() => trail.record('payment.payload.received', { outcome: 'PASS', payment: { payer: FAKE_PRIVKEY } } as never),
      'raw key material', 'a raw 64-hex value is refused');
    // record() copies a fixed field set, so an unknown top-level key never reaches
    // assertNoSecrets(); strict validation (TASK 14) now rejects it earlier. The
    // reachable secret path in either design is a secret-named key inside agent/payment.
    throws(() => trail.record('payment.payload.received', {
      outcome: 'PASS',
      payment: { privateKey: 'x' } as never,
    } as never), 'secret-bearing field', 'a secret-named field inside payment is refused');
    throws(() => assertNoSecrets({ a: { b: { seedPhrase: 'x' } } }) as never,
      'secret-bearing field', 'nested secret field is refused');

    // Public values still pass.
    trail.record('agent.trust.verified', {
      outcome: 'PASS',
      agent: { metadata_sha256: '3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564' },
      payment: { transaction: '5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0' },
    });
    eq(trail.all().length, 1, 'the public event was accepted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('12. the audit trail still contains no secrets after a normal run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t11b-'));
  try {
    const file = join(dir, 'trail.jsonl');
    const trail = new AuditTrail({ filePath: file, sessionId: 'cs_t11b' });
    trail.record('agent.discovered', { outcome: 'PASS', agent: { token_id: 1004 } });
    trail.record('commerce.access.granted', { outcome: 'PASS', reason: 'all gates passed' });

    const raw = readFileSync(file, 'utf8');
    for (const bad of [/privateKey/i, /seedPhrase/i, /mnemonic/i, /bearer /i, /\b[0-9a-f]{128}\b/i]) {
      notOk(bad.test(raw), `trail is free of ${bad}`);
    }
    ok(AuditTrail.verify(file).ok, 'trail still verifies');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── source scan: no output path reintroduces an unredacted dump ────────

test('13. no confirmed private-key output path remains in the source tree', () => {
  const files = [
    'src/cli/index.ts',
    'src/cli/verify.ts',
    'src/cli/commerce.ts',
    'src/mcp/tools.ts',
    'src/mcp/server.ts',
    'src/audit/trail.ts',
    'src/payments/x402.ts',
    'src/payments/x402Sdk.ts',
    'src/payments/facilitator.ts',
    'src/payments/operatorSigning.ts',
    'scripts/probe-agent-account.mjs',
    'scripts/task08-demo.mjs',
  ];
  for (const f of files) {
    const p = join(ROOT, f);
    ok(existsSync(p), `${f} exists`);
    const src = readFileSync(p, 'utf8');
    for (const pattern of [
      /privateKeyHex\s*:/,
      /privRaw/,
      /\.privateKey\.export/,
      /console\.(log|error|warn)\(\s*JSON\.stringify\(\s*process\.env/,
      /console\.(log|error|warn)\(\s*process\.env\b/,
    ]) {
      notOk(pattern.test(src), `${f} has no match for ${pattern}`);
    }
  }
});

test('14. no module prints a whole environment object', () => {
  for (const dir of ['src', 'scripts']) {
    for (const f of readdir(join(ROOT, dir))) {
      const p = join(ROOT, dir, f);
      const src = readFileSync(p, 'utf8');
      notOk(
        /console\.(log|error|warn)\([^)]*\bprocess\.env\b(?!\s*\[)/.test(src),
        `${dir}/${f} does not dump process.env`,
      );
    }
  }
});

function readdir(dir: string): string[] {
  return readdirSync(dir).filter(f => /\.(ts|mts|mjs)$/.test(f));
}

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
console.log(`\ntask11-secret-hardening: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
