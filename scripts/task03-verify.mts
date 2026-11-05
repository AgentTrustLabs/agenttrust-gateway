/**
 * TASK 03 — live read-only discovery + independent cross-agent verification.
 *
 * Read-only: no transaction is built, signed or submitted. Nothing here writes
 * to the chain. The only network calls are registry reads, a card GET, and a
 * hosted-verifier GET (which is recorded as corroboration, never as authority).
 *
 * Evidence is written verbatim to docs/evidence/task03/.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  readToolSchema,
  assertToolAccepts,
  verifyAgent,
  localSha256,
  BADGE_EXTENSION_URI,
} from '../src/verify/crossAgent.js';

const MCP = 'https://agent-registry-mcp.concordium.com/mcp';
const REST = 'https://agent-registry-mcp.concordium.com';
const NETWORK = 'testnet';
const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const CIS8004 = '12802.0';
const CIS8 = '12801.0';
const TOKEN_ID = 1004;
const TOKEN_ADDRESS = 'JyP9YLib1wYgFmztkcKJL';
const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const EXPECTED_HASH = '3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564';
const OUT = 'docs/evidence/task03';

mkdirSync(OUT, { recursive: true });

const save = (name, data) => {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  writeFileSync(`${OUT}/${name}`, body);
  return body;
};

async function rpc(method: string, params: unknown) {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() & 0x7fffffff, method, params }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status} for ${method}`);
  return res.json();
}

async function call(name: string, args: Record<string, unknown>) {
  const body = await rpc('tools/call', { name, arguments: { network: NETWORK, ...args } });
  if ((body as any).error) throw new Error(`${name}: ${(body as any).error.message}`);
  const text = (body as any).result?.content?.[0]?.text;
  if ((body as any).result?.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name}: non-JSON response`);
  }
}

// ─── 1. Schema introspection (schema may have drifted — verify at runtime) ──
console.log('[1] tools/list — reading live schema');
const toolsList = await rpc('tools/list', {});
save('01-tools-list.raw.json', toolsList);

const searchSchema = readToolSchema(toolsList, 'search_agents');
assertToolAccepts(searchSchema, 'q');
save('02-search-agents-schema.json', {
  tool: searchSchema.name,
  required: searchSchema.required,
  queryParamIs: 'q',
  note: 'Asserted at runtime; "query" is NOT accepted (schema drift guard).',
});
console.log('    search_agents required params:', searchSchema.required.join(', '));

// ─── 2. Discovery ─────────────────────────────────────────────────────────
console.log('[2] search_agents q="AgentTrust"');
const discovery = await call('search_agents', { q: 'AgentTrust', limit: 10 });
save('03-discovery-search.raw.json', discovery);
console.log('    hits:', (discovery as any).count, 'total:', (discovery as any).total);

console.log('[2b] agent_by_token_address (independent of search)');
const byAddress = await call('agent_by_token_address', { token_address: TOKEN_ADDRESS });
save('04-agent-by-token-address.raw.json', byAddress);

console.log('[2c] agent_of (by token id)');
const byId = await call('agent_of', { token_id: TOKEN_ID });
save('05-agent-of.raw.json', byId);

console.log('[2d] is_active + get_agent_wallet');
const active = await call('is_active', { token_id: TOKEN_ID });
const wallet = await call('get_agent_wallet', { token_id: TOKEN_ID });
save('06-active-wallet.json', { is_active: active, agent_wallet: wallet });

console.log('[2e] contract_info (expected on-chain coordinates)');
const contractInfo = await call('contract_info', {});
save('07-contract-info.raw.json', contractInfo);

// ─── 3. Card retrieval — raw bytes, untouched ─────────────────────────────
console.log('[3] GET agent_uri (raw bytes)');
const record = (discovery as any).agents.find((a: any) => Number(a.token_id) === TOKEN_ID);
if (!record) throw new Error('token 1004 not present in discovery results');

const cardRes = await fetch(record.agent_uri);
const status = cardRes.status;
const contentType = cardRes.headers.get('content-type');
const rawBytes = new Uint8Array(await cardRes.arrayBuffer());
writeFileSync(`${OUT}/08-agent-card.raw.json`, Buffer.from(rawBytes));

save('09-card-fetch-meta.json', {
  url: record.agent_uri,
  http_status: status,
  content_type: contentType,
  byte_length: rawBytes.byteLength,
  saved_as: '08-agent-card.raw.json',
  note: 'Byte-for-byte copy of the response body. This is what was hashed.',
});
console.log('    status', status, 'bytes', rawBytes.byteLength);

// ─── 4. Local cryptographic verification ──────────────────────────────────
console.log('[4] local SHA-256');
const local = localSha256(rawBytes);
const procedure = {
  algorithm: 'SHA-256',
  input: 'exact bytes of the HTTP response body at agent_uri',
  input_bytes: rawBytes.byteLength,
  normalisation: 'none — no JSON.parse, no re-serialisation, no whitespace or unicode normalisation',
  local_sha256: local.hex,
  on_chain_sha256: record.metadata_hash_hex,
  expected_sha256: EXPECTED_HASH,
  matches_on_chain: local.hex === record.metadata_hash_hex,
  matches_expected: local.hex === EXPECTED_HASH,
  canonicalisation_assumption:
    'The on-chain metadata_hash is defined as SHA-256 over the published card bytes. ' +
    'No canonical JSON form is specified or applied; therefore any change to the byte ' +
    'sequence (formatting, key order, trailing newline) changes the digest.',
};
save('10-local-sha256.json', procedure);
console.log('    local', local.hex);
console.log('    matches on-chain:', procedure.matches_on_chain);

// ─── 5. Hosted verification (corroboration, not authority) ────────────────
console.log('[5] hosted verifier cross-check');
let badge = { consulted: false, raw: null, error: null };

const verifyCardRes = await fetch(`${REST}/v1/verify-agent-card/${TOKEN_ADDRESS}`);
const verifyCardBody = await verifyCardRes.text();
save('11-verify-agent-card.raw.json', verifyCardBody);

const checkBadgeRes = await fetch(`${REST}/v1/check-badge/${TOKEN_ADDRESS}`);
const checkBadgeBody = await checkBadgeRes.text();
save('12-check-badge.raw.json', checkBadgeBody);

try {
  badge = { consulted: true, raw: JSON.parse(checkBadgeBody), error: null };
} catch (e) {
  badge = { consulted: true, raw: null, error: (e as Error).message };
}
console.log('    badge_valid:', (badge.raw as any)?.badge_valid);

// ─── 6. Cross-agent trust decision ────────────────────────────────────────
console.log('[6] cross-agent verification');
const result = await verifyAgent({
  expect: {
    network: CAIP2,
    cis8004: CIS8004,
    cis8: CIS8,
    tokenId: TOKEN_ID,
    ownerAccount: OWNER,
  },
  discoveryPayload: discovery,
  fetchImpl: (u: string) =>
    fetch(u).then(r => ({
      ok: r.ok,
      status: r.status,
      headers: { get: (n: string) => r.headers.get(n) },
      arrayBuffer: () => r.arrayBuffer(),
    })),
  badge,
});

const finalEvidence = {
  ...result.evidence,
  meta: {
    task: 'TASK 03 — read-only discovery & independent cross-agent verification',
    network: NETWORK,
    caip2: CAIP2,
    token_id: TOKEN_ID,
    token_address: TOKEN_ADDRESS,
    owner: OWNER,
    card_uri: record.agent_uri,
    expected_sha256: EXPECTED_HASH,
    performed_at: new Date().toISOString(),
    transactions_performed: 0,
    registry_schema_verified_at_runtime: true,
    search_param_used: 'q',
    hosted_checker_role: 'corroboration only — never the sole basis for a verdict',
    local_verdict_source: 'bytes fetched by this process, hashed locally',
  },
};

const finalResult = { ...result, evidence: finalEvidence };
save('13-trust-decision.json', finalResult);

// ─── Console summary ──────────────────────────────────────────────────────
const pad = (s: string) => s.padEnd(26);
console.log('\n' + '─'.repeat(58));
for (const key of [
  'agent_discovered',
  'card_retrieved',
  'card_valid',
  'badge_valid',
  'hash_matches_on_chain',
  'owner_matches',
  'status_active',
  'contract_references_match',
] as const) {
  console.log(pad(key), result[key]);
}
console.log('─'.repeat(58));
console.log(pad('TRUST DECISION'), result.trust_decision);
console.log('─'.repeat(58));

// sanity: the badge extension really was found
const cardJson = JSON.parse(Buffer.from(rawBytes).toString('utf8'));
const ext = cardJson?.capabilities?.extensions?.find((e: any) => e?.uri === BADGE_EXTENSION_URI);
console.log('badge extension present:', Boolean(ext));
console.log('card skills:', cardJson?.skills?.length ?? 0);
console.log('evidence written to', OUT);

process.exit(result.trust_decision === 'TRUSTED' ? 0 : 1);
