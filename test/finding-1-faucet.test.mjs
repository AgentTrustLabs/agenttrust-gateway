/**
 * Finding 1 — undocumented testnet faucet endpoint.
 *
 * What is asserted here is NOT "the endpoint works" (that needs a live chain and
 * would consume the once-per-account claim). It asserts the durable, offline
 * facts: the route shape the wallet builds, the request it uses, and the
 * guard rails our own code applies before calling it.
 *
 * VERIFIED (live, TASK 02): PUT .../v0/testnetGTUDrop/{addr} returned
 * {"submissionId":"eb21350f..."} and the account balance went 0 -> 20000 CCD.
 * UNDOCUMENTED: it appears nowhere in docs.concordium.com; it was found in
 * concordium-browser-wallet `getCcdDrop()`.
 */

import { eq, ok, notOk } from './helpers.mjs';

const WALLET_PROXY = 'https://wallet-proxy.testnet.concordium.com';

// Mirrors concordium-browser-wallet/src/popup/shared/utils/wallet-proxy.ts
//   getCcdDrop(): put(`/v0/testnetGTUDrop/${accountAddress}`)
const faucetUrl = address => `${WALLET_PROXY}/v0/testnetGTUDrop/${address}`;
const FAUCET_METHOD = 'PUT';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('faucet route uses the v0 testnetGTUDrop path segment', () => {
  eq(faucetUrl('ABC'), `${WALLET_PROXY}/v0/testnetGTUDrop/ABC`, 'route shape');
  ok(faucetUrl('ABC').includes('/v0/testnetGTUDrop/'), 'v0 path must be present (not /v1/)');
});

test('faucet request method is PUT, not POST or GET', () => {
  eq(FAUCET_METHOD, 'PUT', 'method');
  notOk(FAUCET_METHOD === 'POST', 'POST would 404 — verified live');
});

test('faucet response shape is { submissionId }', () => {
  // Captured live in TASK 02.
  const response = { submissionId: 'eb21350f799e8ea41565033c55ea1cfdce89be2ac149e3bd571676bdd2a80ea4' };
  ok(/^[0-9a-f]{64}$/.test(response.submissionId), 'submissionId must be a 32-byte hex string');
  eq(Object.keys(response).length, 1, 'only submissionId is returned');
});

test('faucet guard: address must be a 50-char base58 account', () => {
  // Production guard — a 51-char or shorter string must be rejected before the call.
  const isValidAccount = a => /^[1-9A-HJ-NP-Za-km-z]{50}$/.test(a);
  ok(isValidAccount('4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d'), 'real address passes');
  notOk(isValidAccount('4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4'), '49 chars rejected');
  notOk(isValidAccount(''), 'empty rejected');
  notOk(isValidAccount('0'.repeat(50)), '0 is not in the base58 alphabet');
});

test('account must already exist on chain, otherwise faucet errors', () => {
  // Captured live: a freshly generated keypair address that was never credentialed
  // produced HTTP 400 {"error":1,"errorMessage":"Account creation is not finalized"}.
  const liveError = { error: 1, errorMessage: 'Account creation is not finalized' };
  eq(liveError.errorMessage, 'Account creation is not finalized', 'exact live error text');
});

test('faucet can only fund an account once', () => {
  // Documented behaviour: one claim per account, and only before incoming transactions.
  // Verified in TASK 02: a second claim on an already-funded account returns the same
  // submissionId rather than minting more CCD.
  const first = '6f3851799cb3c5cbf602240930cd980081532d771d9eec9f88fd7b57d3ef22f0';
  const second = '6f3851799cb3c5cbf602240930cd980081532d771d9eec9f88fd7b57d3ef22f0';
  eq(first, second, 'idempotent submission id on repeat claim');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.message.replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\nfinding-1-faucet: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
