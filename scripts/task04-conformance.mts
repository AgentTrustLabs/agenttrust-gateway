/**
 * TASK 04 — x402 offline conformance check (no network, no settlement).
 *
 * Proves the payment module agrees with the official SDK on constants, price
 * parsing, requirement shape and explorer helpers. Run: npx tsx scripts/task04-conformance.mts
 */

import {
  assertSdkAcceptsRequirements,
  assertConstantsAgree,
  buildResourceServer,
  SDK_TESTNET_CAIP2,
  SDK_CONSTANTS,
  sdkExplorerTxUrl,
} from '../src/payments/x402Sdk.js';
import {
  buildPaymentRequirements,
  buildPaymentRequired,
  CCD_TESTNET_CAIP2,
  CCD_ASSET,
  CCD_DECIMALS,
  X402_VERSION,
  DENY_ALL_FACILITATOR,
} from '../src/payments/x402.js';

const PAY_TO = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';

const req = buildPaymentRequirements({
  payTo: PAY_TO,
  amountMicroCcd: '250000',
  resourceUrl: 'https://api.sabokun.my.id/agenttrust/paid/resource',
  description: 'AgentTrust paid resource',
  mimeType: 'application/json',
  feePayer: PAY_TO,
});

console.log('local requirements :', JSON.stringify(req));
console.log('local CAIP-2       :', CCD_TESTNET_CAIP2);
console.log('SDK   CAIP-2       :', SDK_TESTNET_CAIP2);
console.log('SDK   constants    :', JSON.stringify(SDK_CONSTANTS));

assertConstantsAgree({ asset: CCD_ASSET, decimals: CCD_DECIMALS, network: CCD_TESTNET_CAIP2 });
console.log('constant agreement : OK');

const parsed = await assertSdkAcceptsRequirements(req);
console.log('SDK parsePrice     :', JSON.stringify(parsed));

const body = buildPaymentRequired(req, {
  resourceUrl: 'https://api.sabokun.my.id/agenttrust/paid/resource',
  description: 'AgentTrust paid resource',
  mimeType: 'application/json',
});
console.log('402 body           :', JSON.stringify(body));
console.log('x402Version        :', body.x402Version, '(SDK x402Version =', X402_VERSION, ')');

const { registered } = buildResourceServer(DENY_ALL_FACILITATOR);
console.log('scheme registered  :', registered);

console.log('explorer (SDK)     :', sdkExplorerTxUrl(CCD_TESTNET_CAIP2, 'deadbeef'));
console.log('\nNO NETWORK CALLS · NO SETTLEMENT · NO KEYS');
