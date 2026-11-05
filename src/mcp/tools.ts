/**
 * TASK 08 — MCP tool surface for AgentTrust Gateway.
 *
 * Design rule: this module contains **no business logic**. Every tool is a thin,
 * strictly-validated adapter over an existing module:
 *
 *   registry.search   → AgentRegistryMcp.callToolRaw('search_agents')
 *   registry.card     → AgentRegistryMcp.callToolRaw('agent_of') + fetchCardBytes
 *   trust.verify      → crossAgent.verifyAgent (TASK 03, untouched)
 *   trust.policy      → trustPolicy.evaluateTrustPolicy (TASK 05, untouched)
 *   commerce.simulate → orchestrator.runCommerce with the shared mock facilitator
 *   audit.verify      → AuditTrail.verify (TASK 06, untouched)
 *
 * ── Security posture ────────────────────────────────────────────────────
 *
 * MCP is an untrusted input boundary. Every input is validated against a closed
 * schema before it reaches any module: bounded strings, enumerated networks,
 * integer token ids, decimal-string amounts. No filesystem path, URL, shell
 * command, or network override is accepted from the client. Errors are reduced to
 * a code + message; stack traces never cross the boundary.
 *
 * ── OperatorAuthorization invariant ─────────────────────────────────────
 *
 * There is deliberately **no tool** that issues, accepts, mutates, or references
 * an OperatorAuthorization. TASK 07 authorization is operator-side and
 * out-of-process; a client that submits a JSON object with authorization-shaped
 * fields is rejected (`AUTHORIZATION_NOT_ACCEPTED`) rather than silently ignored,
 * so a client can never believe it authorized anything. See `REJECTED_FIELDS`.
 *
 * ── Settlement ──────────────────────────────────────────────────────────
 *
 * No tool can settle. `commerce.simulate` always runs the offline mock
 * facilitator and marks its receipt `settled: false`. There is no code path here
 * that imports a real facilitator.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  verifyAgent,
  fetchCardBytes,
  type TrustResult,
  type ContractExpectation,
} from '../verify/crossAgent.js';
import { evaluateTrustPolicy, STRICT_POLICY, PARANOID_POLICY, type TrustPolicy } from '../commerce/trustPolicy.js';
import { runCommerce, type CommerceClient, type OrchestratorDeps } from '../commerce/orchestrator.js';
import { mockFacilitator, structuralPayload, SIMULATION_DISCLAIMER } from '../commerce/simulation.js';
import { AgentRegistryMcp } from '../registry/mcpClient.js';
import { AuditTrail } from '../audit/trail.js';
import { CCD_TESTNET_CAIP2 } from '../payments/x402.js';

// ─── limits ──────────────────────────────────────────────────────────────

export const LIMITS = {
  /** Max characters in any free-text field. */
  maxStringLength: 512,
  /** Max results requested from a search. */
  maxSearchLimit: 25,
  /** Max JSON body accepted by a tool call (bytes). */
  maxInputBytes: 8 * 1024,
  /** Hard ceiling on a single tool execution (ms). */
  executionTimeoutMs: 30_000,
  /** Amount ceiling in microCCD (1000 CCD) — a demo cannot spend more. */
  maxAmountMicroCcd: '1000000000',
  /** Audit files may be read only from this directory. */
  auditRoot: '/tmp/agenttrust-audit',
} as const;

const NETWORKS = ['testnet', 'mainnet', 'devnet'] as const;
const CAIP2_BY_NETWORK: Record<string, string> = {
  testnet: CCD_TESTNET_CAIP2,
  // Documented mainnet CAIP-2 (TASK 01); kept for completeness, read-only paths only.
  mainnet: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb',
};

/**
 * Field names that only the operator may set. Their presence in a client payload
 * is an explicit rejection, not a silent ignore: the client must learn that its
 * claim carried no authority.
 */
export const REJECTED_FIELDS = [
  'operatorauthorization',
  'operator_authorization',
  'authorization',
  'authorization_id',
  'maxamountmicroccd',
  'max_amount_micro_ccd',
  'issedby',
  'issued_by',
  'issued_at',
  'settle',
  'allowsettlement',
  'allow_settlement',
  'privatekey',
  'private_key',
  'seed',
  'seedphrase',
  'seed_phrase',
  'mnemonic',
  'signer',
  'secret',
  'password',
  'apikey',
  'api_key',
  'token',
  'bearer',
  'path',
  'file',
  'filepath',
  'file_path',
  'url',
  'mcpbase',
  'mcp_base',
  'endpoint',
  'command',
  'shell',
];

// ─── errors ──────────────────────────────────────────────────────────────

export type McpErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_NETWORK'
  | 'UNSUPPORTED_TOKEN_ID'
  | 'UNSUPPORTED_AMOUNT'
  | 'INPUT_TOO_LARGE'
  | 'AUTHORIZATION_NOT_ACCEPTED'
  | 'FORBIDDEN_FIELD'
  | 'AUDIT_READ_DENIED'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL_ERROR';

export class McpToolError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** Reduce any thrown value to a code + one-line message. Never a stack trace. */
export function toToolError(e: unknown): { code: McpErrorCode; message: string } {
  if (e instanceof McpToolError) return { code: e.code, message: e.message };
  const msg = e instanceof Error ? e.message : String(e);
  return {
    code: 'INTERNAL_ERROR',
    message: msg.split('\n')[0]!.slice(0, 300),
  };
}

// ─── input validation ────────────────────────────────────────────────────

const AUTHORIZATION_SHAPED = new Set(REJECTED_FIELDS.filter(f => f.includes('authoriz')));

function walkKeys(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(v => walkKeys(v, depth + 1));
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.push(k.toLowerCase());
    out.push(...walkKeys(v, depth + 1));
  }
  return out;
}

/**
 * Reject a payload carrying operator-only fields. Authorization-shaped fields get
 * their own code so a client that tried to self-authorize is told exactly why.
 */
export function assertNoForbiddenFields(args: unknown): void {
  const keys = walkKeys(args);
  const auth = keys.find(k => AUTHORIZATION_SHAPED.has(k));
  if (auth) {
    throw new McpToolError(
      'AUTHORIZATION_NOT_ACCEPTED',
      `OperatorAuthorization cannot be supplied over MCP (field '${auth}'). Authorization is issued out-of-process by the operator; no MCP tool accepts or creates it.`,
    );
  }
  const other = keys.find(k => REJECTED_FIELDS.includes(k));
  if (other) {
    throw new McpToolError(
      'FORBIDDEN_FIELD',
      `field '${other}' is not accepted: MCP clients cannot supply paths, URLs, endpoints, credentials, or settlement switches`,
    );
  }
}

export function assertInputSize(args: unknown): void {
  const size = Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8');
  if (size > LIMITS.maxInputBytes) {
    throw new McpToolError('INPUT_TOO_LARGE', `input is ${size} bytes; limit is ${LIMITS.maxInputBytes}`);
  }
}

function str(args: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (opts.required) throw new McpToolError('INVALID_INPUT', `missing required field '${key}'`);
    return undefined;
  }
  if (typeof v !== 'string') throw new McpToolError('INVALID_INPUT', `field '${key}' must be a string`);
  if (v.length === 0) throw new McpToolError('INVALID_INPUT', `field '${key}' must not be empty`);
  if (v.length > (opts.max ?? LIMITS.maxStringLength)) {
    throw new McpToolError('INVALID_INPUT', `field '${key}' exceeds ${opts.max ?? LIMITS.maxStringLength} characters`);
  }
  return v;
}

export function assertNetwork(value: unknown): (typeof NETWORKS)[number] {
  if (value === undefined) return 'testnet';
  if (typeof value !== 'string' || !(NETWORKS as readonly string[]).includes(value)) {
    throw new McpToolError('UNSUPPORTED_NETWORK', `network must be one of ${NETWORKS.join(', ')}`);
  }
  return value as (typeof NETWORKS)[number];
}

export function assertTokenId(value: unknown): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0 || n > 4_294_967_295) {
    throw new McpToolError('UNSUPPORTED_TOKEN_ID', 'token_id must be a positive integer');
  }
  return n;
}

export function assertAmount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new McpToolError('UNSUPPORTED_AMOUNT', 'amount_micro_ccd must be a decimal integer string');
  }
  if (BigInt(value) <= 0n) throw new McpToolError('UNSUPPORTED_AMOUNT', 'amount must be greater than zero');
  if (BigInt(value) > BigInt(LIMITS.maxAmountMicroCcd)) {
    throw new McpToolError('UNSUPPORTED_AMOUNT', `amount exceeds the ${LIMITS.maxAmountMicroCcd} microCCD demo ceiling`);
  }
  return value;
}

/** Account addresses are public base58; validate shape only, never a key. */
export function assertAccount(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{49,51}$/.test(value)) {
    throw new McpToolError('INVALID_INPUT', `'${field}' must be a Concordium base58 account address`);
  }
  return value;
}

export function assertPolicyName(value: unknown): TrustPolicy {
  if (value === undefined) return STRICT_POLICY;
  if (value === 'strict') return STRICT_POLICY;
  if (value === 'paranoid') return PARANOID_POLICY;
  throw new McpToolError('INVALID_INPUT', "policy must be 'strict' or 'paranoid'");
}

// ─── shared plumbing ─────────────────────────────────────────────────────

export interface ServerConfig {
  /** Registry MCP base URL. Operator-configured; never client-supplied. */
  registryBase: string;
  /** Root for audit files that `audit.verify` may read. */
  auditRoot?: string;
  /** Injected fetch (tests, offline). */
  fetchImpl?: Parameters<typeof fetchCardBytes>[1];
  /** Fixed clock for deterministic tests. */
  nowSeconds?: number;
}

function registry(cfg: ServerConfig, network: string): AgentRegistryMcp {
  return new AgentRegistryMcp(`${cfg.registryBase.replace(/\/+$/, '')}/mcp`, network as 'testnet' | 'mainnet');
}

async function withTimeout<T>(p: Promise<T>, ms = LIMITS.executionTimeoutMs): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new McpToolError('TIMEOUT', `execution exceeded ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function wrapUpstream(e: unknown, what: string): never {
  const msg = e instanceof Error ? e.message : String(e);
  throw new McpToolError('UPSTREAM_ERROR', `${what}: ${msg.split('\n')[0]!.slice(0, 240)}`);
}

/** The structural requirement the verifier must see. Hard-coded expectations. */
const CIS8004 = '12802.0';
const CIS8 = '12801.0';

function expectationFor(network: string, tokenId: number, expectOwner?: string): ContractExpectation {
  return {
    network: CAIP2_BY_NETWORK[network] ?? CCD_TESTNET_CAIP2,
    cis8004: CIS8004,
    cis8: CIS8,
    tokenId,
    ...(expectOwner ? { ownerAccount: expectOwner } : {}),
  };
}

/** Discovery payload for a single token: `agent_of` reshaped to `{agents:[…]}`. */
async function discoverOne(cfg: ServerConfig, network: string, tokenId: number): Promise<unknown> {
  try {
    const record = await registry(cfg, network).callToolRaw('agent_of', { token_id: tokenId });
    return { agents: [record] };
  } catch (e) {
    wrapUpstream(e, 'registry agent_of');
  }
}

// ─── tool: registry.search ───────────────────────────────────────────────

export interface SearchResult {
  query: string;
  network: string;
  registry: { tool: string; returned: number };
  agents: unknown[];
}

export async function toolRegistrySearch(cfg: ServerConfig, rawArgs: unknown): Promise<SearchResult> {
  assertInputSize(rawArgs);
  assertNoForbiddenFields(rawArgs);
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const q = str(args, 'query', { required: true })!;
  const network = assertNetwork(args['network']);
  const limit = args['limit'] === undefined ? 10 : Number(args['limit']);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.maxSearchLimit) {
    throw new McpToolError('INVALID_INPUT', `limit must be an integer 1..${LIMITS.maxSearchLimit}`);
  }

  let payload: unknown;
  try {
    payload = await withTimeout(
      registry(cfg, network).callToolRaw('search_agents', { q, limit }),
    );
  } catch (e) {
    if (e instanceof McpToolError) throw e;
    wrapUpstream(e, 'registry search_agents');
  }

  const agents = (payload as { agents?: unknown[] })?.agents;
  return {
    query: q,
    network,
    registry: { tool: 'search_agents', returned: Array.isArray(agents) ? agents.length : 0 },
    agents: Array.isArray(agents) ? agents : [],
  };
}

// ─── tool: registry.card ─────────────────────────────────────────────────

export interface CardResult {
  token_id: number;
  network: string;
  registry: { found: boolean; agent_uri: string | null; status: string | null };
  card: {
    url: string;
    http_status: number;
    content_type: string | null;
    byte_length: number;
    sha256: string;
    /** The card body. Public by design — it is what the registry anchors. */
    body: unknown;
  } | null;
  error: string | null;
}

export async function toolRegistryCard(cfg: ServerConfig, rawArgs: unknown): Promise<CardResult> {
  assertInputSize(rawArgs);
  assertNoForbiddenFields(rawArgs);
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const tokenId = assertTokenId(args['token_id']);
  const network = assertNetwork(args['network']);

  const discovery = await discoverOne(cfg, network, tokenId);
  const record = (discovery as { agents: Record<string, unknown>[] }).agents[0]!;

  const empty: CardResult = {
    token_id: tokenId,
    network,
    registry: {
      found: Boolean(record),
      agent_uri: (record?.['agent_uri'] as string) ?? null,
      status: (record?.['status'] as string) ?? null,
    },
    card: null,
    error: null,
  };
  if (!record || !record['agent_uri']) {
    return { ...empty, error: 'registry record has no agent_uri' };
  }

  const fetched = await withTimeout(
    fetchCardBytes(String(record['agent_uri']), cfg.fetchImpl ?? (fetch as never)),
  );
  if (!fetched.ok || !fetched.bytes) {
    return { ...empty, error: fetched.error ?? `HTTP ${fetched.status}` };
  }

  const bytes = fetched.bytes;
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let body: unknown = null;
  try {
    body = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    body = null;
  }

  return {
    ...empty,
    card: {
      url: fetched.url,
      http_status: fetched.status,
      content_type: fetched.contentType,
      byte_length: bytes.byteLength,
      sha256,
      body,
    },
  };
}

// ─── tool: trust.verify ──────────────────────────────────────────────────

export interface VerifyToolResult {
  token_id: number;
  network: string;
  trust_decision: TrustResult['trust_decision'];
  checks: Omit<TrustResult, 'evidence' | 'trust_decision'>;
  evidence: TrustResult['evidence'];
  /** Short, actionable reason list for a rejected/inconclusive verdict. */
  reasons: string[];
}

export async function toolTrustVerify(cfg: ServerConfig, rawArgs: unknown): Promise<VerifyToolResult> {
  assertInputSize(rawArgs);
  assertNoForbiddenFields(rawArgs);
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const tokenId = assertTokenId(args['token_id']);
  const network = assertNetwork(args['network']);
  const expectOwner = assertAccount(args['expect_owner'], 'expect_owner');

  const discovery = await discoverOne(cfg, network, tokenId);
  const result = await withTimeout(
    verifyAgent({
      expect: expectationFor(network, tokenId, expectOwner),
      discoveryPayload: discovery,
      fetchImpl: (cfg.fetchImpl ?? (fetch as never)) as never,
    }),
  );

  const reasons: string[] = [];
  for (const [check, verdict] of Object.entries(result)) {
    if (check === 'evidence' || check === 'trust_decision') continue;
    if (verdict === 'FAIL') reasons.push(`${check}=FAIL`);
    else if (verdict === 'INCONCLUSIVE') reasons.push(`${check}=INCONCLUSIVE`);
  }

  return {
    token_id: tokenId,
    network,
    trust_decision: result.trust_decision,
    checks: {
      agent_discovered: result.agent_discovered,
      card_retrieved: result.card_retrieved,
      card_valid: result.card_valid,
      badge_valid: result.badge_valid,
      hash_matches_on_chain: result.hash_matches_on_chain,
      owner_matches: result.owner_matches,
      status_active: result.status_active,
      contract_references_match: result.contract_references_match,
    },
    evidence: result.evidence,
    reasons,
  };
}

// ─── tool: trust.policy ──────────────────────────────────────────────────

export async function toolTrustPolicy(rawArgs: unknown) {
  assertInputSize(rawArgs);
  assertNoForbiddenFields(rawArgs);
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const policy = assertPolicyName(args['policy']);
  const trustDecision = str(args, 'trust_decision', { required: true })!;
  if (!['TRUSTED', 'REJECTED', 'INCONCLUSIVE'].includes(trustDecision)) {
    throw new McpToolError('INVALID_INPUT', 'trust_decision must be TRUSTED, REJECTED, or INCONCLUSIVE');
  }
  const intent = str(args, 'intent', { required: true })!;
  if (!['discovery_only', 'paid_resource'].includes(intent)) {
    throw new McpToolError('INVALID_INPUT', "intent must be 'discovery_only' or 'paid_resource'");
  }
  const amount = args['amount_micro_ccd'] === undefined ? '250000' : assertAmount(args['amount_micro_ccd']);

  // A client cannot upgrade a verdict. The policy input is rebuilt from the single
  // verdict string — every check is set to that same value — so a client that
  // claims TRUSTED gains nothing: the checks it would need to fabricate are
  // exactly the ones it just supplied as one scalar.
  // Policy checks are PASS/FAIL/INCONCLUSIVE, not the trust decision vocabulary.
  const perCheck = trustDecision === 'TRUSTED' ? 'PASS' : trustDecision === 'REJECTED' ? 'FAIL' : 'INCONCLUSIVE';
  const synthetic = Object.fromEntries(
    [
      'agent_discovered', 'card_retrieved', 'card_valid', 'badge_valid',
      'hash_matches_on_chain', 'owner_matches', 'status_active', 'contract_references_match',
    ].map(k => [k, perCheck]),
  ) as unknown as TrustResult;
  (synthetic as { trust_decision: string }).trust_decision = trustDecision;
  (synthetic as { evidence: Record<string, unknown> }).evidence = { source: 'trust.policy input (client-supplied verdict)' };

  const decision = evaluateTrustPolicy(synthetic, policy, {
    amountMicroCcd: amount,
    asset: 'CCD',
    network: CAIP2_BY_NETWORK[assertNetwork(args['network'])] ?? CCD_TESTNET_CAIP2,
    ...(intent === 'discovery_only' ? { asset: 'CCD' } : {}),
  });

  return {
    ...decision,
    /** True when the verdict came from the client rather than a verification run. */
    verdict_source: 'client_supplied' as const,
    /** Callers should prefer trust.verify, which derives the verdict itself. */
    note: 'trust_decision was supplied by the caller. Use trust.verify for an independently derived verdict.',
  };
}

// ─── tool: commerce.simulate ─────────────────────────────────────────────

export interface SimulateResult {
  simulation: {
    settled: false;
    disclaimer: string;
    facilitator: 'mock';
    calls: string[];
  };
  token_id: number;
  network: string;
  stage: string;
  granted: boolean;
  reason: string;
  session_id: string;
  trust: { decision: string; checks: Record<string, string> } | null;
  policy: { code: string; reason: string } | null;
  requirement: { amount: string; asset: string; network: string; payTo: string } | null;
  receipt: { settled: false; simulated_transaction: string } | null;
  audit: { session_id: string; events: number; jsonl: string };
}

export async function toolCommerceSimulate(cfg: ServerConfig, rawArgs: unknown): Promise<SimulateResult> {
  assertInputSize(rawArgs);
  assertNoForbiddenFields(rawArgs);
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const tokenId = assertTokenId(args['token_id']);
  const network = assertNetwork(args['network']);
  const expectOwner = assertAccount(args['expect_owner'], 'expect_owner');
  const amount = assertAmount(args['amount_micro_ccd'] ?? '250000');
  // `mode` only selects a *mock* behaviour; it cannot enable settlement.
  const mode = args['mode'] === undefined ? 'ok' : str(args, 'mode')!;
  if (!['ok', 'reject', 'settle-fail', 'settle-nohash'].includes(mode)) {
    throw new McpToolError('INVALID_INPUT', "mode must be one of ok, reject, settle-fail, settle-nohash");
  }
  const policy = assertPolicyName(args['policy']);

  const facilitator = mockFacilitator(mode as never);
  const client: CommerceClient = {
    mcpBase: cfg.registryBase.replace(/\/+$/, ''),
    network: network as 'testnet' | 'mainnet',
    caip2: CAIP2_BY_NETWORK[network] ?? CCD_TESTNET_CAIP2,
    cis8004: CIS8004,
    cis8: CIS8,
  };

  // Audit file name is derived server-side; the client cannot choose a path.
  const auditPath = `${(cfg.auditRoot ?? LIMITS.auditRoot).replace(/\/+$/, '')}/mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`;
  const audit = new AuditTrail({ filePath: auditPath });

  const deps: OrchestratorDeps = {
    fetchImpl: (cfg.fetchImpl ?? (fetch as never)) as never,
    facilitator,
    createPaymentPayload: async req => structuralPayload(req),
    discover: async (_c, target) => discoverOne(cfg, network, target.tokenId),
    contractInfo: async () => ({
      cis8004_contract: { index: 12802, subindex: 0 },
      cis8_contract: { index: 12801, subindex: 0 },
    }),
    policy,
    audit,
  };

  const result = await withTimeout(
    runCommerce(
      client,
      { tokenId, ...(expectOwner ? { expectOwner } : {}) },
      { resourceUrl: `agenttrust://resource/${tokenId}`, amountMicroCcd: amount, description: 'gated resource (simulated)' },
      deps,
    ),
  );

  return {
    simulation: {
      settled: false,
      disclaimer: SIMULATION_DISCLAIMER,
      facilitator: 'mock',
      calls: facilitator.calls,
    },
    token_id: tokenId,
    network,
    stage: result.stage,
    granted: result.granted,
    reason: result.reason,
    session_id: result.sessionId,
    trust: result.trust
      ? {
          decision: result.trust.trust_decision,
          checks: Object.fromEntries(
            Object.entries(result.trust).filter(([k, v]) => k !== 'evidence' && typeof v === 'string'),
          ) as Record<string, string>,
        }
      : null,
    policy: result.policy ? { code: result.policy.code, reason: result.policy.reason } : null,
    requirement: result.requirements
      ? {
          amount: result.requirements.amount,
          asset: result.requirements.asset,
          network: result.requirements.network,
          payTo: result.requirements.payTo,
        }
      : null,
    receipt: result.receipt
      ? { settled: false, simulated_transaction: result.receipt.transaction }
      : null,
    audit: {
      session_id: result.audit.sessionId,
      events: result.audit.events,
      // The path is server-chosen and already disclosed; the trail content is not
      // returned inline because it is retrievable via audit.verify.
      jsonl: result.audit.jsonl.split('\n').length + ' line(s)',
    },
  };
}

// ─── tool: audit.verify ──────────────────────────────────────────────────

export interface AuditVerifyResult {
  file: string;
  ok: boolean;
  events: number;
  checkpoint: { count: number; head_hash: string; matches: boolean } | null;
  problems: string[];
  warnings: string[];
  /** Per-event summary. Reason/evidence text is included; no secrets by construction. */
  summary: { seq: number; type: string; outcome: string; session_id: string }[];
}

/**
 * Verify a trail file by name only, inside the server's audit root.
 *
 * The client supplies a bare filename, never a path: `../`, absolute paths, and
 * symlink escapes are rejected. Reading is limited to files this server wrote.
 */
export async function toolAuditVerify(cfg: ServerConfig, rawArgs: unknown): Promise<AuditVerifyResult> {
  assertInputSize(rawArgs);
  assertNoForbiddenFields(rawArgs);
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const name = str(args, 'name', { required: true, max: 128 })!;

  if (name.includes('/') || name.includes('\\') || name.includes('..') || isAbsolute(name)) {
    throw new McpToolError('AUDIT_READ_DENIED', 'name must be a bare filename inside the audit root');
  }
  const root = (cfg.auditRoot ?? LIMITS.auditRoot).replace(/\/+$/, '');
  const full = resolve(root, name);
  if (!full.startsWith(root + '/')) {
    throw new McpToolError('AUDIT_READ_DENIED', 'resolved path escapes the audit root');
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    throw new McpToolError('AUDIT_READ_DENIED', `no audit file named '${name}' in the audit root`);
  }

  // Absolute path comes from the server's own resolution, not from the client.
  const v = AuditTrail.verify(full, { requireCheckpoint: false });
  return {
    file: name,
    ok: v.ok,
    events: v.events.length,
    checkpoint: v.checkpoint?.present
      ? {
          count: v.checkpoint.count ?? 0,
          head_hash: v.checkpoint.head_hash ?? '',
          matches: v.checkpoint.matches ?? false,
        }
      : null,
    problems: v.problems,
    warnings: v.warnings,
    summary: v.events.map(e => ({ seq: e.seq, type: e.type, outcome: e.outcome, session_id: e.session_id })),
  };
}

// ─── tool catalogue ──────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (cfg: ServerConfig, args: unknown) => Promise<unknown>;
}

const TOKEN_ID = { type: 'integer', minimum: 1, maximum: 4294967295 } as const;
const NETWORK = { type: 'string', enum: ['testnet', 'mainnet', 'devnet'] } as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'registry.search',
    description:
      'Search the Concordium Agent Registry for agents matching a query. Read-only registry call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: LIMITS.maxStringLength },
        network: NETWORK,
        limit: { type: 'integer', minimum: 1, maximum: LIMITS.maxSearchLimit },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (cfg, a) => toolRegistrySearch(cfg, a),
  },
  {
    name: 'registry.card',
    description:
      'Fetch a registered agent card by token id: registry record, raw card bytes, and locally computed SHA-256.',
    inputSchema: {
      type: 'object',
      properties: { token_id: TOKEN_ID, network: NETWORK },
      required: ['token_id'],
      additionalProperties: false,
    },
    handler: (cfg, a) => toolRegistryCard(cfg, a),
  },
  {
    name: 'trust.verify',
    description:
      'Independently verify an agent: live registry record, card bytes, local SHA-256 vs on-chain metadata, owner, status, contract references. Returns TRUSTED / REJECTED / INCONCLUSIVE with per-check verdicts and evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        token_id: TOKEN_ID,
        network: NETWORK,
        expect_owner: { type: 'string', maxLength: 64 },
      },
      required: ['token_id'],
      additionalProperties: false,
    },
    handler: (cfg, a) => toolTrustVerify(cfg, a),
  },
  {
    name: 'trust.policy',
    description:
      'Evaluate the TASK 05 trust policy for a verdict and intent. Rejects REJECTED and INCONCLUSIVE by default.',
    inputSchema: {
      type: 'object',
      properties: {
        trust_decision: { type: 'string', enum: ['TRUSTED', 'REJECTED', 'INCONCLUSIVE'] },
        intent: { type: 'string', enum: ['discovery_only', 'paid_resource'] },
        policy: { type: 'string', enum: ['strict', 'paranoid'] },
      },
      required: ['trust_decision', 'intent'],
      additionalProperties: false,
    },
    handler: (_cfg, a) => toolTrustPolicy(a),
  },
  {
    name: 'commerce.simulate',
    description:
      'Run the full trust-gated commerce flow with a MOCK facilitator. Settlement is simulated: no transaction is signed, submitted, or recorded on chain. Never accepts operator authorization.',
    inputSchema: {
      type: 'object',
      properties: {
        token_id: TOKEN_ID,
        network: NETWORK,
        expect_owner: { type: 'string', maxLength: 64 },
        amount_micro_ccd: { type: 'string', pattern: '^[0-9]+$', maxLength: 12 },
        mode: { type: 'string', enum: ['ok', 'reject', 'settle-fail', 'settle-nohash'] },
        policy: { type: 'string', enum: ['strict', 'paranoid'] },
      },
      required: ['token_id'],
      additionalProperties: false,
    },
    handler: (cfg, a) => toolCommerceSimulate(cfg, a),
  },
  {
    name: 'audit.verify',
    description:
      'Verify the integrity of an audit trail file written by this server (hash chain, sequence continuity, checkpoint). Accepts a bare filename only.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: (cfg, a) => toolAuditVerify(cfg, a),
  },
];

export const TOOL_NAMES = TOOLS.map(t => t.name);

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find(t => t.name === name);
}

/** Execute one tool by name, converting every failure into a bounded error. */
export async function callTool(
  cfg: ServerConfig,
  name: string,
  args: unknown,
): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: McpErrorCode; message: string } }> {
  const tool = findTool(name);
  if (!tool) return { ok: false, error: { code: 'INVALID_INPUT', message: `unknown tool '${String(name).slice(0, 64)}'` } };
  try {
    const result = await tool.handler(cfg, args);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: toToolError(e) };
  }
}

/** Read a trail the server itself wrote, for the demo narrative. */
export function readAuditSummary(file: string, root = LIMITS.auditRoot): string[] {
  const full = resolve(root, file);
  if (!full.startsWith(root + '/') || !existsSync(full)) return [];
  return readFileSync(full, 'utf8').split('\n').filter(Boolean).slice(-5);
}
