/**
 * TASK 04 — produce the deterministic evidence bundle for the payment module.
 *
 * Offline. No facilitator, no network, no keys, no settlement. Everything here is
 * a local function call whose output is captured to docs/evidence/task04/.
 *
 * Run: npx tsx scripts/task04-evidence.mts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import {
  buildPaymentRequirements,
  buildPaymentRequired,
  preflightPaymentPayload,
  authorizePayment,
  ccdToMicroCcd,
  CCD_TESTNET_CAIP2,
  CCD_ASSET,
  CCD_DECIMALS,
  X402_VERSION,
  DENY_ALL_FACILITATOR,
  type ConsumerFacilitator,
} from '../src/payments/x402.js';
import { assertSdkAcceptsRequirements, SDK_CONSTANTS, SDK_TESTNET_CAIP2 } from '../src/payments/x402Sdk.js';

const OUT = 'docs/evidence/task04';
mkdirSync(OUT, { recursive: true });
const save = (name: string, data: unknown) =>
  writeFileSync(`${OUT}/${name}`, JSON.stringify(data, null, 2));

const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const RESOURCE = 'https://api.sabokun.my.id/agenttrust/paid/resource';
const TX = 'f'.repeat(64);

// ─── 1. requirement ──────────────────────────────────────────────────────
const requirements = buildPaymentRequirements({
  payTo: PAY_TO,
  amountMicroCcd: ccdToMicroCcd('0.25'),
  resourceUrl: RESOURCE,
  description: 'AgentTrust paid resource',
  mimeType: 'application/json',
  feePayer: PAY_TO,
  maxTimeoutSeconds: 120,
});
save('02-payment-requirements.json', {
  requirements,
  notes: {
    asset: 'native CCD (SDK convention: identifier "CCD", 6 decimals)',
    amount: 'atomic units (microCCD)',
    feePayer: 'facilitator sponsor; carried in extra.feePayer per SDK enhancePaymentRequirements()',
  },
});

// ─── 2. 402 response ─────────────────────────────────────────────────────
const paymentRequired = buildPaymentRequired(
  requirements,
  { resourceUrl: RESOURCE, description: 'AgentTrust paid resource', mimeType: 'application/json' },
);
save('03-payment-required-402.json', {
  httpStatus: 402,
  headers: { 'content-type': 'application/json' },
  body: paymentRequired,
});

// ─── 3. a payload shaped like the SDK would produce ──────────────────────
const paymentPayload = {
  x402Version: X402_VERSION,
  accepted: requirements,
  payload: {
    signedTransaction: {
      version: 1,
      header: {
        sender: PAY_TO,
        nonce: 7,
        expiry: Math.floor(Date.now() / 1000) + 300,
        executionEnergyAmount: 300,
        numSignatures: 1,
        sponsor: { account: PAY_TO, numSignatures: 1 },
      },
      payload: { type: 'transfer', toAddress: PAY_TO, amount: requirements.amount },
      signatures: { sender: { '0': { '0': '00' } }, sponsor: {} },
    },
  },
};
save('04-payment-payload.fixture.json', {
  payload: paymentPayload,
  note: 'STRUCTURAL FIXTURE ONLY. The sender signature is a placeholder; this payload is never '
      + 'settled and would be rejected by a real facilitator at rule 8 (sender signature).',
});

// ─── 4. preflight ────────────────────────────────────────────────────────
save('05-preflight.json', {
  valid: preflightPaymentPayload(paymentPayload, requirements),
  amountMismatch: preflightPaymentPayload({ ...paymentPayload, accepted: { ...requirements, amount: '1' } }, requirements),
  wrongVersion: preflightPaymentPayload({ ...paymentPayload, x402Version: 1 }, requirements),
});

// ─── 5. mock facilitator verify + settle (no network) ────────────────────
const calls: string[] = [];
const mockFacilitator: ConsumerFacilitator = {
  async verify() {
    calls.push('verify');
    return { isValid: true, payer: PAY_TO };
  },
  async settle() {
    calls.push('settle');
    return { success: true, transaction: TX, network: CCD_TESTNET_CAIP2, payer: PAY_TO };
  },
  async getSupported() {
    return { kinds: [{ x402Version: X402_VERSION, scheme: 'exact', network: CCD_TESTNET_CAIP2 }] };
  },
};

const settled = await authorizePayment({
  facilitator: mockFacilitator,
  paymentPayload,
  requirements,
  settle: true,
  audit: { agentId: 1004, tokenAddress: 'JyP9YLib1wYgFmztkcKJL', purpose: 'evidence fixture' },
});
save('06-mock-settlement.json', {
  facilitator: 'MOCK — not a real facilitator, no transaction exists',
  calls,
  decision: settled,
});

// ─── 6. denial paths ─────────────────────────────────────────────────────
const NOW = Math.floor(Date.now() / 1000);
const expiredPayload = {
  ...paymentPayload,
  payload: {
    signedTransaction: {
      ...(paymentPayload.payload.signedTransaction),
      header: { ...(paymentPayload.payload.signedTransaction.header), expiry: NOW - 120 },
    },
  },
};
const denyFacilitator: ConsumerFacilitator = {
  async verify() { return { isValid: false, invalidReason: 'amount_mismatch', invalidMessage: 'amount differs' }; },
  async settle() { throw new Error('must not be called'); },
  async getSupported() { return { kinds: [] }; },
};
const failSettle: ConsumerFacilitator = {
  async verify() { return { isValid: true, payer: PAY_TO }; },
  async settle() { return { success: false, transaction: '', network: CCD_TESTNET_CAIP2, errorReason: 'insufficient_funds' }; },
  async getSupported() { return { kinds: [] }; },
};

save('07-denial-paths.json', {
  verifyWithNoFacilitator: await authorizePayment({
    facilitator: DENY_ALL_FACILITATOR, paymentPayload, requirements, settle: true,
  }),
  verifyRejected: await authorizePayment({
    facilitator: denyFacilitator, paymentPayload, requirements, settle: true,
  }),
  settleFailed: await authorizePayment({
    facilitator: failSettle, paymentPayload, requirements, settle: true,
  }),
  verifiedButNotSettled: await authorizePayment({
    facilitator: mockFacilitator, paymentPayload, requirements, settle: false,
  }),
  expiredPayment: await authorizePayment({
    facilitator: mockFacilitator, paymentPayload: expiredPayload, requirements, settle: true, nowSeconds: NOW,
  }),
  wrongNetwork: await authorizePayment({
    facilitator: mockFacilitator,
    paymentPayload: { ...paymentPayload, accepted: { ...requirements, network: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb' } },
    requirements, settle: true,
  }),
  wrongAsset: await authorizePayment({
    facilitator: mockFacilitator,
    paymentPayload: { ...paymentPayload, accepted: { ...requirements, asset: 'USDR' } },
    requirements, settle: true,
  }),
  insufficientAmount: await authorizePayment({
    facilitator: mockFacilitator,
    paymentPayload: { ...paymentPayload, accepted: { ...requirements, amount: '1' } },
    requirements, settle: true,
  }),
  malformedPayload: await authorizePayment({
    facilitator: mockFacilitator, paymentPayload: { x402Version: 2 }, requirements, settle: true,
  }),
});

// ─── 7. SDK cross-check ──────────────────────────────────────────────────
save('08-sdk-crosscheck.json', {
  sdk: {
    testnetCaip2: SDK_TESTNET_CAIP2,
    constants: SDK_CONSTANTS,
    nodeModuleVersion: '2.29.0',
  },
  parsePrice: await assertSdkAcceptsRequirements(requirements),
  agrees: SDK_TESTNET_CAIP2 === CCD_TESTNET_CAIP2 && SDK_CONSTANTS.ccdAsset === CCD_ASSET
    && SDK_CONSTANTS.ccdDecimals === CCD_DECIMALS,
});

console.log('evidence written to', OUT);
console.log('settled (mock)  :', settled.granted, settled.reason);
console.log('no network calls, no keys, no settlement');
