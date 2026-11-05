/**
 * TASK 04 — x402 payment module tests. Fully offline: no facilitator, no network,
 * no keys, no settlement.
 *
 * Covers: requirement construction, 402 response shape, payload preflight,
 * verify/settle gating, receipt shape, amount conversion, and the guarantee that
 * no failure path grants access.
 */

import {
  buildPaymentRequirements,
  buildPaymentRequired,
  preflightPaymentPayload,
  authorizePayment,
  buildReceipt,
  preflightPaymentPayloadAt,
  checkTransactionExpiry,
  MAX_EXPIRY_OFFSET_SECONDS,
  ccdToMicroCcd,
  microCcdToCcd,
  explorerUrl,
  isConcordiumAccount,
  DENY_ALL_FACILITATOR,
  CCD_TESTNET_CAIP2,
  CCD_ASSET,
  X402_VERSION,
  type ConsumerFacilitator,
} from '../src/payments/x402.js';
import { eq, ok, notOk, throws } from './helpers.mjs';

const PAY = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const OTHER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const TX = 'a'.repeat(64);

const baseReq = () =>
  buildPaymentRequirements({
    payTo: PAY,
    amountMicroCcd: '250000',
    resourceUrl: 'https://api.sabokun.my.id/agenttrust/paid/resource',
    description: 'AgentTrust paid resource',
    mimeType: 'application/json',
  });

/** Current unix time in seconds. Used only to place fixture expiry inside rule 7. */
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Structural payload. The expiry sits 300s ahead so it satisfies rule 7
 * (expiry must be in the future and within MAX_EXPIRY_OFFSET_SECONDS).
 * The signature is a placeholder — this payload is never settled for real.
 */
const validPayload = (over: Record<string, unknown> = {}, expiry = nowSec() + 300) => ({
  x402Version: X402_VERSION,
  accepted: { ...baseReq(), ...over },
  payload: {
    signedTransaction: {
      version: 1,
      header: { sender: OTHER, nonce: 1, expiry, sponsor: { account: PAY, numSignatures: 1 } },
      payload: { type: 'transfer' },
      signatures: { sender: {}, sponsor: {} },
    },
  },
});

function mockFacilitator(opts: {
  verify?: 'ok' | 'invalid' | 'throw';
  settle?: 'ok' | 'fail' | 'throw' | 'no-tx';
} = {}): ConsumerFacilitator & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async verify() {
      calls.push('verify');
      if (opts.verify === 'throw') throw new Error('facilitator unreachable');
      if (opts.verify === 'invalid') {
        return { isValid: false, invalidReason: 'amount_mismatch', invalidMessage: 'amount differs' };
      }
      return { isValid: true, payer: OTHER };
    },
    async settle() {
      calls.push('settle');
      if (opts.settle === 'throw') throw new Error('settle endpoint 500');
      if (opts.settle === 'fail') {
        return { success: false, transaction: '', network: CCD_TESTNET_CAIP2, errorReason: 'insufficient_funds', errorMessage: 'payer has 0 CCD' };
      }
      if (opts.settle === 'no-tx') {
        return { success: true, transaction: '', network: CCD_TESTNET_CAIP2 };
      }
      return { success: true, transaction: TX, network: CCD_TESTNET_CAIP2, payer: OTHER };
    },
    async getSupported() {
      return { kinds: [{ x402Version: X402_VERSION, scheme: 'exact', network: CCD_TESTNET_CAIP2 }] };
    },
  } as ConsumerFacilitator & { calls: string[] };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ─── requirement construction ────────────────────────────────────────────

test('builds a valid exact CCD requirement', () => {
  const r = baseReq();
  eq(r.scheme, 'exact', 'scheme');
  eq(r.network, CCD_TESTNET_CAIP2, 'network');
  eq(r.asset, CCD_ASSET, 'asset is CCD, not a token contract');
  eq(r.amount, '250000', 'amount in microCCD');
  eq(r.payTo, PAY, 'payTo');
  eq(r.maxTimeoutSeconds, 300, 'default timeout');
  eq(typeof r.extra, 'object', 'extra present');
});

test('feePayer is carried in extra, not at the top level', () => {
  const r = buildPaymentRequirements({
    payTo: PAY, amountMicroCcd: '1000', resourceUrl: 'https://x', feePayer: OTHER,
  });
  eq(r.extra.feePayer, OTHER, 'extra.feePayer');
  notOk('feePayer' in r, 'must not leak to the top level (schema has no such field)');
});

test('rejects an invalid payTo', () => {
  throws(() => buildPaymentRequirements({ payTo: 'not-an-address', amountMicroCcd: '1000', resourceUrl: 'https://x' }),
    'payTo', 'bad address');
});

test('rejects a non-integer or zero amount', () => {
  throws(() => buildPaymentRequirements({ payTo: PAY, amountMicroCcd: '1.5', resourceUrl: 'https://x' }), 'integer', 'float');
  throws(() => buildPaymentRequirements({ payTo: PAY, amountMicroCcd: '0', resourceUrl: 'https://x' }), 'greater than zero', 'zero');
  throws(() => buildPaymentRequirements({ payTo: PAY, amountMicroCcd: '-5', resourceUrl: 'https://x' }), 'integer', 'negative');
});

test('rejects an invalid feePayer', () => {
  throws(() => buildPaymentRequirements({ payTo: PAY, amountMicroCcd: '1000', resourceUrl: 'https://x', feePayer: 'nope' }),
    'feePayer', 'bad sponsor');
});

test('rejects a non-positive timeout', () => {
  throws(() => buildPaymentRequirements({ payTo: PAY, amountMicroCcd: '1000', resourceUrl: 'https://x', maxTimeoutSeconds: 0 }),
    'maxTimeoutSeconds', 'zero timeout');
});

// ─── 402 response ────────────────────────────────────────────────────────

test('402 body matches the PaymentRequired schema', () => {
  const body = buildPaymentRequired(baseReq(), {
    resourceUrl: 'https://api.sabokun.my.id/agenttrust/paid/resource',
    description: 'AgentTrust paid resource',
    mimeType: 'application/json',
  });
  eq(body.x402Version, 2, 'x402Version');
  ok(typeof body.error === 'string' && body.error.length > 0, 'error string present');
  eq(body.resource.url, 'https://api.sabokun.my.id/agenttrust/paid/resource', 'resource.url');
  eq(body.resource.mimeType, 'application/json', 'resource.mimeType');
  eq(body.accepts.length, 1, 'one payment option');
  eq(body.accepts[0].scheme, 'exact', 'accepted scheme');
});

test('402 body is JSON-serialisable with no bigints or undefined', () => {
  const body = buildPaymentRequired(baseReq(), { resourceUrl: 'https://x' });
  const round = JSON.parse(JSON.stringify(body));
  eq(round.accepts[0].amount, '250000', 'amount survives round-trip as a string');
});

// ─── preflight ───────────────────────────────────────────────────────────

test('accepts a well-formed payload', () => {
  const r = preflightPaymentPayload(validPayload(), baseReq());
  ok(r.ok, 'should pass');
});

test('rejects a missing payload', () => {
  eq((preflightPaymentPayload(undefined, baseReq()) as any).reason, 'payment payload is missing or not an object', 'undefined');
  eq((preflightPaymentPayload(null, baseReq()) as any).reason, 'payment payload is missing or not an object', 'null');
});

test('rejects a wrong x402Version', () => {
  const p = { ...validPayload(), x402Version: 1 };
  ok(!preflightPaymentPayload(p, baseReq()).ok, 'v1 must not pass a v2 server');
});

test('rejects scheme / network / asset / amount / payTo mismatches', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['scheme', { scheme: 'upto' }],
    ['network', { network: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' }],
    ['asset', { asset: 'USDR' }],
    ['amount', { amount: '1' }],
    ['payTo', { payTo: OTHER }],
  ];
  for (const [label, over] of cases) {
    const r = preflightPaymentPayload(validPayload(over), baseReq());
    notOk(r.ok, `${label} mismatch must fail`);
  }
});

test('rejects a payload with no body', () => {
  const p = { ...validPayload(), payload: undefined };
  ok(!preflightPaymentPayload(p, baseReq()).ok, 'empty body must fail');
});

// ─── verify / settle gating ──────────────────────────────────────────────

test('valid verify + successful settle grants access and returns a receipt', async () => {
  const fac = mockFacilitator({ verify: 'ok', settle: 'ok' });
  const d = await authorizePayment({
    facilitator: fac,
    paymentPayload: validPayload(),
    requirements: baseReq(),
    settle: true,
    audit: { agentId: 1004 },
  });
  ok(d.granted, 'access granted');
  eq(d.reason, 'settled', 'reason');
  ok(d.receipt, 'receipt present');
  eq(d.receipt!.transaction, TX, 'tx hash');
  eq(d.receipt!.amount, '250000', 'amount');
  eq(d.receipt!.asset, 'CCD', 'asset');
  eq(d.receipt!.payTo, PAY, 'payTo');
  eq(d.receipt!.payer, OTHER, 'payer');
  eq(d.receipt!.audit.agentId, 1004, 'audit metadata attached');
  ok(d.receipt!.explorerUrl.includes('ccdexplorer.io/testnet/transaction/'), 'explorer url');
  ok(d.receipt!.settledAt, 'timestamp');
  eq(fac.calls.join(','), 'verify,settle', 'call order');
});

test('verify-only never grants access and never settles', async () => {
  const fac = mockFacilitator({ verify: 'ok' });
  const d = await authorizePayment({
    facilitator: fac, paymentPayload: validPayload(), requirements: baseReq(), settle: false,
  });
  notOk(d.granted, 'verified but unsettled must not grant');
  eq(d.reason, 'verified only — settlement not requested', 'reason');
  eq(fac.calls.join(','), 'verify', 'settle never called');
});

test('settle defaults to off', async () => {
  const fac = mockFacilitator({ verify: 'ok' });
  const d = await authorizePayment({ facilitator: fac, paymentPayload: validPayload(), requirements: baseReq() });
  notOk(d.granted, 'no implicit settlement');
  ok(!fac.calls.includes('settle'), 'settle not invoked');
});

test('invalid verify denies access without settling', async () => {
  const fac = mockFacilitator({ verify: 'invalid' });
  const d = await authorizePayment({
    facilitator: fac, paymentPayload: validPayload(), requirements: baseReq(), settle: true,
  });
  notOk(d.granted, 'denied');
  ok(d.reason.startsWith('verify rejected'), `reason: ${d.reason}`);
  eq(fac.calls.join(','), 'verify', 'settle skipped');
});

test('verify throwing denies access', async () => {
  const fac = mockFacilitator({ verify: 'throw' });
  const d = await authorizePayment({
    facilitator: fac, paymentPayload: validPayload(), requirements: baseReq(), settle: true,
  });
  notOk(d.granted, 'denied');
  ok(d.reason.includes('verify threw'), 'reason names the transport failure');
});

test('settle failure denies access', async () => {
  const fac = mockFacilitator({ verify: 'ok', settle: 'fail' });
  const d = await authorizePayment({
    facilitator: fac, paymentPayload: validPayload(), requirements: baseReq(), settle: true,
  });
  notOk(d.granted, 'denied');
  ok(d.reason.includes('insufficient_funds'), 'reason carries the facilitator error code');
  eq(d.receipt, null, 'no receipt on failure');
});

test('settle throwing denies access', async () => {
  const fac = mockFacilitator({ verify: 'ok', settle: 'throw' });
  const d = await authorizePayment({
    facilitator: fac, paymentPayload: validPayload(), requirements: baseReq(), settle: true,
  });
  notOk(d.granted, 'denied');
  ok(d.reason.includes('settle threw'), 'reason');
});

test('settle claiming success without a transaction denies access', async () => {
  const fac = mockFacilitator({ verify: 'ok', settle: 'no-tx' });
  const d = await authorizePayment({
    facilitator: fac, paymentPayload: validPayload(), requirements: baseReq(), settle: true,
  });
  notOk(d.granted, 'unaufitable settlement must not grant access');
  ok(d.reason.includes('no transaction hash'), 'reason');
});

test('preflight failure short-circuits before the facilitator is contacted', async () => {
  const fac = mockFacilitator({ verify: 'ok', settle: 'ok' });
  const d = await authorizePayment({
    facilitator: fac,
    paymentPayload: validPayload({ amount: '1' }),
    requirements: baseReq(),
    settle: true,
  });
  notOk(d.granted, 'denied');
  eq(fac.calls.length, 0, 'facilitator never called');
  ok(d.reason.startsWith('preflight'), 'reason');
});

test('deny-all facilitator can never grant access', async () => {
  const d = await authorizePayment({
    facilitator: DENY_ALL_FACILITATOR,
    paymentPayload: validPayload(),
    requirements: baseReq(),
    settle: true,
  });
  notOk(d.granted, 'denied');
  ok(d.reason.includes('refusing to verify'), 'explicit refusal reason');
});

// ─── amounts and helpers ─────────────────────────────────────────────────

test('CCD ↔ microCCD conversion is exact', () => {
  eq(ccdToMicroCcd('1'), '1000000', '1 CCD');
  eq(ccdToMicroCcd('0.000001'), '1', '1 microCCD');
  eq(ccdToMicroCcd('0.25'), '250000', '0.25 CCD');
  eq(ccdToMicroCcd(2.5), '2500000', 'number input');
  eq(microCcdToCcd('250000'), '0.25', 'back');
  eq(microCcdToCcd('1000000'), '1', 'whole');
  eq(microCcdToCcd('1'), '0.000001', 'smallest');
  throws(() => ccdToMicroCcd('0.0000001'), '6 places', 'too precise');
  throws(() => ccdToMicroCcd('abc'), 'invalid', 'not a number');
});

test('account address shape validation', () => {
  ok(isConcordiumAccount(PAY), 'valid address');
  notOk(isConcordiumAccount('abc'), 'too short');
  notOk(isConcordiumAccount(PAY + 'x'), 'too long');
  notOk(isConcordiumAccount(PAY.replace(/[1-9]/, '0')), 'invalid base58 char');
  notOk(isConcordiumAccount(123), 'not a string');
});

test('explorer URL only for known networks', () => {
  ok(explorerUrl(CCD_TESTNET_CAIP2, 'ff')!.includes('/testnet/'), 'testnet');
  ok(explorerUrl('ccd:9dd9ca4d19e9393877d2c44b70f89acb', 'ff')!.includes('/mainnet/'), 'mainnet');
  eq(explorerUrl('ccd:unknown', 'ff'), undefined, 'unknown network');
});

test('receipt omits explorerUrl for unknown networks', () => {
  const r = buildReceipt(
    { success: true, transaction: TX, network: 'ccd:unknown' as any },
    baseReq(),
  );
  eq(r.explorerUrl, undefined, 'no link invented for an unknown chain');
});

// ─── expiry (spec rule 7) ────────────────────────────────────────────────

test('accepts a payload whose expiry is inside the window', () => {
  const now = 1_800_000_000;
  const p = validPayload({}, now + 300);
  ok(preflightPaymentPayloadAt(p, baseReq(), now).ok, 'should pass');
});

test('rejects an expired payment', () => {
  const now = 1_800_000_000;
  const p = validPayload({}, now - 1);
  const r = preflightPaymentPayloadAt(p, baseReq(), now);
  notOk(r.ok, 'expired must fail');
  ok((r as any).reason.includes('expired'), `reason: ${(r as any).reason}`);
});

test('rejects an expiry exactly at now', () => {
  const now = 1_800_000_000;
  notOk(preflightPaymentPayloadAt(validPayload({}, now), baseReq(), now).ok, 'boundary is expired');
});

test('rejects an expiry too far in the future (rule 7 ceiling)', () => {
  const now = 1_800_000_000;
  const p = validPayload({}, now + MAX_EXPIRY_OFFSET_SECONDS + 1);
  const r = preflightPaymentPayloadAt(p, baseReq(), now);
  notOk(r.ok, 'must fail');
  ok((r as any).reason.includes('rule 7'), `reason: ${(r as any).reason}`);
});

test('accepts an expiry exactly at the ceiling', () => {
  const now = 1_800_000_000;
  ok(preflightPaymentPayloadAt(validPayload({}, now + MAX_EXPIRY_OFFSET_SECONDS), baseReq(), now).ok, 'inclusive');
});

test('expired payment is denied and never reaches the facilitator', async () => {
  const fac = mockFacilitator({ verify: 'ok', settle: 'ok' });
  const now = 1_800_000_000;
  const d = await authorizePayment({
    facilitator: fac,
    paymentPayload: validPayload({}, now - 60),
    requirements: baseReq(),
    settle: true,
    nowSeconds: now,
  });
  notOk(d.granted, 'denied');
  ok(d.reason.includes('expired'), 'reason names expiry');
  eq(fac.calls.length, 0, 'facilitator never contacted');
});

test('expiry check tolerates payloads without an expiry claim', () => {
  ok(checkTransactionExpiry({ something: 'else' }, 1_800_000_000).ok, 'no expiry claim → defer to facilitator');
  ok(checkTransactionExpiry({}, 1_800_000_000).ok, 'empty body');
});

test('non-numeric expiry is rejected', () => {
  const r = checkTransactionExpiry({ signedTransaction: { header: { expiry: 'soon' } } }, 1_800_000_000);
  notOk(r.ok, 'must fail');
  ok((r as any).reason.includes('not a number'), 'reason');
});

// ─── wrong network / wrong asset / insufficient amount ───────────────────

test('wrong network is rejected before any facilitator call', async () => {
  const fac = mockFacilitator({ verify: 'ok', settle: 'ok' });
  const d = await authorizePayment({
    facilitator: fac,
    paymentPayload: validPayload({ network: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' }),
    requirements: baseReq(),
    settle: true,
  });
  notOk(d.granted, 'mainnet payment must not satisfy a testnet requirement');
  ok(d.reason.includes('network mismatch'), `reason: ${d.reason}`);
  eq(fac.calls.length, 0, 'facilitator never contacted');
});

test('wrong asset is rejected before any facilitator call', async () => {
  const fac = mockFacilitator({ verify: 'ok', settle: 'ok' });
  const d = await authorizePayment({
    facilitator: fac,
    paymentPayload: validPayload({ asset: 'USDR' }),
    requirements: baseReq(),
    settle: true,
  });
  notOk(d.granted, 'PLT must not satisfy a CCD requirement');
  ok(d.reason.includes('asset mismatch'), `reason: ${d.reason}`);
  eq(fac.calls.length, 0, 'facilitator never contacted');
});

test('insufficient amount is rejected before any facilitator call', async () => {
  const fac = mockFacilitator({ verify: 'ok', settle: 'ok' });
  for (const amount of ['1', '249999', '0']) {
    const d = await authorizePayment({
      facilitator: fac,
      paymentPayload: validPayload({ amount }),
      requirements: baseReq(),
      settle: true,
    });
    notOk(d.granted, `amount ${amount} must be rejected`);
    ok(d.reason.includes('amount mismatch'), `reason for ${amount}: ${d.reason}`);
  }
  eq(fac.calls.length, 0, 'facilitator never contacted');
});

test('overpayment is also a mismatch — exact scheme means exact', () => {
  const r = preflightPaymentPayload(validPayload({ amount: '250001' }), baseReq());
  notOk(r.ok, 'exact scheme rejects overpayment');
});

test('malformed payloads are rejected without touching the facilitator', async () => {
  const fac = mockFacilitator({ verify: 'ok', settle: 'ok' });
  const malformed = [null, undefined, 'string', 42, [], { x402Version: 2 }, { x402Version: 2, accepted: {} }];
  for (const m of malformed) {
    const d = await authorizePayment({
      facilitator: fac, paymentPayload: m, requirements: baseReq(), settle: true,
    });
    notOk(d.granted, `malformed ${JSON.stringify(m)} must be denied`);
    ok(d.reason.startsWith('preflight'), `reason: ${d.reason}`);
  }
  eq(fac.calls.length, 0, 'facilitator never contacted');
});

// ─── invariants the task calls out explicitly ────────────────────────────

test('failed verification never reaches settlement', async () => {
  for (const mode of ['invalid', 'throw'] as const) {
    const fac = mockFacilitator({ verify: mode, settle: 'ok' });
    const d = await authorizePayment({
      facilitator: fac, paymentPayload: validPayload(), requirements: baseReq(), settle: true,
    });
    notOk(d.granted, `verify=${mode} denied`);
    notOk(fac.calls.includes('settle'), `settle must not be called when verify=${mode}`);
    eq(d.settle, undefined, 'no settle response recorded');
  }
});

test('access is granted only after successful settlement, never before', async () => {
  // 1. verify ok, settle not requested → no access
  const a = mockFacilitator({ verify: 'ok' });
  const d1 = await authorizePayment({
    facilitator: a, paymentPayload: validPayload(), requirements: baseReq(), settle: false,
  });
  notOk(d1.granted, 'verified alone is not access');

  // 2. verify ok, settle fails → no access
  const b = mockFacilitator({ verify: 'ok', settle: 'fail' });
  const d2 = await authorizePayment({
    facilitator: b, paymentPayload: validPayload(), requirements: baseReq(), settle: true,
  });
  notOk(d2.granted, 'failed settlement is not access');
  eq(d2.receipt, null, 'no receipt');

  // 3. verify ok, settle ok → access, and only then
  const c = mockFacilitator({ verify: 'ok', settle: 'ok' });
  const d3 = await authorizePayment({
    facilitator: c, paymentPayload: validPayload(), requirements: baseReq(), settle: true,
  });
  ok(d3.granted, 'settled is access');
  ok(d3.receipt, 'receipt accompanies access');
  eq(c.calls.join(','), 'verify,settle', 'settle happened last');
});

// ─── no real network transaction is emitted by this suite ────────────────

test('the whole gate runs with global fetch poisoned', async () => {
  // If any code path tried to reach a facilitator or a chain node, this throws.
  const original = globalThis.fetch;
  let attempted = false;
  globalThis.fetch = (async () => {
    attempted = true;
    throw new Error('network access attempted during a unit test');
  }) as typeof fetch;
  try {
    const fac = mockFacilitator({ verify: 'ok', settle: 'ok' });
    const d = await authorizePayment({
      facilitator: fac, paymentPayload: validPayload(), requirements: baseReq(), settle: true,
    });
    ok(d.granted, 'mock settlement still works with fetch poisoned');
    notOk(attempted, 'no fetch was attempted');
  } finally {
    globalThis.fetch = original;
  }
});

test('mock facilitator is the only facilitator reachable in tests', async () => {
  // The default facilitator must refuse, proving no code path can settle silently.
  const d = await authorizePayment({
    facilitator: DENY_ALL_FACILITATOR,
    paymentPayload: validPayload(),
    requirements: baseReq(),
    settle: true,
  });
  notOk(d.granted, 'default facilitator grants nothing');
  eq(d.receipt, null, 'no receipt from the default facilitator');
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
console.log(`\ntask04-x402-exact: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
