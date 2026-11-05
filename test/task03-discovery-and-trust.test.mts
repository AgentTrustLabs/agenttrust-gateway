/**
 * TASK 03 — regression tests for discovery + cross-agent verification.
 *
 * Fully offline. No network, no chain, no MCP. Fixtures live in test/fixtures/task03/.
 *
 * Positive cases walk the real TASK 03 evidence; negative cases mutate it to prove
 * that every failure mode is detected and that none of them can yield TRUSTED.
 */

import { readFileSync } from 'node:fs';
import {
  readToolSchema,
  assertToolAccepts,
  parseDiscoveryResponse,
  fetchCardBytes,
  validateCard,
  compareCardToRecord,
  localSha256,
  compareHashes,
  decideTrust,
  verifyAgent,
  BADGE_EXTENSION_URI,
} from '../src/verify/crossAgent.js';
import { eq, ok, notOk, throws } from './helpers.mjs';

const FIX = new URL('./fixtures/task03/', import.meta.url).pathname;
const readJson = p => JSON.parse(readFileSync(FIX + p, 'utf8'));
const readBytes = p => new Uint8Array(readFileSync(FIX + p));

const CARD = () => readBytes('agent-card.raw.json');
const SEARCH = () => readJson('discovery-search.raw.json');
const TOOLS = () => readJson('tools-list.raw.json');
const BADGE = () => readJson('check-badge.raw.json');

const EXPECT = {
  network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  cis8004: '12802.0',
  cis8: '12801.0',
  tokenId: 1004,
  ownerAccount: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
};
const EXPECTED_HASH = '3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564';

/** fetch stub that serves fixed bytes / errors. */
const fetchServing = (bytes, init = {}) => async () => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  headers: { get: () => init.contentType ?? 'application/json' },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const fetchFailing = (status = 503) => async () => ({
  ok: false,
  status,
  headers: { get: () => null },
  arrayBuffer: async () => new ArrayBuffer(0),
});

const fetchThrowing = () => async () => {
  throw new Error('ECONNREFUSED');
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ─── schema introspection ────────────────────────────────────────────────

test('reads search_agents schema from a live tools/list payload', () => {
  const s = readToolSchema(TOOLS(), 'search_agents');
  eq(s.name, 'search_agents', 'tool name');
  ok(s.required.includes('q'), 'q is required');
  notOk(s.required.includes('query'), 'query is NOT the parameter');
});

test('assertToolAccepts rejects the wrong parameter name', () => {
  const s = readToolSchema(TOOLS(), 'search_agents');
  throws(() => assertToolAccepts(s, 'query'), 'schema drift', 'query must be rejected');
  assertToolAccepts(s, 'q'); // must not throw
});

test('unknown tool is reported, not silently ignored', () => {
  throws(() => readToolSchema(TOOLS(), 'search_agents_v2'), 'not registered', 'missing tool');
});

test('malformed tools/list payload is rejected', () => {
  throws(() => readToolSchema({}, 'search_agents'), 'no result.tools', 'empty payload');
  throws(() => readToolSchema(null, 'search_agents'), 'no result.tools', 'null payload');
});

// ─── discovery ───────────────────────────────────────────────────────────

test('discovers token 1004 from the live search payload', () => {
  const d = parseDiscoveryResponse(SEARCH(), { tokenId: 1004, owner: EXPECT.ownerAccount });
  ok(d.found, 'must find token 1004');
  eq(d.record.token_id, 1004, 'token id');
  eq(d.record.owner_account, EXPECT.ownerAccount, 'owner');
  eq(d.record.status, 'Active', 'status');
  eq(d.record.metadata_hash_hex, EXPECTED_HASH, 'hash');
});

test('a search result without the target token is not found', () => {
  const d = parseDiscoveryResponse(SEARCH(), { tokenId: 9999, owner: '' });
  notOk(d.found, 'token 9999 must not be found');
  ok(d.reason.includes('9999'), 'reason names the missing token');
});

test('malformed discovery payloads are distinguished from not-found', () => {
  eq(parseDiscoveryResponse(null, { tokenId: 1, owner: '' }).reason, 'response is not an object', 'null');
  eq(parseDiscoveryResponse({}, { tokenId: 1, owner: '' }).reason, 'response has no agents array', 'no agents key');
  eq(parseDiscoveryResponse({ agents: 'x' }, { tokenId: 1, owner: '' }).reason,
    'response has no agents array', 'agents not an array');
});

// ─── card retrieval ──────────────────────────────────────────────────────

test('fetches raw card bytes without modification', async () => {
  const bytes = CARD();
  const r = await fetchCardBytes('https://x/card.json', fetchServing(bytes));
  ok(r.ok, 'fetch ok');
  eq(r.status, 200, 'status');
  eq(r.bytes.byteLength, 2777, 'byte length');
  eq(localSha256(r.bytes).hex, EXPECTED_HASH, 'unmodified bytes hash correctly');
});

test('HTTP error is reported, not treated as an empty card', async () => {
  const r = await fetchCardBytes('https://x/card.json', fetchFailing(503));
  notOk(r.ok, 'must not be ok');
  eq(r.error, 'HTTP 503', 'error carries the status');
  eq(r.bytes, null, 'no bytes');
});

test('network exception is caught', async () => {
  const r = await fetchCardBytes('https://x/card.json', fetchThrowing());
  notOk(r.ok, 'must not be ok');
  ok(r.error.includes('ECONNREFUSED'), 'error surfaced');
});

test('empty body is rejected', async () => {
  const r = await fetchCardBytes('https://x/card.json', fetchServing(new Uint8Array(0)));
  notOk(r.ok, 'empty body is not a card');
  eq(r.error, 'empty body', 'explicit reason');
});

// ─── card validation ─────────────────────────────────────────────────────

test('accepts the real card', () => {
  const c = validateCard(CARD());
  ok(c.ok, `errors: ${c.errors.join('; ')}`);
  eq(c.errors.length, 0, 'no errors');
});

test('rejects non-JSON', () => {
  const c = validateCard(new TextEncoder().encode('<html>404</html>'));
  notOk(c.ok, 'must fail');
  ok(c.errors[0].includes('not valid JSON'), 'reason');
});

test('rejects truncated JSON', () => {
  const bytes = CARD().slice(0, 100);
  const c = validateCard(bytes);
  notOk(c.ok, 'truncated card must fail');
});

test('rejects invalid UTF-8', () => {
  const c = validateCard(new Uint8Array([0xff, 0xfe, 0x00]));
  notOk(c.ok, 'must fail');
  ok(c.errors[0].includes('UTF-8'), 'reason');
});

test('rejects JSON that is not an object', () => {
  const c = validateCard(new TextEncoder().encode('[1,2,3]'));
  notOk(c.ok, 'array is not a card');
});

test('rejects a card missing required A2A fields', () => {
  const card = JSON.parse(new TextDecoder().decode(CARD()));
  delete card.name;
  delete card.skills;
  const c = validateCard(new TextEncoder().encode(JSON.stringify(card)));
  notOk(c.ok, 'must fail');
  ok(c.errors.some(e => e.includes('name')), 'names the missing field');
  ok(c.errors.some(e => e.includes('skills')), 'names skills');
});

test('rejects a card with no Concordium badge extension', () => {
  const card = JSON.parse(new TextDecoder().decode(CARD()));
  card.capabilities.extensions = [];
  const c = validateCard(new TextEncoder().encode(JSON.stringify(card)));
  notOk(c.ok, 'must fail');
  ok(c.errors.some(e => e.includes('badge extension')), 'reason');
});

test('rejects a card whose extension has a null tokenAddress (the TASK 02 bug)', () => {
  const card = JSON.parse(new TextDecoder().decode(CARD()));
  const ext = card.capabilities.extensions.find(e => e.uri === BADGE_EXTENSION_URI);
  ext.params.tokenAddress = null;
  const c = validateCard(new TextEncoder().encode(JSON.stringify(card)));
  notOk(c.ok, 'must fail');
  ok(c.errors.some(e => e.includes('tokenAddress')), 'reason');
});

// ─── identity / contract comparison ──────────────────────────────────────

const cardJson = () => JSON.parse(new TextDecoder().decode(CARD()));
const record = () => parseDiscoveryResponse(SEARCH(), { tokenId: 1004, owner: '' }).record;

test('owner and contract references match the registry record', () => {
  const c = compareCardToRecord(cardJson(), record(), EXPECT);
  eq(c.owner_matches, 'PASS', 'owner');
  eq(c.contract_references_match, 'PASS', 'contracts');
  eq(c.details.contract_problems.length, 0, 'no problems');
});

test('owner mismatch is FAIL', () => {
  const card = cardJson();
  card.capabilities.extensions[0].params.owner.account =
    'ccd:4221332d34e1694168c2a0c0b3fd0f27:3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
  const c = compareCardToRecord(card, record(), EXPECT);
  eq(c.owner_matches, 'FAIL', 'different owner must fail');
});

test('missing badge owner is FAIL, not INCONCLUSIVE', () => {
  const card = cardJson();
  delete card.capabilities.extensions[0].params.owner;
  const c = compareCardToRecord(card, record(), EXPECT);
  eq(c.owner_matches, 'FAIL', 'absent owner is a failure');
});

test('wrong contract index is FAIL', () => {
  const card = cardJson();
  card.capabilities.extensions[0].params.contracts.cis8004 =
    'ccd:4221332d34e1694168c2a0c0b3fd0f27:10082.0';
  const c = compareCardToRecord(card, record(), EXPECT);
  eq(c.contract_references_match, 'FAIL', 'mainnet index on testnet must fail');
});

test('wrong chain in contract reference is FAIL', () => {
  const card = cardJson();
  card.capabilities.extensions[0].params.contracts.cis8004 =
    'ccd:9dd9ca4d19e9393877d2c44b70f89acb:12802.0';
  const c = compareCardToRecord(card, record(), EXPECT);
  eq(c.contract_references_match, 'FAIL', 'mainnet CAIP-2 must fail');
});

test('missing ERC-8004 registration entry is FAIL', () => {
  const card = cardJson();
  delete card.registrations;
  const c = compareCardToRecord(card, record(), EXPECT);
  eq(c.contract_references_match, 'FAIL', 'registrations required');
});

test('registration entry pointing at a different registry is FAIL', () => {
  const card = cardJson();
  card.registrations[0].agentRegistry = 'ccd:4221332d34e1694168c2a0c0b3fd0f27:10082.0';
  const c = compareCardToRecord(card, record(), EXPECT);
  eq(c.contract_references_match, 'FAIL', 'registry mismatch');
});

test('tokenAddress that is not a cis-2 CAIP-19 reference is FAIL', () => {
  const card = cardJson();
  card.capabilities.extensions[0].params.tokenAddress = 'JyP9YLib1wYgFmztkcKJL';
  const c = compareCardToRecord(card, record(), EXPECT);
  eq(c.contract_references_match, 'FAIL', 'bare token address is not acceptable');
});

// ─── hashing ─────────────────────────────────────────────────────────────

test('local SHA-256 matches the on-chain anchor', () => {
  const local = localSha256(CARD());
  eq(local.hex, EXPECTED_HASH, 'digest');
  eq(local.byteLength, 2777, 'byte length');
  eq(compareHashes(local.hex, record()), 'PASS', 'verdict');
});

test('reformatting the card changes the hash and fails the comparison', () => {
  const reformatted = new TextEncoder().encode(
    JSON.stringify(JSON.parse(new TextDecoder().decode(CARD()))),
  );
  const local = localSha256(reformatted);
  notOk(local.hex === EXPECTED_HASH, 'compact JSON must not match the anchor');
  eq(compareHashes(local.hex, record()), 'FAIL', 'verdict is FAIL');
});

test('adding a trailing newline changes the hash', () => {
  const bytes = new Uint8Array([...CARD(), 0x0a]);
  notOk(localSha256(bytes).hex === EXPECTED_HASH, 'trailing newline breaks the anchor');
});

test('missing on-chain hash is INCONCLUSIVE, never PASS', () => {
  const r = { ...record(), metadata_hash_hex: null };
  eq(compareHashes(EXPECTED_HASH, r), 'INCONCLUSIVE', 'cannot confirm without an anchor');
});

// ─── trust decision ──────────────────────────────────────────────────────

const allPass = {
  agent_discovered: 'PASS',
  card_retrieved: 'PASS',
  card_valid: 'PASS',
  badge_valid: 'PASS',
  hash_matches_on_chain: 'PASS',
  owner_matches: 'PASS',
  status_active: 'PASS',
  contract_references_match: 'PASS',
};

test('all checks PASS yields TRUSTED', () => {
  eq(decideTrust(allPass), 'TRUSTED', 'verdict');
});

test('a single FAIL yields REJECTED', () => {
  for (const key of Object.keys(allPass)) {
    if (key === 'badge_valid') continue; // advisory
    eq(decideTrust({ ...allPass, [key]: 'FAIL' }), 'REJECTED', `${key}=FAIL`);
  }
});

test('a single INCONCLUSIVE yields INCONCLUSIVE, never TRUSTED', () => {
  for (const key of Object.keys(allPass)) {
    if (key === 'badge_valid') continue;
    eq(decideTrust({ ...allPass, [key]: 'INCONCLUSIVE' }), 'INCONCLUSIVE', `${key}=INCONCLUSIVE`);
  }
});

test('NOT_TESTED never yields TRUSTED', () => {
  eq(decideTrust({ ...allPass, hash_matches_on_chain: 'NOT_TESTED' }), 'INCONCLUSIVE', 'verdict');
});

test('missing check key is treated as NOT_TESTED', () => {
  const partial = { ...allPass };
  delete partial.card_valid;
  eq(decideTrust(partial), 'INCONCLUSIVE', 'absent check blocks trust');
});

// ─── end-to-end orchestration ────────────────────────────────────────────

test('happy path: TRUSTED with all PASS', async () => {
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: SEARCH(),
    fetchImpl: fetchServing(CARD()),
    badge: { consulted: true, raw: BADGE(), error: null },
  });
  eq(r.trust_decision, 'TRUSTED', 'verdict');
  eq(r.hash_matches_on_chain, 'PASS', 'hash');
  eq(r.owner_matches, 'PASS', 'owner');
  eq(r.badge_valid, 'PASS', 'badge');
  eq(r.evidence.hash.byte_length, 2777, 'evidence records byte length');
});

test('card unavailable: card_retrieved FAIL → REJECTED', async () => {
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: SEARCH(),
    fetchImpl: fetchFailing(404),
    badge: { consulted: false, raw: null, error: null },
  });
  eq(r.card_retrieved, 'FAIL', 'retrieval');
  eq(r.hash_matches_on_chain, 'NOT_TESTED', 'hash never evaluated');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('network error during card fetch → REJECTED', async () => {
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: SEARCH(),
    fetchImpl: fetchThrowing(),
    badge: { consulted: false, raw: null, error: null },
  });
  eq(r.card_retrieved, 'FAIL', 'retrieval');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('hash mismatch: TRUSTED is impossible', async () => {
  const tampered = new TextEncoder().encode(
    new TextDecoder().decode(CARD()).replace('AgentTrust Gateway', 'AgentTrust GatewayX'),
  );
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: SEARCH(),
    fetchImpl: fetchServing(tampered),
    badge: { consulted: true, raw: BADGE(), error: null },
  });
  eq(r.hash_matches_on_chain, 'FAIL', 'hash');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('owner mismatch (registry says someone else) → REJECTED', async () => {
  const payload = JSON.parse(JSON.stringify(SEARCH()));
  payload.agents[0].owner_account = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: payload,
    fetchImpl: fetchServing(CARD()),
    badge: { consulted: false, raw: null, error: null },
  });
  eq(r.owner_matches, 'FAIL', 'card owner disagrees with record');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('agent not discovered → INCONCLUSIVE, card never fetched', async () => {
  let fetched = false;
  const r = await verifyAgent({
    expect: { ...EXPECT, tokenId: 424242 },
    discoveryPayload: SEARCH(),
    fetchImpl: async () => { fetched = true; throw new Error('should not fetch'); },
    badge: { consulted: false, raw: null, error: null },
  });
  eq(r.agent_discovered, 'INCONCLUSIVE', 'discovery');
  eq(r.card_retrieved, 'NOT_TESTED', 'no fetch attempted');
  notOk(fetched, 'fetch must not be called');
  eq(r.trust_decision, 'INCONCLUSIVE', 'verdict');
});

test('revoked agent → REJECTED even with a matching card', async () => {
  const payload = JSON.parse(JSON.stringify(SEARCH()));
  payload.agents[0].status = 'Revoked';
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: payload,
    fetchImpl: fetchServing(CARD()),
    badge: { consulted: false, raw: null, error: null },
  });
  eq(r.status_active, 'FAIL', 'status');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('registry record without agent_uri → REJECTED', async () => {
  const payload = JSON.parse(JSON.stringify(SEARCH()));
  payload.agents[0].agent_uri = null;
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: payload,
    fetchImpl: fetchServing(CARD()),
    badge: { consulted: false, raw: null, error: null },
  });
  eq(r.card_retrieved, 'FAIL', 'cannot retrieve');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('non-JSON card body → card_valid FAIL', async () => {
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: SEARCH(),
    fetchImpl: fetchServing(new TextEncoder().encode('<html>captive portal</html>')),
    badge: { consulted: false, raw: null, error: null },
  });
  eq(r.card_valid, 'FAIL', 'validation');
  eq(r.hash_matches_on_chain, 'FAIL', 'hash of html cannot match');
  eq(r.trust_decision, 'REJECTED', 'verdict');
});

test('hosted checker unavailable does not block a locally-proven TRUSTED', async () => {
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: SEARCH(),
    fetchImpl: fetchServing(CARD()),
    badge: { consulted: true, raw: null, error: 'HTTP 503' },
  });
  eq(r.badge_valid, 'INCONCLUSIVE', 'badge advisory');
  eq(r.trust_decision, 'TRUSTED', 'local evidence is sufficient');
});

test('badge checker reporting false is recorded but does not override local proof', async () => {
  const r = await verifyAgent({
    expect: EXPECT,
    discoveryPayload: SEARCH(),
    fetchImpl: fetchServing(CARD()),
    badge: { consulted: true, raw: { badge_valid: false }, error: null },
  });
  eq(r.badge_valid, 'FAIL', 'recorded');
  eq(r.trust_decision, 'TRUSTED', 'local bytes still authoritative');
  ok(r.evidence.badge.raw, 'disagreement preserved in evidence');
});

// ─── runner ──────────────────────────────────────────────────────────────

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
console.log(`\ntask03-discovery-and-trust: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
