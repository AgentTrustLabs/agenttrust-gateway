/**
 * Cross-agent verification — the consumer side of AgentTrust.
 *
 * An independent agent uses this to decide whether to transact with a CIS-8004
 * registered agent. It deliberately does NOT import AgentTrust's registration
 * code and does NOT trust the hosted badge checker as sole evidence: every check
 * is re-derived locally from bytes it fetched itself.
 *
 * All I/O is injected so the logic is testable offline and the caller controls
 * where the truth comes from.
 */

import { createHash } from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────────

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT_TESTED';
export type TrustDecision = 'TRUSTED' | 'REJECTED' | 'INCONCLUSIVE';

export interface RegistryRecord {
  token_id: number | string;
  owner_account: string;
  agent_uri: string | null;
  metadata_hash_hex: string | null;
  agent_wallet?: string | null;
  status: string;
  registered_at?: string;
  last_event_block?: number;
}

export interface CardFetchResult {
  ok: boolean;
  status: number;
  url: string;
  bytes: Uint8Array | null;
  contentType: string | null;
  error: string | null;
}

export interface BadgeVerification {
  /** Hosted verifier's own verdict, if one was consulted. */
  consulted: boolean;
  raw: Record<string, unknown> | null;
  error: string | null;
}

export interface ContractExpectation {
  network: string;          // CAIP-2, e.g. ccd:4221...
  cis8004: string;          // "12802.0"
  cis8?: string;            // "12801.0"
  tokenId: number;
  /** Expected owner account (base58). Compared against the registry record. */
  ownerAccount?: string;
}

export interface TrustResult {
  agent_discovered: Verdict;
  card_retrieved: Verdict;
  card_valid: Verdict;
  badge_valid: Verdict;
  hash_matches_on_chain: Verdict;
  owner_matches: Verdict;
  status_active: Verdict;
  contract_references_match: Verdict;
  trust_decision: TrustDecision;
  evidence: Record<string, unknown>;
}

// ─── Registry schema introspection ────────────────────────────────────────

export interface ToolSchema {
  name: string;
  required: string[];
  properties: Record<string, unknown>;
}

/** Extract a tool's input schema from a `tools/list` response. */
export function readToolSchema(toolsListResponse: unknown, toolName: string): ToolSchema {
  const tools = (toolsListResponse as { result?: { tools?: unknown[] } })?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error('tools/list response has no result.tools array — schema unknown');
  }
  const tool = tools.find(
    (t): t is { name: string; inputSchema?: { required?: string[]; properties?: Record<string, unknown> } } =>
      typeof t === 'object' && t !== null && (t as { name?: string }).name === toolName,
  );
  if (!tool) throw new Error(`tool "${toolName}" is not registered on this MCP server`);
  const schema = tool.inputSchema ?? {};
  return {
    name: toolName,
    required: [...(schema.required ?? [])],
    properties: schema.properties ?? {},
  };
}

/** Fail loudly if the expected required parameter is gone — never guess. */
export function assertToolAccepts(schema: ToolSchema, param: string): void {
  if (!schema.required.includes(param)) {
    throw new Error(
      `schema drift: "${schema.name}" no longer requires "${param}" (required: ${schema.required.join(', ') || 'none'})`,
    );
  }
}

// ─── Discovery ────────────────────────────────────────────────────────────

/**
 * Validate a search_agents payload. Rejects anything that is not a plausible
 * registry response, so a malformed answer cannot be mistaken for "not found".
 */
export function parseDiscoveryResponse(
  payload: unknown,
  expect: { tokenId: number; owner: string },
): { found: boolean; record: RegistryRecord | null; reason: string } {
  if (!payload || typeof payload !== 'object') {
    return { found: false, record: null, reason: 'response is not an object' };
  }
  const agents = (payload as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) {
    return { found: false, record: null, reason: 'response has no agents array' };
  }
  for (const a of agents) {
    if (!a || typeof a !== 'object') continue;
    const r = a as RegistryRecord;
    if (Number(r.token_id) === expect.tokenId) {
      return { found: true, record: r, reason: 'token_id matched' };
    }
  }
  return { found: false, record: null, reason: `no record with token_id ${expect.tokenId} in ${agents.length} result(s)` };
}

// ─── Card retrieval ───────────────────────────────────────────────────────

/** Fetch raw card bytes. The bytes are returned untouched — no parsing, no re-encoding. */
export async function fetchCardBytes(
  url: string,
  fetchImpl: (u: string) => Promise<{
    ok: boolean;
    status: number;
    headers?: { get(n: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
  }>,
): Promise<CardFetchResult> {
  try {
    const res = await fetchImpl(url);
    const contentType = res.headers?.get?.('content-type') ?? null;
    if (!res.ok) {
      return { ok: false, status: res.status, url, bytes: null, contentType, error: `HTTP ${res.status}` };
    }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength === 0) {
      return { ok: false, status: res.status, url, bytes: null, contentType, error: 'empty body' };
    }
    return { ok: true, status: res.status, url, bytes, contentType, error: null };
  } catch (e) {
    return { ok: false, status: 0, url, bytes: null, contentType: null, error: (e as Error).message };
  }
}

// ─── Card validation ──────────────────────────────────────────────────────

export const BADGE_EXTENSION_URI = 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1';
const A2A_REQUIRED = ['name', 'description', 'url', 'version', 'skills'] as const;

export interface CardCheck {
  ok: boolean;
  json: Record<string, any> | null;
  errors: string[];
  warnings: string[];
  parsedFromBytes: boolean;
}

/** Parse and structurally validate a card without modifying the bytes used for hashing. */
export function validateCard(bytes: Uint8Array): CardCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, json: null, errors: ['body is not valid UTF-8'], warnings, parsedFromBytes: false };
  }

  let json: Record<string, any>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, json: null, errors: ['body is valid JSON but not an object'], warnings, parsedFromBytes: false };
    }
    json = parsed as Record<string, any>;
  } catch (e) {
    return { ok: false, json: null, errors: [`body is not valid JSON: ${(e as Error).message}`], warnings, parsedFromBytes: false };
  }

  for (const field of A2A_REQUIRED) {
    if (json[field] === undefined || json[field] === null || json[field] === '') {
      errors.push(`missing required A2A field: ${field}`);
    }
  }
  if (json.skills !== undefined && !Array.isArray(json.skills)) errors.push('skills must be an array');
  if (Array.isArray(json.skills) && json.skills.length === 0) warnings.push('skills is empty');

  const ext = (json.capabilities?.extensions ?? []).find?.(
    (e: any) => e?.uri === BADGE_EXTENSION_URI,
  );
  if (!ext) {
    errors.push(`missing Concordium badge extension (${BADGE_EXTENSION_URI})`);
  } else {
    if (ext.params?.tokenAddress === undefined || ext.params?.tokenAddress === null) {
      errors.push('badge extension params.tokenAddress is missing');
    }
    if (!ext.params?.owner?.account) errors.push('badge extension params.owner.account is missing');
    if (!ext.params?.contracts?.cis8004) errors.push('badge extension params.contracts.cis8004 is missing');
  }

  if (json.registrations !== undefined && !Array.isArray(json.registrations)) {
    warnings.push('registrations should be an array (ERC-8004)');
  }

  return { ok: errors.length === 0, json, errors, warnings, parsedFromBytes: true };
}

// ─── Identity comparison ──────────────────────────────────────────────────

/**
 * Compare the card's own identity claims against the registry record.
 * The registry is the authority; the card is the claim being checked.
 */
export function compareCardToRecord(
  card: Record<string, any>,
  record: RegistryRecord,
  expect: ContractExpectation,
): { owner_matches: Verdict; contract_references_match: Verdict; details: Record<string, unknown> } {
  const params = card?.capabilities?.extensions?.find?.((e: any) => e?.uri === BADGE_EXTENSION_URI)?.params;
  const details: Record<string, unknown> = {};

  // owner
  const badgeOwnerCaip = params?.owner?.account as string | undefined;
  const expectedOwnerCaip = `${expect.network}:${record.owner_account}`;
  details.badge_owner = badgeOwnerCaip ?? null;
  details.record_owner = record.owner_account;
  details.expected_owner_caip = expectedOwnerCaip;
  let owner: Verdict;
  if (!badgeOwnerCaip) owner = 'FAIL';
  else if (badgeOwnerCaip === expectedOwnerCaip) owner = 'PASS';
  else owner = 'FAIL';

  // contract references
  const expectedCis8004 = `${expect.network}:${expect.cis8004}`;
  const expectedCis8 = expect.cis8 ? `${expect.network}:${expect.cis8}` : null;
  details.cis8004 = params?.contracts?.cis8004 ?? null;
  details.expected_cis8004 = expectedCis8004;
  details.cis8 = params?.contracts?.cis8 ?? null;
  details.expected_cis8 = expectedCis8;

  const problems: string[] = [];
  if (params?.contracts?.cis8004 !== expectedCis8004) problems.push('cis8004 contract reference mismatch or missing');
  if (expectedCis8 && params?.contracts?.cis8 !== expectedCis8) problems.push('cis8 contract reference mismatch or missing');

  // token address must resolve to the expected token id
  const tokenAddress = params?.tokenAddress as string | undefined;
  details.token_address = tokenAddress ?? null;
  const expectedAsset = `${expect.network}/cis-2:`;
  if (!tokenAddress || !tokenAddress.startsWith(expectedAsset)) {
    problems.push(`tokenAddress is not a ${expectedAsset}… CAIP-19 reference`);
  }

  // registrations entry (ERC-8004)
  const reg = Array.isArray(card?.registrations)
    ? card.registrations.find((r: any) => Number(r?.agentId) === expect.tokenId)
    : undefined;
  details.registration_entry = reg ?? null;
  if (!reg) problems.push('card has no ERC-8004 registrations entry for this token id');
  else if (reg.agentRegistry !== expectedCis8004) problems.push('registrations.agentRegistry does not match the CIS-8004 contract');

  return {
    owner_matches: owner,
    contract_references_match: problems.length === 0 ? 'PASS' : 'FAIL',
    details: { ...details, contract_problems: problems },
  };
}

// ─── Local cryptographic verification ─────────────────────────────────────

/**
 * SHA-256 over the exact bytes served at agent_uri.
 *
 * No canonicalisation, no JSON re-serialisation, no whitespace trimming: the
 * on-chain metadata_hash is the digest of the byte sequence as published.
 * Returns the digest plus the length so a reviewer can reproduce it.
 */
export function localSha256(bytes: Uint8Array): { hex: string; byteLength: number; procedure: string } {
  return {
    hex: createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
    byteLength: bytes.byteLength,
    procedure: 'sha256(exact response body bytes, no normalisation)',
  };
}

export function compareHashes(localHex: string, record: RegistryRecord): Verdict {
  if (!record.metadata_hash_hex) return 'INCONCLUSIVE';
  const onChain = record.metadata_hash_hex.toLowerCase().replace(/^0x/, '');
  return localHex.toLowerCase() === onChain ? 'PASS' : 'FAIL';
}

// ─── Trust decision ───────────────────────────────────────────────────────

const REQUIRED_CHECKS = [
  'agent_discovered',
  'card_retrieved',
  'card_valid',
  'hash_matches_on_chain',
  'owner_matches',
  'status_active',
  'contract_references_match',
] as const;

/**
 * TRUSTED requires every required check to be PASS.
 * A single FAIL or INCONCLUSIVE yields REJECTED or INCONCLUSIVE respectively —
 * never TRUSTED. `badge_valid` is advisory: a third-party checker disagreeing
 * is recorded but does not by itself override locally-derived evidence.
 */
export function decideTrust(checks: Record<string, Verdict>): TrustDecision {
  const values = REQUIRED_CHECKS.map(k => checks[k] ?? 'NOT_TESTED');
  if (values.some(v => v === 'FAIL')) return 'REJECTED';
  if (values.some(v => v !== 'PASS')) return 'INCONCLUSIVE';
  return 'TRUSTED';
}

export interface VerifyInputs {
  expect: ContractExpectation;
  /** Result of search_agents (already parsed JSON). */
  discoveryPayload: unknown;
  /** Injected fetch for the card. */
  fetchImpl: Parameters<typeof fetchCardBytes>[1];
  /** Optional hosted-verifier result; treated as corroboration only. */
  badge?: BadgeVerification;
}

/** End-to-end consumer verification. Pure orchestration over injected I/O. */
export async function verifyAgent(inputs: VerifyInputs): Promise<TrustResult> {
  const { expect, discoveryPayload, fetchImpl, badge } = inputs;
  const evidence: Record<string, unknown> = {};
  const checks: Record<string, Verdict> = {
    agent_discovered: 'NOT_TESTED',
    card_retrieved: 'NOT_TESTED',
    card_valid: 'NOT_TESTED',
    badge_valid: 'NOT_TESTED',
    hash_matches_on_chain: 'NOT_TESTED',
    owner_matches: 'NOT_TESTED',
    status_active: 'NOT_TESTED',
    contract_references_match: 'NOT_TESTED',
  };

  // 1. discovery
  const disc = parseDiscoveryResponse(discoveryPayload, {
    tokenId: expect.tokenId,
    owner: expect.ownerAccount ?? '',
  });
  evidence.discovery = { found: disc.found, reason: disc.reason, record: disc.record };
  checks.agent_discovered = disc.found ? 'PASS' : 'INCONCLUSIVE';
  if (!disc.record) {
    return finish(checks, evidence);
  }
  const record = disc.record;

  // If the caller declared an expected owner, the registry record must agree with it.
  // A record pointing at a different account is a hard failure: the caller's pin is
  // the stronger claim, and a card that merely agrees with the record proves nothing
  // about the owner the caller actually expects.
  const ownerPinFailed = Boolean(expect.ownerAccount) && record.owner_account !== expect.ownerAccount;
  if (ownerPinFailed) {
    evidence.discovery_owner_mismatch = {
      expected: expect.ownerAccount,
      recorded: record.owner_account,
      verdict: 'FAIL',
    };
  }

  // 2. status
  checks.status_active = record.status === 'Active' ? 'PASS' : record.status === 'Revoked' ? 'FAIL' : 'INCONCLUSIVE';
  evidence.status = record.status;

  // 3. card retrieval
  if (!record.agent_uri) {
    evidence.card = { error: 'registry record has no agent_uri' };
    checks.card_retrieved = 'FAIL';
    return finish(checks, evidence);
  }
  const fetched = await fetchCardBytes(record.agent_uri, fetchImpl);
  evidence.card = {
    url: fetched.url,
    http_status: fetched.status,
    byte_length: fetched.bytes?.byteLength ?? null,
    content_type: fetched.contentType,
    error: fetched.error,
  };
  checks.card_retrieved = fetched.ok && fetched.bytes ? 'PASS' : 'FAIL';
  if (!fetched.ok || !fetched.bytes) {
    return finish(checks, evidence);
  }

  // 4. card structure
  const cardCheck = validateCard(fetched.bytes);
  evidence.card_validation = { errors: cardCheck.errors, warnings: cardCheck.warnings };
  checks.card_valid = cardCheck.ok ? 'PASS' : 'FAIL';

  // 5. local hash vs on-chain
  const local = localSha256(fetched.bytes);
  const hashVerdict = compareHashes(local.hex, record);
  evidence.hash = {
    local_sha256: local.hex,
    on_chain_sha256: record.metadata_hash_hex,
    byte_length: local.byteLength,
    procedure: local.procedure,
    verdict: hashVerdict,
  };
  checks.hash_matches_on_chain = hashVerdict;

  // 6/7. identity + contract references (needs a parseable card)
  if (cardCheck.json) {
    const cmp = compareCardToRecord(cardCheck.json, record, expect);
    evidence.identity = cmp.details;
    checks.owner_matches = ownerPinFailed ? 'FAIL' : cmp.owner_matches;
    checks.contract_references_match = cmp.contract_references_match;
  } else {
    checks.owner_matches = 'INCONCLUSIVE';
    checks.contract_references_match = 'INCONCLUSIVE';
  }

  // 8. hosted badge checker — corroboration only
  if (badge?.consulted) {
    evidence.badge = { raw: badge.raw, error: badge.error };
    if (badge.error) checks.badge_valid = 'INCONCLUSIVE';
    else {
      const v = (badge.raw as { badge_valid?: unknown })?.badge_valid;
      checks.badge_valid = v === true ? 'PASS' : v === false ? 'FAIL' : 'INCONCLUSIVE';
    }
  } else {
    checks.badge_valid = 'NOT_TESTED';
  }

  return finish(checks, evidence);
}

function finish(checks: Record<string, Verdict>, evidence: Record<string, unknown>): TrustResult {
  return {
    agent_discovered: checks.agent_discovered!,
    card_retrieved: checks.card_retrieved!,
    card_valid: checks.card_valid!,
    badge_valid: checks.badge_valid!,
    hash_matches_on_chain: checks.hash_matches_on_chain!,
    owner_matches: checks.owner_matches!,
    status_active: checks.status_active!,
    contract_references_match: checks.contract_references_match!,
    trust_decision: decideTrust(checks),
    evidence,
  };
}
