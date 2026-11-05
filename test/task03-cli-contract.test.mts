/**
 * TASK 03 CLI contract tests — offline.
 *
 * The CLI itself talks to the network, but everything it decides is delegated to
 * src/verify/crossAgent.ts. These tests pin the contracts the CLI depends on:
 *   - owner pinning (--expect-owner) actually fails a mismatched owner
 *   - exit-code-relevant verdicts (TRUSTED / REJECTED / INCONCLUSIVE)
 *   - no path reaches TRUSTED without local byte verification
 *
 * Run with: npm test  (tsx)
 */

import { readFileSync } from 'node:fs';
import {
  verifyAgent,
  decideTrust,
  compareCardToRecord,
  parseDiscoveryResponse,
  localSha256,
} from '../src/verify/crossAgent.js';
import { eq, ok, notOk } from './helpers.mjs';

const FIX = new URL('./fixtures/task03/', import.meta.url).pathname;
const CARD = () => new Uint8Array(readFileSync(`${FIX}agent-card.raw.json`));
const SEARCH = () => JSON.parse(readFileSync(`${FIX}discovery-search.raw.json`, 'utf8'));
const BADGE = () => JSON.parse(readFileSync(`${FIX}check-badge.raw.json`, 'utf8'));

const EXPECT = {
  network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  cis8004: '12802.0',
  cis8: '12801.0',
  tokenId: 1004,
};
const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const OTHER_OWNER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';

const fetchServing = bytes => async () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ─── owner pinning ───────────────────────────────────────────────────────

test('no owner pin: verdict follows the card/record agreement', async () => {
  const r = await verifyAgent({
    expect: { ...EXPECT },
    discoveryPayload: SEARCH(),
    fetchImpl: fetchServing(CARD()),
  });
  eq(r.owner_matches, 'PASS', 'owner');
  eq(r.trust_decision, 'TRUSTED', 'verdict');
});

test('owner pin matches the record: TRUSTED', async () => {
  const r = await verifyAgent({
    expect: { ...EXPECT, ownerAccount: OWNER },
    discoveryPayload: SEARCH(),
    fetchImpl: fetchServing(CARD()),
  });
  eq(r.owner_matches, 'PASS', 'owner');
  eq(r.trust_decision, 'TRUSTED', 'verdict');
});

test('owner pin disagrees with the record: REJECTED (exit code 1)', async () => {
  const r = await verifyAgent({
    expect: { ...EXPECT, ownerAccount: OTHER_OWNER },
    discoveryPayload: SEARCH(),
    fetchImpl: fetchServing(CARD()),
  });
  eq(r.owner_matches, 'FAIL', 'pinned owner is authoritative');
  eq(r.trust_decision, 'REJECTED', 'verdict');
  eq(r.evidence.discovery_owner_mismatch.verdict, 'FAIL', 'mismatch recorded');
  eq(r.evidence.discovery_owner_mismatch.expected, OTHER_OWNER, 'expected owner preserved');
});

test('owner pin cannot be satisfied by a card that merely agrees with a wrong record', async () => {
  // Registry claims OTHER_OWNER and the card agrees with it: internally consistent,
  // but it is not the owner the caller pinned. Must still fail.
  const payload = JSON.parse(JSON.stringify(SEARCH()));
  payload.agents[0].owner_account = OTHER_OWNER;
  const cardObj = JSON.parse(new TextDecoder().decode(CARD()));
  cardObj.capabilities.extensions[0].params.owner.account = `${EXPECT.network}:${OTHER_OWNER}`;
  const bytes = new TextEncoder().encode(JSON.stringify(cardObj, null, 2));

  const r = await verifyAgent({
    expect: { ...EXPECT, ownerAccount: OWNER },
    discoveryPayload: payload,
    fetchImpl: fetchServing(bytes),
  });
  eq(r.owner_matches, 'FAIL', 'pin wins over card/record agreement');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

// ─── verdict plumbing that the CLI maps to exit codes ────────────────────

test('not discovered maps to INCONCLUSIVE (exit code 2)', async () => {
  const r = await verifyAgent({
    expect: { ...EXPECT, tokenId: 888888 },
    discoveryPayload: SEARCH(),
    fetchImpl: fetchServing(CARD()),
  });
  eq(r.agent_discovered, 'INCONCLUSIVE', 'discovery');
  eq(r.trust_decision, 'INCONCLUSIVE', 'verdict');
});

test('hash mismatch maps to REJECTED (exit code 1)', async () => {
  const tampered = new TextEncoder().encode(
    new TextDecoder().decode(CARD()).replace('"version": "1.0.0"', '"version": "1.0.1"'),
  );
  notOk(localSha256(tampered).hex === localSha256(CARD()).hex, 'bytes really did change');
  const r = await verifyAgent({
    expect: { ...EXPECT },
    discoveryPayload: SEARCH(),
    fetchImpl: fetchServing(tampered),
  });
  eq(r.hash_matches_on_chain, 'FAIL', 'hash');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('TRUSTED requires local hash verification, never the hosted checker', async () => {
  // Checker says valid, but the served bytes do not match the on-chain anchor.
  const tampered = new TextEncoder().encode(
    new TextDecoder().decode(CARD()).replace('AgentTrust Gateway', 'AgentTrust Gateway '),
  );
  const r = await verifyAgent({
    expect: { ...EXPECT },
    discoveryPayload: SEARCH(),
    fetchImpl: fetchServing(tampered),
    badge: { consulted: true, raw: BADGE(), error: null },
  });
  eq(r.badge_valid, 'PASS', 'checker still says valid');
  eq(r.hash_matches_on_chain, 'FAIL', 'local bytes disagree');
  eq(r.trust_decision, 'REJECTED', 'checker cannot rescue the verdict');
});

// ─── discovery shape used by the CLI ─────────────────────────────────────

test('CLI discovery picks the requested token out of a multi-result page', () => {
  const payload = {
    agents: [
      { token_id: 1, owner_account: 'a', agent_uri: 'u', metadata_hash_hex: 'h', status: 'Active' },
      { token_id: 1004, owner_account: OWNER, agent_uri: 'u2', metadata_hash_hex: 'h2', status: 'Active' },
    ],
  };
  // verifyAgent finds by token id regardless of position
  return verifyAgent({
    expect: { ...EXPECT },
    discoveryPayload: payload,
    fetchImpl: async () => ({ ok: false, status: 0, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }),
  }).then(r => {
    eq(r.agent_discovered, 'PASS', 'found amid other results');
    eq(r.evidence.discovery.record.token_id, 1004, 'correct record selected');
  });
});

test('ambiguous name search is surfaced, not guessed', () => {
  const payload = {
    agents: [
      { token_id: 1, owner_account: 'a', agent_uri: 'u', metadata_hash_hex: 'h', status: 'Active' },
      { token_id: 2, owner_account: 'b', agent_uri: 'u', metadata_hash_hex: 'h', status: 'Active' },
    ],
  };
  const d = parseDiscoveryResponse(payload, { tokenId: 1004, owner: '' });
  notOk(d.found, 'cannot pick one of two without an id');
});

// ─── contract reference strictness still holds ───────────────────────────

test('card with mainnet contract refs is rejected on testnet', () => {
  const cardObj = JSON.parse(new TextDecoder().decode(CARD()));
  cardObj.capabilities.extensions[0].params.contracts.cis8004 = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb:12802.0';
  const rec = parseDiscoveryResponse(SEARCH(), { tokenId: 1004, owner: '' }).record;
  const c = compareCardToRecord(cardObj, rec, EXPECT);
  eq(c.contract_references_match, 'FAIL', 'chain mismatch detected');
});

test('decideTrust: REJECTED dominates INCONCLUSIVE', () => {
  eq(
    decideTrust({
      agent_discovered: 'PASS',
      card_retrieved: 'PASS',
      card_valid: 'INCONCLUSIVE',
      badge_valid: 'PASS',
      hash_matches_on_chain: 'FAIL',
      owner_matches: 'PASS',
      status_active: 'PASS',
      contract_references_match: 'PASS',
    }),
    'REJECTED',
    'a proven failure outranks an unknown',
  );
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
console.log(`\ntask03-cli-contract: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
