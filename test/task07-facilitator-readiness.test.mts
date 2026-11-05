/**
 * TASK 07 — facilitator readiness, compatibility, and signing-boundary tests.
 *
 * All offline. The facilitator is either a mock `fetch` or a mock
 * `ConsumerFacilitator`; the two live probes used as evidence were run once by
 * hand and are recorded in docs/TASK07-result.md, never here.
 */

import {
  probeFacilitator,
  validateSupportedShape,
  classifyCompatibility,
  validateRequirementAgainstFacilitator,
  type SupportedResponse,
} from '../src/payments/facilitator.js';
import {
  checkAuthorization,
  requestSigning,
  inspectSignedPayload,
  guardSettlement,
  type OperatorAuthorization,
} from '../src/payments/operatorSigning.js';
import {
  buildPaymentRequirements,
  authorizePayment,
  DENY_ALL_FACILITATOR,
  CCD_TESTNET_CAIP2,
  CCD_ASSET,
  X402_VERSION,
  type ConsumerFacilitator,
} from '../src/payments/x402.js';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk, throws } from './helpers.mjs';

const tests: [string, () => unknown][] = [];
const test = (name: string, fn: () => unknown) => tests.push([name, fn]);

const SPONSOR = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const PAYER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';

function supported(over: Partial<SupportedResponse> = {}): SupportedResponse {
  return {
    kinds: [
      { x402Version: 2, scheme: 'exact', network: CCD_TESTNET_CAIP2, extra: { feePayer: SPONSOR } },
    ],
    ...over,
  };
}

function mockFetch(handler: (url: string) => Promise<Response> | Response): typeof fetch {
  return ((url: unknown, init?: unknown) => handler(String(url), init as RequestInit)) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requirement(over: Record<string, unknown> = {}) {
  return {
    ...buildPaymentRequirements({
      network: CCD_TESTNET_CAIP2,
      payTo: SPONSOR,
      amountMicroCcd: '10000',
      aiAgent: false,
      resource: 'https://api.example.test/agenttrust/report',
      description: 'report',
      maxTimeoutSeconds: 600,
      feePayer: SPONSOR,
    } as never),
    ...over,
  } as ReturnType<typeof buildPaymentRequirements>;
}

function authorization(over: Partial<OperatorAuthorization> = {}): OperatorAuthorization {
  const req = requirement();
  return {
    authorization_id: 'auth_test_001',
    issued_by: 'operator@local',
    issued_at: new Date().toISOString(),
    terms: {
      network: req.network,
      asset: req.asset,
      amount: req.amount,
      payTo: req.payTo,
      feePayer: SPONSOR,
      resourceUrl: 'https://api.example.test/agenttrust/report',
    },
    maxAmountMicroCcd: req.amount,
    ...over,
  };
}

/** A structurally valid signed payload referencing the given requirement. */
function signedPayload(over: { expiry?: number; sponsor?: string; nonce?: number; to?: string; amount?: string } = {}) {
  const req = requirement();
  const now = Math.floor(Date.now() / 1000);
  return {
    x402Version: X402_VERSION,
    accepted: req,
    payload: {
      signedTransaction: {
        version: 1,
        header: {
          sender: PAYER,
          nonce: over.nonce ?? 5,
          expiry: over.expiry ?? now + 300,
          numSignatures: 2,
          sponsor: { address: over.sponsor ?? SPONSOR },
        },
        payload: {
          type: 'transfer',
          toAddress: over.to ?? req.payTo,
          amount: over.amount ?? req.amount,
          energy: 1000,
        },
        signatures: {
          sender: { '0': { sig: 'AAAA' } },
          sponsor: {},
        },
      },
    },
  };
}

// ─── 1. facilitator unavailable ──────────────────────────────────────────

test('01. facilitator unavailable → classified failure, never a fallback', async () => {
  const r = await probeFacilitator(
    { url: 'https://no-such-facilitator.invalid/facilitator' },
    mockFetch(() => {
      const e = new Error('getaddrinfo ENOTFOUND no-such-facilitator.invalid');
      throw e;
    }),
  );
  notOk(r.ok, 'probe must fail');
  if (!r.ok) {
    eq(r.kind, 'dns_or_tls_failure', 'classified as DNS failure');
    notOk('body' in r, 'no body on failure');
  }
});

test('02. DNS vs TLS vs refusal vs timeout are distinguished', async () => {
  const cases: [string, Error, string][] = [
    ['dns', new Error('getaddrinfo EAI_AGAIN host'), 'dns_or_tls_failure'],
    ['tls', new Error('unable to verify the first certificate'), 'dns_or_tls_failure'],
    ['refused', new Error('connect ECONNREFUSED 127.0.0.1:443'), 'connection_refused'],
    ['timeout', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'timeout'],
  ];
  for (const [label, err, expected] of cases) {
    const r = await probeFacilitator({ url: 'https://h.example/f', timeoutMs: 50 }, mockFetch(() => { throw err; }));
    notOk(r.ok, `${label} must fail`);
    if (!r.ok) eq(r.kind, expected, `${label} classified`);
  }
});

test('03. HTTP error and invalid JSON are distinguished from network errors', async () => {
  const html = await probeFacilitator({ url: 'https://h.example/f' }, mockFetch(() => new Response('<html>', { status: 404 })));
  notOk(html.ok, '404 must fail');
  if (!html.ok) eq(html.kind, 'http_error', '404 classified');

  const bad = await probeFacilitator({ url: 'https://h.example/f' }, mockFetch(() => new Response('not json', { status: 200 })));
  notOk(bad.ok, 'non-JSON must fail');
  if (!bad.ok) eq(bad.kind, 'invalid_json', 'invalid JSON classified');

  const shape = await probeFacilitator({ url: 'https://h.example/f' }, mockFetch(() => jsonResponse(200, { nope: 1 })));
  notOk(shape.ok, 'bad shape must fail');
  if (!shape.ok) eq(shape.kind, 'invalid_shape', 'shape failure classified');
});

test('04. probe only ever requests /supported', async () => {
  const seen: string[] = [];
  await probeFacilitator(
    { url: 'https://h.example/facilitator/' },
    mockFetch(url => {
      seen.push(url);
      return jsonResponse(200, supported());
    }),
  );
  eq(seen.length, 1, 'exactly one request');
  eq(seen[0], 'https://h.example/facilitator/supported', 'trailing slash normalised, path is /supported');
});

// ─── 2. schema validation ────────────────────────────────────────────────

test('05. /supported schema validation rejects malformed bodies', () => {
  ok(validateSupportedShape(supported()).ok, 'valid body accepted');
  ok(validateSupportedShape({ kinds: [] }).ok, 'empty kinds array is structurally valid');

  for (const [label, body] of [
    ['null', null],
    ['array', []],
    ['no kinds', {}],
    ['kinds not array', { kinds: {} }],
    ['kind not object', { kinds: [1] }],
    ['missing version', { kinds: [{ scheme: 'exact', network: 'x' }] }],
    ['missing scheme', { kinds: [{ x402Version: 2, network: 'x' }] }],
    ['missing network', { kinds: [{ x402Version: 2, scheme: 'exact' }] }],
    ['extensions not array', { kinds: [], extensions: {} }],
    ['signers null', { kinds: [], signers: null }],
  ] as [string, unknown][]) {
    notOk(validateSupportedShape(body).ok, `${label} must be rejected`);
  }
});

// ─── 3. unsupported network / scheme / version ──────────────────────────

test('06. unsupported network is a hard block with the networks listed', () => {
  const c = classifyCompatibility({
    kinds: [
      { x402Version: 2, scheme: 'exact', network: 'eip155:84532', extra: { feePayer: '0xabc' } },
      { x402Version: 2, scheme: 'exact', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
    ],
  });
  notOk(c.usable, 'must not be usable');
  eq(c.code, 'NO_CCD_NETWORK', 'code');
  eq(c.networks.join(','), 'eip155:84532,solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'all networks reported');
});

test('07. unsupported scheme on our network is a hard block', () => {
  const c = classifyCompatibility({
    kinds: [{ x402Version: 2, scheme: 'upto', network: CCD_TESTNET_CAIP2, extra: { feePayer: SPONSOR } }],
  });
  notOk(c.usable, 'must not be usable');
  eq(c.code, 'NO_EXACT_SCHEME', 'code');
  eq(c.schemesOnNetwork.join(','), 'upto', 'offered schemes reported');
});

test('08. wrong x402 version is a hard block', () => {
  const c = classifyCompatibility({
    kinds: [{ x402Version: 1, scheme: 'exact', network: CCD_TESTNET_CAIP2, extra: { feePayer: SPONSOR } }],
  });
  notOk(c.usable, 'must not be usable');
  eq(c.code, 'WRONG_X402_VERSION', 'code');
});

test('09. a facilitator with no fee payer cannot sponsor, so it is unusable', () => {
  const c = classifyCompatibility({
    kinds: [{ x402Version: 2, scheme: 'exact', network: CCD_TESTNET_CAIP2 }],
  });
  notOk(c.usable, 'must not be usable');
  eq(c.code, 'NO_FEE_PAYER', 'code');
});

test('10. a fully compatible announcement is usable', () => {
  const c = classifyCompatibility(supported());
  ok(c.usable, 'usable');
  eq(c.code, 'OK', 'code');
  eq(c.feePayer, SPONSOR, 'fee payer extracted');
});

test('11. requirement/facilitator mismatch is rejected both ways', () => {
  const c = classifyCompatibility(supported());
  ok(validateRequirementAgainstFacilitator(requirement(), c).ok, 'matching requirement accepted');

  const badNet = validateRequirementAgainstFacilitator(requirement({ network: 'eip155:84532' }), c);
  notOk(badNet.ok, 'network mismatch rejected');

  const badAsset = validateRequirementAgainstFacilitator(requirement({ asset: 'PLT' }), c);
  notOk(badAsset.ok, 'non-CCD asset rejected');

  const badFee = validateRequirementAgainstFacilitator(requirement({ extra: { feePayer: PAYER } }), c);
  notOk(badFee.ok, 'foreign fee payer rejected');

  const noFee = validateRequirementAgainstFacilitator(requirement({ extra: {} }), c);
  notOk(noFee.ok, 'missing fee payer rejected');
});

// ─── 4. signing boundary ────────────────────────────────────────────────

test('12. missing operator authorization blocks signing', () => {
  const r = requestSigning({
    requirements: requirement(),
    facilitator: classifyCompatibility(supported()),
    authorization: null,
    resourceUrl: 'https://api.example.test/agenttrust/report',
    sender: PAYER,
  });
  notOk(r.ok, 'must refuse');
  if (!r.ok) eq(r.code, 'NO_AUTHORIZATION', 'code');
});

test('13. authorization term drift blocks signing', () => {
  const compat = classifyCompatibility(supported());
  const base = {
    requirements: requirement(),
    facilitator: compat,
    resourceUrl: 'https://api.example.test/agenttrust/report',
    sender: PAYER,
  };
  const cases: [string, OperatorAuthorization][] = [
    ['amount', authorization({ terms: { ...authorization().terms, amount: '1' } })],
    ['payTo', authorization({ terms: { ...authorization().terms, payTo: PAYER } })],
    ['feePayer', authorization({ terms: { ...authorization().terms, feePayer: PAYER } })],
    ['network', authorization({ terms: { ...authorization().terms, network: 'eip155:84532' } })],
    ['asset', authorization({ terms: { ...authorization().terms, asset: 'PLT' } })],
    ['resourceUrl', authorization({ terms: { ...authorization().terms, resourceUrl: 'https://evil.test/x' } })],
  ];
  for (const [label, auth] of cases) {
    const r = requestSigning({ ...base, authorization: auth });
    notOk(r.ok, `${label} drift must refuse`);
    if (!r.ok) eq(r.code, 'TERMS_MISMATCH', `${label} code`);
  }
});

test('14. authorization ceiling and expiry are enforced', () => {
  const req = requirement();
  const over = authorization({ maxAmountMicroCcd: '9999' });
  const r1 = checkAuthorization(over, req);
  notOk(r1.ok, 'amount above ceiling refused');
  if (!r1.ok) eq(r1.violation.code, 'AMOUNT_EXCEEDS_AUTHORIZATION', 'ceiling code');

  const old = authorization({ issued_at: new Date(Date.now() - 3_600_000).toISOString() });
  const r2 = checkAuthorization(old, req);
  notOk(r2.ok, 'stale authorization refused');
  if (!r2.ok) eq(r2.violation.code, 'AUTHORIZATION_EXPIRED', 'expiry code');

  const malformed = authorization({ maxAmountMicroCcd: '10.5' });
  const r3 = checkAuthorization(malformed, req);
  notOk(r3.ok, 'non-integer ceiling refused');
  if (!r3.ok) eq(r3.violation.code, 'AUTHORIZATION_MALFORMED', 'malformed code');
});

test('15. signing request names the sponsor and forbids a sponsor signature', () => {
  const r = requestSigning({
    requirements: requirement(),
    facilitator: classifyCompatibility(supported()),
    authorization: authorization(),
    resourceUrl: 'https://api.example.test/agenttrust/report',
    sender: PAYER,
  });
  ok(r.ok, 'signing request produced');
  if (r.ok) {
    eq(r.request.produce.sponsor_in_header, SPONSOR, 'sponsor is the facilitator fee payer');
    eq(r.request.produce.transaction_version, 1, 'V1 transaction');
    ok(r.request.produce.required_fields.includes('signatures.sponsor'), 'sponsor signature slot is named');
    ok(r.request.statement.includes('authorization auth_test_001'), 'statement names the authorization');
    notOk(JSON.stringify(r.request).includes('privateKey'), 'no key material in the request');
  }
});

test('16. an unusable facilitator or bad sender blocks the signing request', () => {
  const compat = classifyCompatibility({ kinds: [] });
  const r = requestSigning({
    requirements: requirement(),
    facilitator: compat,
    authorization: authorization(),
    resourceUrl: 'https://api.example.test/agenttrust/report',
    sender: PAYER,
  });
  notOk(r.ok, 'unusable facilitator refused');
  if (!r.ok) eq(r.code, 'FACILITATOR_UNUSABLE', 'code');

  const r2 = requestSigning({
    requirements: requirement(),
    facilitator: classifyCompatibility(supported()),
    authorization: authorization(),
    resourceUrl: 'https://api.example.test/agenttrust/report',
    sender: 'not-an-account',
  });
  notOk(r2.ok, 'bad sender refused');
  if (!r2.ok) eq(r2.code, 'INVALID_SENDER', 'code');
});

// ─── 5. payload structure ───────────────────────────────────────────────

test('17. a well-formed payload passes structural inspection and leaks no signature', () => {
  const c = inspectSignedPayload(signedPayload(), requirement(), SPONSOR);
  ok(c.ok, `expected ok, got ${c.problems.join('; ')}`);
  eq(c.facts.sender, PAYER, 'sender extracted');
  eq(c.facts.sponsor, SPONSOR, 'sponsor extracted');
  eq(c.facts.transferTo, SPONSOR, 'recipient extracted');
  notOk(JSON.stringify(c.facts).includes('AAAA'), 'signature bytes never surface in facts');
});

test('18. expired, wrong-sponsor, wrong-amount, wrong-recipient payloads are rejected', () => {
  const now = Math.floor(Date.now() / 1000);
  const cases: [string, unknown][] = [
    ['expired', signedPayload({ expiry: now - 1 })],
    ['sponsor', signedPayload({ sponsor: PAYER })],
    ['amount', signedPayload({ amount: '1' })],
    ['recipient', signedPayload({ to: PAYER })],
  ];
  for (const [label, p] of cases) {
    const c = inspectSignedPayload(p, requirement(), SPONSOR);
    notOk(c.ok, `${label} must be rejected`);
  }

  // Expiry far beyond the requirement window is also rejected.
  const far = inspectSignedPayload(signedPayload({ expiry: now + 100_000 }), requirement(), SPONSOR);
  notOk(far.ok, 'expiry beyond maxTimeoutSeconds rejected');
});

test('19. a payload signed by the sponsor is rejected — only the facilitator may sponsor', () => {
  const p = signedPayload() as any;
  p.payload.signedTransaction.signatures.sponsor = { '0': { sig: 'BBBB' } };
  const c = inspectSignedPayload(p, requirement(), SPONSOR);
  notOk(c.ok, 'caller-supplied sponsor signature rejected');
});

test('20. malformed payloads fail structurally rather than throwing', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { x402Version: 2 }, { x402Version: 2, accepted: {}, payload: {} }]) {
    const c = inspectSignedPayload(bad, requirement(), SPONSOR);
    notOk(c.ok, `malformed payload ${JSON.stringify(bad)?.slice(0, 30)} rejected`);
    ok(c.problems.length > 0, 'a reason is always given');
  }
});

// ─── 6. settlement can never be reached ─────────────────────────────────

test('21. non-settling mode refuses before any settlement call', () => {
  const g = guardSettlement({
    allowSettlement: false,
    payload: signedPayload(),
    requirements: requirement(),
    expectedSponsor: SPONSOR,
    authorization: authorization(),
  });
  notOk(g.ok, 'refused');
  if (!g.ok) eq(g.code, 'SETTLEMENT_DISABLED', 'code');

  // Even with everything valid, the flag alone decides.
  const nice = guardSettlement({
    allowSettlement: false,
    payload: signedPayload(),
    requirements: requirement(),
    expectedSponsor: SPONSOR,
    authorization: authorization(),
  });
  notOk(nice.ok, 'still refused');
});

test('22. settlement guard rejects a valid payload with no authorization', () => {
  const g = guardSettlement({
    allowSettlement: true,
    payload: signedPayload(),
    requirements: requirement(),
    expectedSponsor: SPONSOR,
    authorization: null,
  });
  notOk(g.ok, 'refused');
  if (!g.ok) eq(g.code, 'NO_AUTHORIZATION', 'code');
});

test('23. settlement guard rejects a structurally invalid payload', () => {
  const g = guardSettlement({
    allowSettlement: true,
    payload: signedPayload({ expiry: 1 }),
    requirements: requirement(),
    expectedSponsor: SPONSOR,
    authorization: authorization(),
  });
  notOk(g.ok, 'refused');
  if (!g.ok) eq(g.code, 'PAYLOAD_INVALID', 'code');
});

// ─── 7. verification failure cannot reach settlement ────────────────────

test('24. verification rejection never reaches settle (counted facilitator)', async () => {
  let settleCalls = 0;
  const fac: ConsumerFacilitator = {
    ...DENY_ALL_FACILITATOR,
    verify: async () => ({ isValid: false, invalidReason: 'invalid_sender_signature' }),
    settle: async () => {
      settleCalls++;
      return { success: true, transaction: 'deadbeef' } as never;
    },
  };
  const d = await authorizePayment({ facilitator: fac, paymentPayload: signedPayload(), requirements: requirement(), settle: true });
  notOk(d.granted, 'access denied');
  eq(settleCalls, 0, 'settle was never called');
});

test('25. verification timeout is not retried and never settles', async () => {
  let settleCalls = 0;
  let verifyCalls = 0;
  const fac: ConsumerFacilitator = {
    ...DENY_ALL_FACILITATOR,
    verify: async () => {
      verifyCalls++;
      throw new Error('timeout after 10000ms');
    },
    settle: async () => {
      settleCalls++;
      return { success: true, transaction: 'deadbeef' } as never;
    },
  };
  const d = await authorizePayment({ facilitator: fac, paymentPayload: signedPayload(), requirements: requirement(), settle: true });
  notOk(d.granted, 'access denied');
  eq(verifyCalls, 1, 'exactly one verify attempt — no retry loop');
  eq(settleCalls, 0, 'settle never called');
  ok(d.reason.includes('verify threw'), 'reason names the failure');
});

test('26. ambiguous settlement is not retried', async () => {
  let settleCalls = 0;
  const fac: ConsumerFacilitator = {
    ...DENY_ALL_FACILITATOR,
    verify: async () => ({ isValid: true, payer: PAYER } as never),
    settle: async () => {
      settleCalls++;
      throw new Error('504 gateway timeout — status unknown');
    },
  };
  const d = await authorizePayment({ facilitator: fac, paymentPayload: signedPayload(), requirements: requirement(), settle: true });
  notOk(d.granted, 'access denied on ambiguity');
  eq(settleCalls, 1, 'exactly one settle attempt');
  ok(/ambiguous|status unknown|unreachable/i.test(d.reason) || d.reason.includes('settle threw'), 'reason recorded');
});

test('27. settlement success without a transaction hash denies access', async () => {
  const fac: ConsumerFacilitator = {
    ...DENY_ALL_FACILITATOR,
    verify: async () => ({ isValid: true, payer: PAYER } as never),
    settle: async () => ({ success: true } as never),
  };
  const d = await authorizePayment({ facilitator: fac, paymentPayload: signedPayload(), requirements: requirement(), settle: true });
  notOk(d.granted, 'access denied without a hash');
  eq(d.receipt, null, 'no receipt');
});

test('28. the default facilitator denies every operation', async () => {
  await throwsAsync(
    () => DENY_ALL_FACILITATOR.verify({} as never, {} as never),
    'refusing to verify',
    'verify denied',
  );
  await throwsAsync(
    () => DENY_ALL_FACILITATOR.settle({} as never, {} as never),
    'refusing to settle',
    'settle denied',
  );
});

async function throwsAsync(fn: () => Promise<unknown>, needle: string, label: string) {
  try {
    await fn();
  } catch (e) {
    ok(String((e as Error).message).includes(needle), `${label}: got "${(e as Error).message}"`);
    return;
  }
  throw new Error(`${label}: expected a throw`);
}

// ─── 8. secrets never reach logs or audit ───────────────────────────────

test('29. no signing material appears in any produced artifact', () => {
  const artifacts = [
    JSON.stringify(requestSigning({
      requirements: requirement(),
      facilitator: classifyCompatibility(supported()),
      authorization: authorization(),
      resourceUrl: 'https://api.example.test/agenttrust/report',
      sender: PAYER,
    })),
    JSON.stringify(inspectSignedPayload(signedPayload(), requirement(), SPONSOR)),
    JSON.stringify(classifyCompatibility(supported())),
  ].join('\n');

  // Account addresses and hashes are public and expected. What must never appear
  // is key material: seed phrases, private keys, or raw signature bytes.
  for (const pattern of [
    /seed/i,
    /privateKey/i,
    /private_key/i,
    /mnemonic/i,
    /passphrase/i,
    /\b(?:0x)?[a-f0-9]{64}\b/i,
    /\b(?:[a-f0-9]{128})\b/i,
  ]) {
    notOk(pattern.test(artifacts), `artifact matched ${pattern}`);
  }
  ok(artifacts.includes(SPONSOR), 'the public sponsor address IS present — that is expected');
});

test('30. audit trail rejects a payment event carrying key material', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t07-'));
  try {
    const { AuditTrail } = requireAudit();
    const trail = new AuditTrail({ filePath: join(dir, 'trail.jsonl'), sessionId: 'cs_t07' });
    // A realistic shape: 64 hex chars is what an ed25519 private key looks like here.
    const secret = 'a'.repeat(64);
    throws(
      () =>
        trail.record('payment.payload.received', {
          outcome: 'PASS',
          reason: 'sig',
          payment: { payer: secret } as never,
        }),
      'raw key material',
      'audit trail refuses signing material',
    );
    // Nothing was written at all — the record was refused before hashing/append.
    const raw = existsSync(join(dir, 'trail.jsonl')) ? readFileSync(join(dir, 'trail.jsonl'), 'utf8') : '';
    eq(raw, '', 'no event was written');
    notOk(raw.includes(secret), 'the secret never reached disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// sync require of an ESM module is not possible; import lazily via dynamic import
let _audit: typeof import('../src/audit/trail.js') | undefined;
function requireAudit(): typeof import('../src/audit/trail.js') {
  if (!_audit) throw new Error('audit module not loaded — call await loadAudit() first');
  return _audit;
}

// ─── runner ─────────────────────────────────────────────────────────────

const { AuditTrail } = await import('../src/audit/trail.js');
_audit = { AuditTrail } as typeof import('../src/audit/trail.js');

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
console.log(`\ntask07-facilitator-readiness: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
