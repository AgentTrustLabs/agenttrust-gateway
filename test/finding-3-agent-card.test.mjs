/**
 * Finding 3 — post-registration token identity in the Agent Card.
 *
 * Two-part finding, both verified live in TASK 02:
 *
 *   (a) `build_agent_card` LEFT `params.tokenAddress` null even when `token_id`
 *       was supplied, because it was called through our typed wrapper which did
 *       not forward the field. With `token_id` actually forwarded, the tool DOES
 *       populate tokenAddress + the ERC-8004 `registrations` entry.
 *
 *   (b) When the card was built pre-mint (token_id unknown), `build_agent_badge`
 *       is the tool that merges the badge block into an existing card.
 *
 * The regression suite pins both: fixtures are captured MCP responses, and the
 * on-chain v2 card must be byte-identical to the fixture with token_id=1004.
 */

import { eq, ok, notOk, readJson, readText, sha256Hex, TASK02, EVIDENCE, FIXTURES } from './helpers.mjs';

const cardFix = readJson(`${FIXTURES}mcp-build-agent-card-token1004.json`);
const badgeFix = readJson(`${FIXTURES}mcp-build-agent-badge-token1004.json`);
const onChainCard = readText(`${EVIDENCE}agent-card.v2.json`);
const preMintCard = readJson(`${EVIDENCE}agent-card.json`);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('card with token_id carries a non-null CAIP-19 tokenAddress', () => {
  const card = JSON.parse(cardFix.agent_card_json);
  const params = card.capabilities.extensions[0].params;
  ok(params.tokenAddress, 'tokenAddress must be present');
  eq(
    params.tokenAddress,
    `${TASK02.caip2}/cis-2:${TASK02.tokenAddress}`,
    'tokenAddress is CAIP-2 chain + CAIP-19 cis-2 asset',
  );
});

test('card with token_id carries an ERC-8004 registrations entry', () => {
  const card = JSON.parse(cardFix.agent_card_json);
  ok(Array.isArray(card.registrations), 'registrations must be an array');
  eq(card.registrations.length, 1, 'exactly one registration');
  eq(card.registrations[0].agentId, TASK02.tokenId, 'agentId equals token id');
  eq(
    card.registrations[0].agentRegistry,
    `${TASK02.caip2}:${TASK02.contractIndex}.0`,
    'agentRegistry is the CIS-8004 contract as CAIP-10',
  );
});

test('pre-mint card has tokenAddress null (the failure mode)', () => {
  const params = preMintCard.capabilities.extensions[0].params;
  eq(params.tokenAddress, null, 'pre-mint tokenAddress is null');
  notOk('registrations' in preMintCard, 'pre-mint card has no registrations entry');
});

test('build_agent_card with token_id reproduces the on-chain v2 card byte-for-byte', () => {
  eq(cardFix.agent_card_json, onChainCard, 'fixture vs on-chain anchored bytes');
  eq(sha256Hex(Buffer.from(cardFix.agent_card_json, 'utf8')), TASK02.cardSha256, 'recomputed sha256');
  eq(Buffer.byteLength(cardFix.agent_card_json, 'utf8'), TASK02.cardBytes, 'byte length');
});

test('build_agent_badge merges the badge into an existing card and keeps the hash', () => {
  eq(badgeFix.metadata_hash_hex, TASK02.cardSha256, 'badge tool returns the anchored hash');
  eq(badgeFix.token_address, TASK02.tokenAddress, 'resolved token address');
  const card = JSON.parse(badgeFix.agent_card_json);
  ok(card.capabilities.extensions[0].params.tokenAddress, 'badge card has tokenAddress');
});

test('badge card and card-tool output converge on the same anchored bytes', () => {
  eq(badgeFix.agent_card_json, cardFix.agent_card_json, 'both tools produce identical card bytes');
});

test('hosted verifier accepts the anchored card (recorded verdict)', () => {
  // Recorded live: GET /v1/check-badge/JyP9YLib1wYgFmztkcKJL -> badge_valid true, issues [].
  const verdict = {
    badge_valid: true,
    issues: [],
    checks: {
      on_chain_agent_found: true,
      status_active: true,
      has_agent_uri: true,
      card_fetched: true,
      hash_matches_on_chain: true,
      badge_present: true,
      badge_embedding: 'extension',
      badge_well_formed: true,
      token_address_matches: true,
      owner_matches: true,
      contracts_match: true,
      verify_present: true,
      extension_conformant: true,
      verification_present: true,
      verify_url_matches: true,
    },
  };
  ok(verdict.badge_valid, 'badge must be valid');
  eq(verdict.issues.length, 0, 'no issues');
  for (const [check, value] of Object.entries(verdict.checks)) {
    ok(value, `check ${check} must pass`);
  }
});

test('every on-chain reference in the card is a CAIP identifier', () => {
  const card = JSON.parse(cardFix.agent_card_json);
  const p = card.capabilities.extensions[0].params;
  ok(p.tokenAddress.startsWith(`${TASK02.caip2}/cis-2:`), 'tokenAddress CAIP-19');
  ok(p.owner.account.startsWith(`${TASK02.caip2}:`), 'owner.account CAIP-10');
  eq(p.contracts.cis8004, `${TASK02.caip2}:${TASK02.contractIndex}.0`, 'cis8004 CAIP-10');
  eq(p.contracts.cis8, `${TASK02.caip2}:${TASK02.cis8Index}.0`, 'cis8 CAIP-10');
});

test('card extension URI is the published Concordium badge extension', () => {
  const card = JSON.parse(cardFix.agent_card_json);
  eq(
    card.capabilities.extensions[0].uri,
    'https://docs.concordium.com/a2a-extensions/concordium-badge/v1',
    'extension uri',
  );
  eq(card.capabilities.extensions[0].required, false, 'extension is optional');
});

test('card satisfies the A2A v1.0 shape', () => {
  const card = JSON.parse(cardFix.agent_card_json);
  for (const field of ['name', 'description', 'url', 'version', 'skills']) {
    ok(card[field], `A2A field ${field} must be present`);
  }
  ok(Array.isArray(card.skills) && card.skills.length > 0, 'at least one skill');
  ok(Array.isArray(card.defaultInputModes), 'defaultInputModes');
  ok(Array.isArray(card.defaultOutputModes), 'defaultOutputModes');
});

test('typed wrapper forwards token_id (regression guard on mcpClient)', () => {
  // The wrapper must not drop tokenId — that omission is exactly what produced
  // the null tokenAddress and cost an extra on-chain transaction.
  const src = readText(`${process.cwd()}/src/registry/mcpClient.ts`);
  ok(src.includes('token_id: args.tokenId'), 'buildAgentCard must forward token_id');
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
console.log(`\nfinding-3-agent-card: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
