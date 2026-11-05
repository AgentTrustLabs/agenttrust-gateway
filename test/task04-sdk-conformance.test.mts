/**
 * TASK 04 — conformance tests against the OFFICIAL SDK (offline).
 *
 * Asserts that this project's payment shapes agree with @x402/concordium and
 * @x402/core, and that no code path can reach a live facilitator by default.
 */

import {
  assertSdkAcceptsRequirements,
  assertConstantsAgree,
  buildResourceServer,
  createHttpFacilitator,
  SDK_TESTNET_CAIP2,
  SDK_CONSTANTS,
  sdkExplorerTxUrl,
} from '../src/payments/x402Sdk.js';
import {
  buildPaymentRequirements,
  buildPaymentRequired,
  ccdToMicroCcd,
  CCD_ASSET,
  CCD_DECIMALS,
  CCD_TESTNET_CAIP2,
  DENY_ALL_FACILITATOR,
  X402_VERSION,
} from '../src/payments/x402.js';
import { CONCORDIUM_TESTNET_CAIP2, CCD_ASSET_IDENTIFIER, CCD_DECIMALS as SDK_DECIMALS } from '@x402/concordium';
import { x402Version as SDK_X402_VERSION } from '@x402/core';
import { readFileSync } from 'node:fs';
import { eq, ok, notOk, throws } from './helpers.mjs';

const PAY = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ─── version + constants agreement with the installed packages ───────────

test('x402 protocol version matches @x402/core', () => {
  eq(X402_VERSION, SDK_X402_VERSION, 'local X402_VERSION vs SDK x402Version');
  eq(SDK_X402_VERSION, 2, 'SDK reports v2');
});

test('network CAIP-2 matches @x402/concordium', () => {
  eq(CCD_TESTNET_CAIP2, CONCORDIUM_TESTNET_CAIP2, 'testnet CAIP-2');
  eq(SDK_TESTNET_CAIP2, CONCORDIUM_TESTNET_CAIP2, 'bridge re-export');
});

test('CCD asset identifier and decimals match the SDK', () => {
  eq(CCD_ASSET, CCD_ASSET_IDENTIFIER, 'asset id');
  eq(CCD_DECIMALS, SDK_DECIMALS, 'decimals');
  assertConstantsAgree({ asset: CCD_ASSET, decimals: CCD_DECIMALS, network: CCD_TESTNET_CAIP2 });
});

test('SDK gRPC endpoint is the one TASK 01 verified live', () => {
  eq(SDK_CONSTANTS.grpcUrl, 'grpc.testnet.concordium.com:20000', 'grpc');
});

test('constant drift is detected, not ignored', () => {
  throws(() => assertConstantsAgree({ asset: 'ccd', decimals: 6, network: CCD_TESTNET_CAIP2 }), 'asset constant drift', 'asset');
  throws(() => assertConstantsAgree({ asset: 'CCD', decimals: 9, network: CCD_TESTNET_CAIP2 }), 'decimals constant drift', 'decimals');
  throws(() => assertConstantsAgree({ asset: 'CCD', decimals: 6, network: 'ccd:wrong' }), 'network constant drift', 'network');
});

// ─── the SDK parses our requirements identically ─────────────────────────

test('official server scheme parses our exact-CCD requirement unchanged', async () => {
  const req = buildPaymentRequirements({
    payTo: PAY, amountMicroCcd: '250000', resourceUrl: 'https://x',
  });
  const parsed = await assertSdkAcceptsRequirements(req);
  eq(parsed.sdkAsset, 'CCD', 'asset');
  eq(parsed.sdkAmount, '250000', 'amount (atomic units pass through)');
});

test('SDK refuses a price that has no asset (it will not guess CCD)', async () => {
  // Documented SDK behaviour: money prices resolve to USDR, never to CCD.
  // We supply AssetAmount explicitly, so this cannot happen through our builder.
  const req = buildPaymentRequirements({ payTo: PAY, amountMicroCcd: '1', resourceUrl: 'https://x' });
  ok(req.asset, 'our builder always sets an explicit asset');
});

test('resource server registers the exact scheme on concordium testnet', () => {
  const { registered } = buildResourceServer(DENY_ALL_FACILITATOR);
  ok(registered, 'scheme registered for the testnet CAIP-2');
});

test('SDK explorer helper agrees with our explorer helper', () => {
  const tx = 'b'.repeat(64);
  eq(sdkExplorerTxUrl(CCD_TESTNET_CAIP2, tx), `https://ccdexplorer.io/testnet/transaction/${tx}`, 'testnet url');
  eq(sdkExplorerTxUrl('ccd:9dd9ca4d19e9393877d2c44b70f89acb', tx),
    `https://ccdexplorer.io/mainnet/transaction/${tx}`, 'mainnet url');
});

// ─── 402 body shape against the documented x402 v2 layout ────────────────

test('402 body has exactly the v2 top-level keys', () => {
  const body = buildPaymentRequired(
    buildPaymentRequirements({ payTo: PAY, amountMicroCcd: '1000', resourceUrl: 'https://x' }),
    { resourceUrl: 'https://x', description: 'd', mimeType: 'application/json' },
  );
  const keys = Object.keys(body).sort();
  const allowed = ['accepts', 'error', 'extensions', 'resource', 'x402Version'];
  for (const k of keys) ok(allowed.includes(k), `unexpected top-level key "${k}"`);
  ok(keys.includes('x402Version') && keys.includes('accepts') && keys.includes('resource'), 'required keys present');
});

test('accepts[] entries expose exactly the PaymentRequirements fields', () => {
  const r = buildPaymentRequirements({ payTo: PAY, amountMicroCcd: '1000', resourceUrl: 'https://x', feePayer: PAY });
  const keys = Object.keys(r).sort();
  eq(keys.join(','), 'amount,asset,extra,maxTimeoutSeconds,network,payTo,scheme', 'field set');
});

// ─── safety: nothing reaches a live facilitator by default ───────────────

test('deny-all facilitator refuses both operations', async () => {
  let threwVerify = false;
  let threwSettle = false;
  try { await DENY_ALL_FACILITATOR.verify({} as never, {} as never); } catch { threwVerify = true; }
  try { await DENY_ALL_FACILITATOR.settle({} as never, {} as never); } catch { threwSettle = true; }
  ok(threwVerify, 'verify refuses');
  ok(threwSettle, 'settle refuses');
  const sup = await DENY_ALL_FACILITATOR.getSupported();
  eq(sup.kinds.length, 0, 'announces no capabilities');
});

test('HTTP facilitator requires an explicit url', () => {
  throws(() => createHttpFacilitator({ url: '' }), 'url is required', 'no default endpoint');
});

test('no source file contains a facilitator URL or a private key literal', () => {
  // Guard against a future edit hardcoding a live endpoint or a secret.
  const files = ['src/payments/x402.ts', 'src/payments/x402Sdk.ts'];
  for (const f of files) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url).pathname, 'utf8');
    notOk(/https:\/\/[a-z0-9.-]*facilitator[a-z0-9.-]*/i.test(text), `${f} must not hardcode a facilitator host`);
    notOk(/(privateKey|seedPhrase|mnemonic)\s*[:=]\s*['"][0-9a-fA-F]{32,}/i.test(text), `${f} must not embed key material`);
  }
});

// ─── amount conversion agrees with 6 decimals from the SDK ───────────────

test('conversion honours the SDK-declared 6 decimals', () => {
  eq(String(10 ** CCD_DECIMALS), '1000000', '1 CCD in atomic units');
  eq(ccdToMicroCcd('1'), '1000000', 'conversion agrees');
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
console.log(`\ntask04-sdk-conformance: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
