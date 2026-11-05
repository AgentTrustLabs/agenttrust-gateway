/**
 * TASK 08 — MCP interface: tool surface, input boundary, authorization invariant.
 *
 * Offline. Registry and card fetches are injected, so no network is required and
 * results are deterministic.
 */

import {
  TOOLS,
  TOOL_NAMES,
  callTool,
  toolTrustVerify,
  toolRegistrySearch,
  toolRegistryCard,
  toolTrustPolicy,
  toolCommerceSimulate,
  toolAuditVerify,
  assertNoForbiddenFields,
  assertNetwork,
  assertTokenId,
  assertAmount,
  assertInputSize,
  McpToolError,
  LIMITS,
  type ServerConfig,
} from '../src/mcp/tools.js';
import { AuditTrail } from '../src/audit/trail.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { eq, ok, notOk, throws } from './helpers.mjs';

const CARD_URI = 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json';
const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';

const CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';

/**
 * A card body with the exact shape the live registry anchors — badge extension
 * under `capabilities.extensions`, CAIP-19/CAIP-10 references, and an ERC-8004
 * `registrations` entry. Copied structurally from the published card; the hash is
 * computed from the bytes, so this fixture is self-consistent.
 */
function cardBody(over: Record<string, unknown> = {}) {
  return {
    name: 'AgentTrust',
    description: 'Trust and commerce gateway for independently operated agents',
    version: '1.0.0',
    url: 'https://api.sabokun.my.id/agenttrust',
    provider: { organization: 'AgentTrust', url: 'https://sabokun.my.id' },
    skills: [{ id: 'verify', name: 'verify', description: 'verify an agent' }],
    registrations: [{ agentId: 1004, agentRegistry: `${CAIP2}:12802.0` }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1',
          description: 'Verified by Concordium badge',
          required: false,
          params: {
            tokenAddress: `${CAIP2}/cis-2:JyP9YLib1wYgFmztkcKJL`,
            owner: { account: `${CAIP2}:${OWNER}` },
            agentWallet: `${CAIP2}:${OWNER}`,
            contracts: { cis8004: `${CAIP2}:12802.0`, cis8: `${CAIP2}:12801.0` },
          },
        },
      ],
    },
    ...over,
  };
}

function registryRecord(cardBytes: Uint8Array, over: Record<string, unknown> = {}) {
  return {
    token_id: 1004,
    owner_account: OWNER,
    agent_uri: CARD_URI,
    metadata_hash_hex: createHash('sha256').update(cardBytes).digest('hex'),
    status: 'Active',
    ...over,
  };
}

interface Harness {
  cfg: ServerConfig;
  dir: string;
  calls: string[];
  cleanup: () => void;
}

function harness(opts: { card?: Uint8Array; record?: Record<string, unknown> } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-t08-'));
  const cardBytes = opts.card ?? Buffer.from(JSON.stringify(cardBody()), 'utf8');
  const calls: string[] = [];

  // Shape must match crossAgent.fetchCardBytes: headers.get + arrayBuffer().
  const fetchImpl = (async (url: string) => {
    calls.push(`card:${url}`);
    return {
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
      arrayBuffer: async () =>
        cardBytes.buffer.slice(cardBytes.byteOffset, cardBytes.byteOffset + cardBytes.byteLength),
    };
  }) as never;

  const cfg: ServerConfig = {
    registryBase: 'https://registry.invalid',
    auditRoot: join(dir, 'audit'),
    fetchImpl,
    nowSeconds: 1_700_000_000,
  };
  return { cfg, dir, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Patch the registry call for offline tests by injecting a fake AgentRegistryMcp
 * via the global fetch the registry client uses.
 */
const realFetch = globalThis.fetch;
function stubRegistry(record: unknown, calls: string[] = []) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push(`registry:${body?.params?.name ?? 'list'}:${JSON.stringify(body?.params?.arguments ?? {})}`);
    const name = body?.params?.name;
    const payload =
      name === 'search_agents'
        ? { agents: [record] }
        : name === 'agent_of'
          ? record
          : { ok: true };
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

const tests: [string, () => unknown][] = [];
const test = (name: string, fn: () => unknown) => tests.push([name, fn]);

// ─── 1. tool surface ────────────────────────────────────────────────────

test('01. exactly six tools are exposed, all with closed input schemas', () => {
  eq(TOOLS.length, 6, 'tool count');
  eq(
    TOOL_NAMES.join(','),
    'registry.search,registry.card,trust.verify,trust.policy,commerce.simulate,audit.verify',
    'tool names',
  );
  for (const t of TOOLS) {
    eq((t.inputSchema as { additionalProperties?: unknown }).additionalProperties, false, `${t.name} is closed`);
    eq((t.inputSchema as { type?: unknown }).type, 'object', `${t.name} is an object schema`);
    ok(typeof t.description === 'string' && t.description.length > 20, `${t.name} documents itself`);
  }
});

test('02. no tool can settle, sign, or take a path/URL/credential', () => {
  for (const t of TOOLS) {
    const json = JSON.stringify(t.inputSchema).toLowerCase();
    for (const banned of ['"settle"', 'privatekey', 'seed', 'mnemonic', 'shell', 'command', '"path"', '"url"', '"endpoint"', 'authorization']) {
      notOk(json.includes(banned), `${t.name} must not declare ${banned}`);
    }
    notOk(/settle/i.test(t.name), `${t.name} is not a settlement tool`);
  }
});

test('03. unknown tool names are rejected without a stack trace', async () => {
  const h = harness();
  try {
    const r = await callTool(h.cfg, 'payment.settle', {});
    notOk(r.ok, 'unknown tool rejected');
    if (!r.ok) {
      eq(r.error.code, 'INVALID_INPUT', 'code');
      notOk(/at .*\.ts:\d+/.test(r.error.message), 'no stack frames');
    }
  } finally {
    h.cleanup();
  }
});

// ─── 2. authorization invariant ─────────────────────────────────────────

const AUTH_PAYLOADS: [string, unknown][] = [
  ['authorization object', { token_id: 1004, authorization: { maxAmountMicroCcd: '999999999' } }],
  ['operator_authorization', { token_id: 1004, operator_authorization: { issued_by: 'me' } }],
  ['authorization_id', { token_id: 1004, authorization_id: 'auth_x' }],
  ['nested in expect_owner', { token_id: 1004, nested: { deep: { authorization: {} } } }],
  ['array element', { token_id: 1004, list: [{ OperatorAuthorization: {} }] }],
  ['max amount claim', { token_id: 1004, max_amount_micro_ccd: '1000000000' }],
  ['issued_by', { token_id: 1004, issued_by: 'operator' }],
  ['settle switch', { token_id: 1004, settle: true }],
];

test('04. a client cannot submit an OperatorAuthorization through any tool', async () => {
  const h = harness();
  stubRegistry(registryRecord(Buffer.from(JSON.stringify(cardBody()))));
  try {
    for (const tool of TOOL_NAMES) {
      for (const [label, payload] of AUTH_PAYLOADS) {
        const r = await callTool(h.cfg, tool, payload);
        notOk(r.ok, `${tool} / ${label} must be rejected`);
        if (!r.ok) {
          ok(
            r.error.code === 'AUTHORIZATION_NOT_ACCEPTED' || r.error.code === 'FORBIDDEN_FIELD',
            `${tool} / ${label}: got ${r.error.code}`,
          );
        }
      }
    }
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('05. the authorization rejection names the field and explains the boundary', () => {
  try {
    assertNoForbiddenFields({ token_id: 1004, authorization: { amount: '1' } });
    throw new Error('expected rejection');
  } catch (e) {
    ok(e instanceof McpToolError, 'typed error');
    eq((e as McpToolError).code, 'AUTHORIZATION_NOT_ACCEPTED', 'code');
    ok((e as Error).message.includes('out-of-process'), 'explains where authorization comes from');
    ok((e as Error).message.includes('authorization'), 'names the field');
  }
});

test('06. authorization-shaped fields are rejected even when nested or arrayed', () => {
  const cases = [
    { a: { b: { c: { authorization: {} } } } },
    { list: [{ operator_authorization: {} }] },
    { someAuthorizationX: { nested: { authorization: {} } } },
    { operator_authorization: { deep: [{ value: 1 }] } },
  ];
  for (const c of cases) {
    try {
      assertNoForbiddenFields(c);
      throw new Error(`expected rejection for ${JSON.stringify(c)}`);
    } catch (e) {
      eq((e as McpToolError).code, 'AUTHORIZATION_NOT_ACCEPTED', JSON.stringify(c));
    }
  }
});

test('07. no tool result ever contains an authorization object', async () => {
  const h = harness();
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  stubRegistry(registryRecord(bytes));
  try {
    for (const tool of TOOL_NAMES) {
      const args =
        tool === 'registry.search'
          ? { query: 'x' }
          : tool === 'trust.policy'
            ? { trust_decision: 'TRUSTED', intent: 'paid_resource' }
            : tool === 'audit.verify'
              ? { name: 'missing.jsonl' }
              : { token_id: 1004 };
      const r = await callTool(h.cfg, tool, args);
      const text = JSON.stringify(r).toLowerCase();
      notOk(text.includes('operatorauthorization'), `${tool} must not emit an authorization`);
      notOk(text.includes('maxamountmicroccd'), `${tool} must not emit a ceiling it was never given`);
    }
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

// ─── 3. input validation ────────────────────────────────────────────────

test('08. networks, token ids, and amounts are validated strictly', () => {
  eq(assertNetwork(undefined), 'testnet', 'default network');
  for (const bad of ['main', 'TESTNET', 'ccd:4221', 1, null as never]) {
    throws(() => assertNetwork(bad), 'network', `network ${String(bad)}`);
  }
  eq(assertTokenId(1004), 1004, 'integer token id');
  eq(assertTokenId('1004'), 1004, 'numeric string token id');
  for (const bad of [0, -1, 1.5, 'abc', '', null as never, 2 ** 40]) {
    throws(() => assertTokenId(bad), 'token_id', `token ${String(bad)}`);
  }
  eq(assertAmount('250000'), '250000', 'valid amount');
  for (const bad of ['0', '-1', '1.5', '1e6', '', ' ']) {
    throws(() => assertAmount(bad), 'amount', `amount ${String(bad)}`);
  }
  throws(() => assertAmount(String(BigInt(LIMITS.maxAmountMicroCcd) + 1n)), 'ceiling', 'over ceiling');
});

test('09. oversized input is rejected before any work happens', () => {
  throws(() => assertInputSize({ q: 'x'.repeat(LIMITS.maxInputBytes) }), 'limit', 'oversized body');
  assertInputSize({ q: 'ok' });
});

test('10. search limit bounds and required fields are enforced', async () => {
  const h = harness();
  try {
    for (const limit of [0, 26, 1.5, 'ten']) {
      throwsAsync(async () => toolRegistrySearch(h.cfg, { query: 'x', limit }), 'limit', `limit ${String(limit)}`);
    }
    throwsAsync(async () => toolRegistrySearch(h.cfg, {}), 'query', 'missing query');
    throwsAsync(async () => toolRegistrySearch(h.cfg, { query: 'x'.repeat(LIMITS.maxStringLength + 1) }), 'exceed', 'long query');
  } finally {
    h.cleanup();
  }
});

async function throwsAsync(fn: () => Promise<unknown>, needle: string, label: string) {
  try {
    await fn();
  } catch (e) {
    ok(String((e as Error).message).toLowerCase().includes(needle.toLowerCase()), `${label}: got "${(e as Error).message}"`);
    return;
  }
  throw new Error(`${label}: expected a throw`);
}

// ─── 4. registry + trust tools ──────────────────────────────────────────

test('11. trust.verify reports TRUSTED from independently recomputed evidence', async () => {
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  const h = harness({ card: bytes });
  stubRegistry(registryRecord(bytes));
  try {
    const r = await toolTrustVerify(h.cfg, { token_id: 1004 });
    eq(r.trust_decision, 'TRUSTED', `decision (reasons: ${r.reasons.join(', ')})`);
    eq(r.checks.hash_matches_on_chain, 'PASS', 'hash verified locally');
    eq(r.checks.owner_matches, 'PASS', 'owner verified');
    eq(r.checks.card_retrieved, 'PASS', 'card fetched');
    eq(r.reasons.length, 0, 'no failure reasons');
    eq((r.evidence['hash'] as Record<string, unknown>)['byte_length'], bytes.byteLength, 'evidence records byte count');
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('12. trust.verify rejects a tampered card', async () => {
  const onChain = Buffer.from(JSON.stringify(cardBody()));
  // The registry still anchors the original hash, but the card bytes changed.
  const served = Buffer.from(JSON.stringify(cardBody({ description: 'tampered' })));
  const h = harness({ card: served });
  stubRegistry(registryRecord(onChain));
  try {
    const r = await toolTrustVerify(h.cfg, { token_id: 1004 });
    eq(r.trust_decision, 'REJECTED', 'tampered card is rejected');
    eq(r.checks.hash_matches_on_chain, 'FAIL', 'hash mismatch');
    ok(r.reasons.some(x => x.startsWith('hash_matches_on_chain')), 'reason names the failed check');
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('13. trust.verify rejects an owner pin mismatch', async () => {
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  const h = harness({ card: bytes });
  stubRegistry(registryRecord(bytes));
  try {
    const r = await toolTrustVerify(h.cfg, {
      token_id: 1004,
      expect_owner: '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8',
    });
    eq(r.trust_decision, 'REJECTED', 'owner pin mismatch rejects');
    eq(r.checks.owner_matches, 'FAIL', 'owner check fails');
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('14. registry.card returns bytes, hash, and the card body', async () => {
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  const h = harness({ card: bytes });
  stubRegistry(registryRecord(bytes));
  try {
    const r = await toolRegistryCard(h.cfg, { token_id: 1004 });
    eq(r.card?.byte_length, bytes.byteLength, 'byte length');
    eq(r.card?.sha256, createHash('sha256').update(bytes).digest('hex'), 'sha256 is of the raw bytes');
    eq((r.card?.body as { name?: string })?.name, 'AgentTrust', 'body parsed');
    eq(r.registry.status, 'Active', 'registry status');
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('15. a client cannot point any tool at a different registry', async () => {
  const h = harness();
  try {
    for (const payload of [
      { query: 'x', mcp_base: 'https://evil.test' },
      { token_id: 1004, endpoint: 'https://evil.test/mcp' },
      { token_id: 1004, url: 'https://evil.test/card.json' },
      { token_id: 1004, registry: 'https://evil.test' },
    ]) {
      const r = await callTool(h.cfg, 'trust.verify', payload);
      notOk(r.ok, `must reject ${JSON.stringify(payload)}`);
    }
  } finally {
    h.cleanup();
  }
});

// ─── 5. policy ──────────────────────────────────────────────────────────

test('16. trust policy denies REJECTED and INCONCLUSIVE, allows TRUSTED', async () => {
  const allowed = (await toolTrustPolicy({ trust_decision: 'TRUSTED', intent: 'paid_resource' })) as {
    allowed: boolean;
    code: string;
  };
  ok(allowed.allowed, 'TRUSTED allowed');

  for (const verdict of ['REJECTED', 'INCONCLUSIVE']) {
    const d = (await toolTrustPolicy({ trust_decision: verdict, intent: 'paid_resource' })) as {
      allowed: boolean;
      code: string;
    };
    notOk(d.allowed, `${verdict} denied`);
  }
});

test('17. a client-supplied verdict is labelled as such', async () => {
  const d = (await toolTrustPolicy({ trust_decision: 'TRUSTED', intent: 'paid_resource' })) as {
    verdict_source: string;
    note: string;
  };
  eq(d.verdict_source, 'client_supplied', 'verdict source disclosed');
  ok(d.note.includes('trust.verify'), 'points the caller at the real verifier');
});

test('18. policy names and intents are validated', async () => {
  await throwsAsync(
    async () => toolTrustPolicy({ trust_decision: 'TRUSTED', intent: 'free_money' }),
    'intent',
    'bad intent',
  );
  await throwsAsync(
    async () => toolTrustPolicy({ trust_decision: 'PROBABLY', intent: 'paid_resource' }),
    'trust_decision',
    'bad verdict',
  );
  await throwsAsync(
    async () => toolTrustPolicy({ trust_decision: 'TRUSTED', intent: 'paid_resource', policy: 'lenient' }),
    'policy',
    'bad policy',
  );
});

// ─── 6. commerce simulation ────────────────────────────────────────────

test('19. commerce.simulate grants access but never settles on chain', async () => {
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  const h = harness({ card: bytes });
  stubRegistry(registryRecord(bytes));
  try {
    const r = await toolCommerceSimulate(h.cfg, { token_id: 1004, amount_micro_ccd: '250000' });
    eq(r.stage, 'access_granted', `stage (reason: ${r.reason})`);
    eq(r.granted, true, 'access granted');
    eq(r.simulation.settled, false, 'settled is false');
    eq(r.simulation.facilitator, 'mock', 'mock facilitator');
    eq(r.simulation.calls.join(','), 'verify,settle', 'mock verify then mock settle');
    ok(r.simulation.disclaimer.includes('no transaction was signed'), 'disclaimer present');
    eq(r.receipt?.settled, false, 'receipt marked not settled');
    ok(r.receipt?.simulated_transaction, 'simulated transaction id present');
    ok(r.audit.events > 0, 'audit events written');
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('20. a trust rejection stops commerce before any payment work', async () => {
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  const h = harness({ card: bytes });
  stubRegistry(registryRecord(bytes));
  try {
    const r = await toolCommerceSimulate(h.cfg, {
      token_id: 1004,
      expect_owner: '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8',
    });
    eq(r.stage, 'trust_rejected', 'stage');
    eq(r.granted, false, 'no access');
    eq(r.receipt, null, 'no receipt');
    eq(r.requirement, null, 'no payment requirement was ever built');
    eq(r.simulation.calls.length, 0, 'mock facilitator never called');
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('21. mock payment rejection and settlement failure both deny access', async () => {
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  const h = harness({ card: bytes });
  stubRegistry(registryRecord(bytes));
  try {
    for (const mode of ['reject', 'settle-fail', 'settle-nohash']) {
      const r = await toolCommerceSimulate(h.cfg, { token_id: 1004, mode });
      eq(r.stage, 'payment_rejected', `${mode} stage`);
      eq(r.granted, false, `${mode} no access`);
      eq(r.receipt, null, `${mode} no receipt`);
      eq(r.simulation.settled, false, `${mode} never settled`);
    }
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('22. commerce rejects an amount above the demo ceiling', async () => {
  const h = harness();
  try {
    await throwsAsync(
      async () => toolCommerceSimulate(h.cfg, { token_id: 1004, amount_micro_ccd: '999999999999' }),
      'ceiling',
      'over ceiling',
    );
  } finally {
    h.cleanup();
  }
});

// ─── 7. audit ──────────────────────────────────────────────────────────

test('23. audit.verify reads only bare filenames inside the audit root', async () => {
  const h = harness();
  try {
    for (const name of ['../etc/passwd', '/etc/passwd', 'a/b.jsonl', '..\\win', '…/x']) {
      await throwsAsync(async () => toolAuditVerify(h.cfg, { name }), 'audit', `path ${name}`);
    }
  } finally {
    h.cleanup();
  }
});

test('24. audit.verify detects tampering in a server-written trail', async () => {
  const h = harness();
  const root = h.cfg.auditRoot!;
  const file = join(root, 'trail.jsonl');
  const trail = new AuditTrail({ filePath: file, sessionId: 'cs_mcp' });
  trail.record('agent.discovered', { outcome: 'PASS' });
  trail.record('agent.trust.verified', { outcome: 'PASS' });
  try {
    const good = await toolAuditVerify(h.cfg, { name: 'trail.jsonl' });
    ok(good.ok, `pristine trail verifies (${good.problems.join('; ')})`);
    eq(good.events, 2, 'two events');

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const ev = JSON.parse(lines[0]!);
    ev.outcome = 'FAIL';
    lines[0] = JSON.stringify(ev);
    writeFileSync(file, lines.join('\n') + '\n');

    const bad = await toolAuditVerify(h.cfg, { name: 'trail.jsonl' });
    notOk(bad.ok, 'tampered trail detected');
    ok(bad.problems.length > 0, 'a problem is reported');
  } finally {
    h.cleanup();
  }
});

// ─── 8. no secrets, no stack traces ────────────────────────────────────

test('25. no tool output contains key material or stack traces', async () => {
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  const h = harness({ card: bytes });
  stubRegistry(registryRecord(bytes));
  try {
    const outputs: string[] = [];
    for (const tool of TOOL_NAMES) {
      const args =
        tool === 'registry.search'
          ? { query: 'x' }
          : tool === 'trust.policy'
            ? { trust_decision: 'TRUSTED', intent: 'paid_resource' }
            : tool === 'audit.verify'
              ? { name: 'missing.jsonl' }
              : { token_id: 1004 };
      outputs.push(JSON.stringify(await callTool(h.cfg, tool, args)));
    }
    const joined = outputs.join('\n');
    for (const pattern of [/privateKey/i, /seed ?phrase/i, /mnemonic/i, /passphrase/i, /\b[0-9a-f]{64}\b(?![^]*sha256)/i]) {
      if (pattern.source.includes('[0-9a-f]{64}')) continue; // public hashes are expected
      notOk(pattern.test(joined), `leaked ${pattern}`);
    }
    notOk(/\bat .+\.(ts|js):\d+:\d+/.test(joined), 'no stack frames');
    notOk(joined.includes(process.env['HOME'] ?? '/home/ubuntu'), 'no home directory paths');
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('26. errors from upstream are reduced to one bounded line', async () => {
  const h = harness();
  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:9\n    at Socket.<anonymous> (/app/src/x.ts:1:1)');
  }) as unknown as typeof fetch;
  try {
    const r = await callTool(h.cfg, 'registry.search', { query: 'x' });
    notOk(r.ok, 'upstream failure surfaces');
    if (!r.ok) {
      eq(r.error.code, 'UPSTREAM_ERROR', 'code');
      notOk(r.error.message.includes('\n'), 'single line');
      notOk(/\.ts:\d+/.test(r.error.message), 'no stack frame');
    }
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

// ─── 9. the real MCP transport ─────────────────────────────────────────

test('27. the stdio server answers initialize, tools/list, and a bad method', async () => {
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'does/not/exist', params: {} }),
    'not json at all',
  ].join('\n');

  const out = await runServer(lines + '\n', {});
  const responses = out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));

  eq(responses.length, 4, `four responses (got ${responses.length})`);
  const byId = new Map(responses.map(r => [r.id, r]));
  eq(byId.get(1).result.protocolVersion, '2024-11-05', 'protocol version');
  eq(byId.get(1).result.serverInfo.name, 'agenttrust-gateway', 'server name');
  eq(byId.get(2).result.tools.length, 6, 'tools listed');
  eq(byId.get(3).error.code, -32601, 'unknown method');
  eq(byId.get(null).error.code, -32700, 'parse error');
});

test('28. the server rejects an authorization payload over the wire', async () => {
  const line =
    JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'commerce.simulate', arguments: { token_id: 1004, authorization: { maxAmountMicroCcd: '1' } } },
    }) + '\n';
  const out = await runServer(line, {});
  const res = JSON.parse(out.trim());
  eq(res.result.isError, true, 'flagged as an error result');
  const payload = JSON.parse(res.result.content[0].text);
  eq(payload.error.code, 'AUTHORIZATION_NOT_ACCEPTED', 'authorization refused at the boundary');
});

function runServer(input: string, env: Record<string, string>): Promise<string> {
  return runServerFull(input, env).then(r => {
    if (!r.stdout) throw new Error(`no output; stderr: ${r.stderr.slice(0, 300)}`);
    return r.stdout;
  });
}

/** Run the server to completion, capturing stdout, stderr, and the exit code. */
function runServerFull(
  input: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise(resolve => {
    const p = spawn('node', ['dist/mcp/server.js'], { cwd: process.cwd(), env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => (stdout += String(d)));
    p.stderr.on('data', d => (stderr += String(d)));
    p.on('close', code => resolve({ stdout, stderr, code }));
    p.stdin.end(input);
  });
}

/** Wait for one response, then close stdin and observe a graceful exit. */
function runServerGraceful(
  input: string,
  env: Record<string, string>,
): Promise<{ code: number | null; forced: boolean }> {
  return new Promise(resolve => {
    const p = spawn('node', ['dist/mcp/server.js'], { cwd: process.cwd(), env: { ...process.env, ...env } });
    let seen = '';
    let forced = false;
    p.stdout.on('data', d => {
      seen += String(d);
      if (seen.includes('protocolVersion')) p.stdin.end();
    });
    const timer = setTimeout(() => {
      forced = true;
      p.kill('SIGTERM');
    }, 8000);
    p.on('close', code => {
      clearTimeout(timer);
      resolve({ code, forced });
    });
    p.stdin.write(input);
  });
}


// ─── 10. protocol details required by the task ─────────────────────────

test('29. stdout carries only JSON-RPC; diagnostics never contaminate the stream', async () => {
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
  ].join('\n') + '\n';
  const { stdout, stderr, code } = await runServerFull(lines, {});
  eq(code, 0, 'clean exit');

  // Every stdout line must parse as a JSON-RPC response.
  const parsed = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  eq(parsed.length, 3, 'exactly three responses, no extra lines');
  for (const m of parsed) {
    eq(m.jsonrpc, '2.0', 'jsonrpc version present');
    ok(m.result !== undefined || m.error !== undefined, 'is a response');
  }
  eq(stderr.trim(), '', 'stderr is empty for a clean session');
  notOk(stdout.includes('experimental'), 'no node warnings on stdout');
});

test('30. malformed MCP requests fail safely and keep the server alive', async () => {
  const lines = [
    'this is not json',
    '{"jsonrpc":"2.0"}',
    '{"jsonrpc":"1.0","id":1,"method":"ping"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{}}',
    JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params: {} }),
  ].join('\n') + '\n';
  const { stdout, code } = await runServerFull(lines, {});
  eq(code, 0, 'server survived malformed input');

  const parsed = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  eq(parsed.length, 5, `one response per line (got ${parsed.length})`);
  eq(parsed[0]!.error.code, -32700, 'parse error');
  eq(parsed[1]!.error.code, -32600, 'invalid request (no method)');
  eq(parsed[2]!.error.code, -32600, 'invalid request (wrong version)');
  eq(parsed[3]!.result.isError, true, 'tools/call without a name is an error result');
  eq(parsed[4]!.result.protocolVersion, '2024-11-05', 'server still serving afterwards');
});

test('31. a graceful shutdown exits 0 and leaves no stray process', async () => {
  const { code, forced } = await runServerGraceful(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
    {},
  );
  eq(forced, false, 'exited on stdin close, not by SIGTERM');
  eq(code, 0, 'exit code 0');
});

test('32. the exposed schemas are JSON-Schema shaped and bounded', () => {
  for (const t of TOOLS) {
    const schema = t.inputSchema as Record<string, any>;
    eq(schema['type'], 'object', `${t.name} type`);
    eq(schema['additionalProperties'], false, `${t.name} closed`);
    ok(Array.isArray(schema['required']), `${t.name} declares required`);
    for (const [prop, def] of Object.entries((schema['properties'] ?? {}) as Record<string, any>)) {
      ok(typeof def === 'object' && def !== null, `${t.name}.${prop} has a definition`);
      const bound =
        def['maxLength'] ?? def['maximum'] ?? (Array.isArray(def['enum']) ? def['enum'].length : undefined);
      ok(bound !== undefined, `${t.name}.${prop} is bounded or enumerated`);
      eq(def['format'], undefined, `${t.name}.${prop} does not rely on opaque formats`);
    }
  }
});

test('33. tool output is structured JSON, never prose', async () => {
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  const h = harness({ card: bytes });
  stubRegistry(registryRecord(bytes));
  try {
    for (const tool of TOOL_NAMES) {
      const args =
        tool === 'registry.search'
          ? { query: 'x' }
          : tool === 'trust.policy'
            ? { trust_decision: 'TRUSTED', intent: 'paid_resource' }
            : tool === 'audit.verify'
              ? { name: 'missing.jsonl' }
              : { token_id: 1004 };
      const out = await callTool(h.cfg, tool, args);
      ok(typeof out === 'object' && out !== null, `${tool} returns an object`);
      // Round-trips through JSON without loss.
      eq(JSON.parse(JSON.stringify(out)).ok, (out as { ok: boolean }).ok, `${tool} is serialisable`);
    }
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('34. MCP cannot reach AccountSigner or any signing material', async () => {
  const moduleText = readFileSync('src/mcp/tools.ts', 'utf8') + readFileSync('src/mcp/server.ts', 'utf8');
  for (const banned of ['AccountSigner', 'buildBasicAccountSigner', 'toConcordiumFacilitatorSigner', 'createWallet']) {
    notOk(moduleText.includes(banned), `src/mcp must not reference ${banned}`);
  }
  notOk(/from '@concordium\/web-sdk'/.test(moduleText), 'src/mcp must not import the Concordium SDK');
  notOk(moduleText.includes('privateKey'), 'no private key handling in src/mcp');
});

test('35. MCP cannot trigger real settlement', async () => {
  const moduleText = readFileSync('src/mcp/tools.ts', 'utf8');
  notOk(/createHttpFacilitator/.test(moduleText), 'no http facilitator constructed');
  notOk(/settle:\s*true/.test(moduleText), 'no settle flag is ever enabled');
  notOk(/'settle'\s*\?/.test(moduleText), 'settlement is not client-selectable');

  // And behaviourally: the only facilitator is the mock.
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  const h = harness({ card: bytes });
  stubRegistry(registryRecord(bytes));
  try {
    const r = await toolCommerceSimulate(h.cfg, { token_id: 1004 });
    eq(r.simulation.facilitator, 'mock', 'mock facilitator only');
    eq(r.simulation.settled, false, 'never reports settled');
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('36. an inconclusive agent blocks commerce at the trust gate', async () => {
  const h = harness();
  // Not registered: discovery returns nothing, which is INCONCLUSIVE not consent.
  stubRegistry({});
  try {
    const t = await toolTrustVerify(h.cfg, { token_id: 99999 });
    eq(t.trust_decision, 'INCONCLUSIVE', 'unregistered token is inconclusive');
    eq(t.checks.agent_discovered, 'INCONCLUSIVE', 'discovery inconclusive');
    ok(t.reasons.includes('agent_discovered=INCONCLUSIVE'), 'reason is actionable');

    const c = await toolCommerceSimulate(h.cfg, { token_id: 99999 });
    eq(c.stage, 'trust_rejected', 'commerce refuses');
    eq(c.granted, false, 'no access');
    eq(c.simulation.calls.length, 0, 'facilitator never consulted');
    eq(c.requirement, null, 'no requirement built');
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('37. audit events for a demo run are ordered and complete', async () => {
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  const h = harness({ card: bytes });
  stubRegistry(registryRecord(bytes));
  const root = h.cfg.auditRoot!;
  try {
    const r = await toolCommerceSimulate(h.cfg, { token_id: 1004 });
    const files = readdirSync(root).filter(f => f.endsWith('.jsonl'));
    eq(files.length, 1, 'one trail written');

    const v = await toolAuditVerify(h.cfg, { name: files[0]! });
    ok(v.ok, `trail verifies (${v.problems.join('; ')})`);
    eq(v.events, r.audit.events, 'event count matches the reported count');

    const types = v.summary.map(e => e.type);
    eq(
      types.join(','),
      'agent.discovered,agent.card.retrieved,agent.trust.verified,payment.requirement.created,payment.payload.received,payment.verified,payment.settlement.simulated,commerce.access.granted',
      'events are emitted in flow order',
    );
    eq(v.summary.map(e => e.seq).join(','), '1,2,3,4,5,6,7,8', 'sequence is contiguous');
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

test('38. a rejected commerce run records the rejection, not a grant', async () => {
  const bytes = Buffer.from(JSON.stringify(cardBody()));
  const h = harness({ card: bytes });
  stubRegistry(registryRecord(bytes));
  const root = h.cfg.auditRoot!;
  try {
    await toolCommerceSimulate(h.cfg, { token_id: 1004, expect_owner: '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8' });
    const files = readdirSync(root).filter(f => f.endsWith('.jsonl'));
    const v = await toolAuditVerify(h.cfg, { name: files[0]! });
    const types = v.summary.map(e => e.type);
    ok(types.includes('agent.trust.rejected'), 'rejection is recorded');
    ok(types.includes('commerce.access.denied'), 'denial is recorded');
    notOk(types.includes('commerce.access.granted'), 'no grant is recorded');
    notOk(types.includes('payment.settlement.simulated'), 'no settlement event exists');
  } finally {
    restoreFetch();
    h.cleanup();
  }
});

// ─── runner ────────────────────────────────────────────────────────────

let failed = 0;
let n = 0;
for (const [name, fn] of tests) {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String((e as Error).message).replace(/\n/g, '\n       ')}`);
  }
}
restoreFetch();
console.log(`\ntask08-mcp-interface: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
