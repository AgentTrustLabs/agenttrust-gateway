/**
 * TASK 05 — commerce orchestration + trust policy + audit trail tests.
 * Fully offline: a stub registry, a stub card fetcher, a mock facilitator.
 *
 * Each test asserts a gate that must hold, and several assert the *ordering*
 * invariant: a blocked stage must leave later stages untouched.
 */

import { runCommerce, type OrchestratorDeps, type CommerceClient } from '../src/commerce/orchestrator.js';
import { evaluateTrustPolicy, STRICT_POLICY, PARANOID_POLICY } from '../src/commerce/trustPolicy.js';
import { AuditTrail, assertNoSecrets } from '../src/audit/trail.js';
import { CCD_TESTNET_CAIP2, X402_VERSION, type ConsumerFacilitator } from '../src/payments/x402.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, ok, notOk, throws } from './helpers.mjs';

const FIX = new URL('./fixtures/task03/', import.meta.url).pathname;
const CARD = () => new Uint8Array(readFileSync(`${FIX}agent-card.raw.json`));
const SEARCH = () => JSON.parse(readFileSync(`${FIX}discovery-search.raw.json`, 'utf8'));

const TOKEN_ID = 1004;
const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const OTHER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';
const TX = 'c'.repeat(64);

const client: CommerceClient = {
  mcpBase: 'https://registry.invalid',
  network: 'testnet',
  caip2: CCD_TESTNET_CAIP2,
  cis8004: '12802.0',
  cis8: '12801.0',
};

const REQUEST = {
  resourceUrl: 'https://provider.invalid/paid/resource',
  description: 'gated resource',
  mimeType: 'application/json',
  amountMicroCcd: '250000',
};

const fetchServing = (bytes) => async () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const fetchFailing = async () => ({
  ok: false,
  status: 404,
  headers: { get: () => null },
  arrayBuffer: async () => new ArrayBuffer(0),
});

const structuralPayload = (requirements) => ({
  x402Version: X402_VERSION,
  accepted: requirements,
  payload: {
    signedTransaction: {
      version: 1,
      header: {
        sender: OWNER,
        nonce: 1,
        expiry: Math.floor(Date.now() / 1000) + 300,
        sponsor: { account: OWNER, numSignatures: 1 },
      },
      payload: { type: 'transfer' },
      signatures: { sender: {}, sponsor: {} },
    },
  },
});

function mockFacilitator(mode: 'ok' | 'reject' | 'settle-fail' | 'settle-nohash' | 'settle-throw' = 'ok') {
  const calls: string[] = [];
  const f: ConsumerFacilitator & { calls: string[] } = {
    calls,
    async verify() {
      calls.push('verify');
      if (mode === 'reject') return { isValid: false, invalidReason: 'sender_signature_invalid' };
      return { isValid: true, payer: OWNER };
    },
    async settle() {
      calls.push('settle');
      if (mode === 'settle-throw') throw new Error('facilitator down');
      if (mode === 'settle-fail') {
        return { success: false, transaction: '', network: CCD_TESTNET_CAIP2, errorReason: 'insufficient_funds' };
      }
      if (mode === 'settle-nohash') return { success: true, transaction: '', network: CCD_TESTNET_CAIP2 };
      return { success: true, transaction: TX, network: CCD_TESTNET_CAIP2, payer: OWNER };
    },
    async getSupported() {
      return { kinds: [{ x402Version: X402_VERSION, scheme: 'exact', network: CCD_TESTNET_CAIP2 }] };
    },
  };
  return f;
}

function baseDeps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    fetchImpl: fetchServing(CARD()),
    facilitator: mockFacilitator('ok'),
    createPaymentPayload: async req => structuralPayload(req) as never,
    discover: async () => SEARCH(),
    contractInfo: async () => ({
      cis8004_contract: { index: 12802, subindex: 0 },
      cis8_contract: { index: 12801, subindex: 0 },
    }),
    ...over,
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ─── trust policy ────────────────────────────────────────────────────────

const trustedResult = {
  agent_discovered: 'PASS',
  card_retrieved: 'PASS',
  card_valid: 'PASS',
  badge_valid: 'PASS',
  hash_matches_on_chain: 'PASS',
  owner_matches: 'PASS',
  status_active: 'PASS',
  contract_references_match: 'PASS',
  trust_decision: 'TRUSTED',
  evidence: {},
};

test('policy allows a fully trusted agent', () => {
  const d = evaluateTrustPolicy(trustedResult);
  ok(d.allowed, `should allow: ${d.reason}`);
  eq(d.code, 'ALLOWED', 'code');
});

test('policy rejects REJECTED by default', () => {
  const d = evaluateTrustPolicy({ ...trustedResult, trust_decision: 'REJECTED', hash_matches_on_chain: 'FAIL' });
  notOk(d.allowed, 'must reject');
  eq(d.code, 'TRUST_REJECTED', 'code');
  ok(d.reason.includes('hash_matches_on_chain'), 'reason names the failing check');
});

test('policy rejects INCONCLUSIVE by default', () => {
  const d = evaluateTrustPolicy({ ...trustedResult, trust_decision: 'INCONCLUSIVE', badge_valid: 'NOT_TESTED', agent_discovered: 'INCONCLUSIVE' });
  notOk(d.allowed, 'must reject');
  eq(d.code, 'TRUST_INCONCLUSIVE', 'code');
});

test('a TRUSTED verdict cannot rescue a failing required check', () => {
  const d = evaluateTrustPolicy({ ...trustedResult, hash_matches_on_chain: 'FAIL' });
  notOk(d.allowed, 'must not allow');
  eq(d.code, 'CHECK_NOT_PASS', 'code');
});

test('missing checks default to NOT_TESTED and block', () => {
  const partial = { ...trustedResult };
  delete partial.owner_matches;
  const d = evaluateTrustPolicy(partial);
  notOk(d.allowed, 'absent check blocks');
  ok(d.reason.includes('owner_matches=NOT_TESTED'), 'reason');
});

test('advisory badge: NOT_TESTED tolerated under STRICT, required under PARANOID', () => {
  const r = { ...trustedResult, badge_valid: 'NOT_TESTED' };
  ok(evaluateTrustPolicy(r, STRICT_POLICY).allowed, 'strict tolerates unconfirmed badge');
  notOk(evaluateTrustPolicy(r, PARANOID_POLICY).allowed, 'paranoid requires badge');
});

test('a FAILING badge blocks even when policy treats it as advisory', () => {
  const d = evaluateTrustPolicy({ ...trustedResult, badge_valid: 'FAIL' });
  notOk(d.allowed, 'invalid badge is never acceptable');
  ok(d.reason.includes('badge'), 'reason');
});

test('intent limits: amount cap, asset, network', () => {
  const capped = { ...STRICT_POLICY, maxAmountMicroCcd: '100000' };
  const base = { amountMicroCcd: '250000', asset: 'CCD', network: CCD_TESTNET_CAIP2 };
  notOk(evaluateTrustPolicy(trustedResult, capped, base).allowed, 'amount over cap');
  eq(evaluateTrustPolicy(trustedResult, capped, { ...base, amountMicroCcd: '50000' }).allowed, true, 'under cap ok');

  const assetLimited = { ...STRICT_POLICY, allowedAssets: ['USDR'] };
  notOk(evaluateTrustPolicy(trustedResult, assetLimited, base).allowed, 'CCD not in allowlist');

  const netLimited = { ...STRICT_POLICY, allowedNetworks: ['ccd:other'] };
  notOk(evaluateTrustPolicy(trustedResult, netLimited, base).allowed, 'network not allowed');
});

// ─── happy path ──────────────────────────────────────────────────────────

test('full pipeline grants access with a receipt and a complete audit trail', async () => {
  const fac = mockFacilitator('ok');
  const audit = new AuditTrail({ sessionId: 'cs_test_happy' });
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({ facilitator: fac, audit }));

  eq(result.stage, 'access_granted', 'stage');
  ok(result.granted, 'granted');
  eq(result.trust.trust_decision, 'TRUSTED', 'trust');
  eq(result.policy.code, 'ALLOWED', 'policy');
  eq(result.requirements.amount, '250000', 'amount');
  eq(result.requirements.asset, 'CCD', 'asset');
  eq(result.requirements.payTo, OWNER, 'payTo taken from the registry record');
  eq(result.receipt.transaction, TX, 'receipt tx');
  eq(result.receipt.audit.agentId, TOKEN_ID, 'agent id attached to the receipt as audit metadata');
  eq(fac.calls.join(','), 'verify,settle', 'gate order');

  const types = audit.all().map(e => e.type);
  eq(
    types.join(' → '),
    'agent.discovered → agent.card.retrieved → agent.trust.verified → payment.requirement.created → ' +
    'payment.payload.received → payment.verified → payment.settlement.simulated → commerce.access.granted',
    'event sequence',
  );
});

test('every audit event carries the required fields', async () => {
  const audit = new AuditTrail({ sessionId: 'cs_test_fields' });
  await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({ audit }));
  for (const e of audit.all()) {
    ok(e.seq > 0, 'seq');
    ok(/^[0-9a-f-]{36}$/.test(e.event_id), 'event_id is a uuid');
    ok(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(e.timestamp), 'UTC ISO-8601 timestamp');
    eq(e.session_id, 'cs_test_fields', 'session_id');
    ok(e.type.includes('.'), 'namespaced type');
    ok(e.outcome, 'outcome');
  }
});

// ─── trust gate blocks commerce ──────────────────────────────────────────

test('failed trust verification stops the flow before any payment object exists', async () => {
  const fac = mockFacilitator('ok');
  let payloadBuilt = false;
  const audit = new AuditTrail({ sessionId: 'cs_test_dentrust' });

  const tampered = new TextEncoder().encode(
    new TextDecoder().decode(CARD()).replace('AgentTrust Gateway', 'AgentTrust Gatewa7'),
  );

  const result = await runCommerce(
    client,
    { tokenId: TOKEN_ID },
    REQUEST,
    baseDeps({
      facilitator: fac,
      audit,
      fetchImpl: fetchServing(tampered),
      createPaymentPayload: async req => {
        payloadBuilt = true;
        return structuralPayload(req) as never;
      },
    }),
  );

  eq(result.stage, 'trust_rejected', 'stage');
  notOk(result.granted, 'denied');
  eq(result.requirements, null, 'no payment requirement created');
  eq(result.paymentRequired, null, 'no 402 body created');
  notOk(payloadBuilt, 'client never asked for a payload');
  eq(fac.calls.length, 0, 'facilitator never contacted');
  ok(audit.all().some(e => e.type === 'agent.trust.rejected'), 'rejection recorded');
  ok(audit.all().some(e => e.type === 'commerce.access.denied'), 'denial recorded');
});

test('unreachable provider card blocks commerce', async () => {
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({ fetchImpl: fetchFailing }));
  eq(result.stage, 'trust_rejected', 'stage');
  notOk(result.granted, 'denied');
  eq(result.requirements, null, 'no requirement');
});

test('agent not in the registry blocks commerce', async () => {
  const result = await runCommerce(
    client,
    { tokenId: 424242 },
    REQUEST,
    baseDeps({ discover: async () => SEARCH() }),
  );
  eq(result.stage, 'trust_rejected', 'stage');
  notOk(result.granted, 'denied');
  eq(result.receipt, null, 'no receipt');
});

test('discovery failure is reported and commerce never starts', async () => {
  const audit = new AuditTrail({ sessionId: 'cs_test_discoveryfail' });
  const result = await runCommerce(
    client,
    { tokenId: TOKEN_ID },
    REQUEST,
    baseDeps({
      audit,
      discover: async () => {
        throw new Error('registry unreachable');
      },
    }),
  );
  eq(result.stage, 'discovery_failed', 'stage');
  notOk(result.granted, 'denied');
  eq(result.trust, null, 'no trust evaluation');
  ok(audit.all().some(e => e.type === 'agent.discovered' && e.outcome === 'FAIL'), 'failure recorded');
});

test('owner pin mismatch blocks commerce even with a valid-looking record', async () => {
  const result = await runCommerce(
    client,
    { tokenId: TOKEN_ID, expectOwner: OTHER },
    REQUEST,
    baseDeps(),
  );
  eq(result.stage, 'trust_rejected', 'stage');
  notOk(result.granted, 'denied');
});

test('policy amount cap blocks commerce before payment', async () => {
  const fac = mockFacilitator('ok');
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
    facilitator: fac,
    policy: { ...STRICT_POLICY, maxAmountMicroCcd: '1000' },
  }));
  eq(result.stage, 'trust_rejected', 'stage');
  notOk(result.granted, 'denied');
  eq(result.policy.code, 'AMOUNT_EXCEEDED', 'policy code');
  eq(fac.calls.length, 0, 'facilitator never contacted');
});

// ─── payment gate blocks access ──────────────────────────────────────────

test('failed payment verification never reaches settlement', async () => {
  const fac = mockFacilitator('reject');
  const audit = new AuditTrail({ sessionId: 'cs_test_payreject' });
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({ facilitator: fac, audit }));

  eq(result.stage, 'payment_rejected', 'stage');
  notOk(result.granted, 'denied');
  notOk(fac.calls.includes('settle'), 'settle never called');
  eq(result.receipt, null, 'no receipt');
  ok(audit.all().some(e => e.type === 'payment.rejected'), 'rejection recorded');
  ok(audit.all().some(e => e.type === 'commerce.access.denied'), 'denial recorded');
});

test('settlement failure denies access', async () => {
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
    facilitator: mockFacilitator('settle-fail'),
  }));
  eq(result.stage, 'payment_rejected', 'stage');
  notOk(result.granted, 'denied');
  eq(result.receipt, null, 'no receipt');
});

test('settlement success without a transaction reference denies access', async () => {
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
    facilitator: mockFacilitator('settle-nohash'),
  }));
  eq(result.stage, 'payment_rejected', 'stage');
  notOk(result.granted, 'ungrantable without a tx hash');
  eq(result.receipt, null, 'no receipt');
});

test('settlement throwing denies access', async () => {
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
    facilitator: mockFacilitator('settle-throw'),
  }));
  notOk(result.granted, 'denied');
  eq(result.receipt, null, 'no receipt');
});

test('client unable to build a payload denies access without contacting the facilitator', async () => {
  const fac = mockFacilitator('ok');
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
    facilitator: fac,
    createPaymentPayload: async () => {
      throw new Error('no signer available');
    },
  }));
  eq(result.stage, 'requirement_created', 'stage');
  notOk(result.granted, 'denied');
  eq(fac.calls.length, 0, 'facilitator never contacted');
});

test('a payload tampered at the client is rejected before settlement', async () => {
  const fac = mockFacilitator('ok');
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
    facilitator: fac,
    createPaymentPayload: async req => {
      const p = structuralPayload({ ...req, amount: '1' }); // underpays
      return p as never;
    },
  }));
  notOk(result.granted, 'denied');
  eq(result.stage, 'payment_rejected', 'stage');
  notOk(fac.calls.includes('settle'), 'settle never called');
});

// ─── audit trail ─────────────────────────────────────────────────────────

test('audit trail persists append-only JSONL that reads back and validates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-audit-'));
  const file = join(dir, 'trail.jsonl');
  try {
    const audit = new AuditTrail({ filePath: file, sessionId: 'cs_test_file' });
    await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({ audit }));
    const check = AuditTrail.verify(file);
    ok(check.ok, `audit invalid: ${check.problems?.join('; ')}`);
    ok(check.events.length >= 8, 'all events persisted');
    ok(check.events.every(e => e.session_id === 'cs_test_file'), 'session id consistent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit refuses to write key material', () => {
  const audit = new AuditTrail({ sessionId: 'cs_test_secrets' });
  throws(
    () => audit.record('payment.payload.received', { outcome: 'PASS', reason: 'x', payment: { payer: '0'.repeat(64) } }),
    'key material',
    'bare 32-byte hex must be refused',
  );
  throws(
    () => assertNoSecrets({ nested: { privateKey: 'abc' } }),
    'secret-bearing field',
    'forbidden field name',
  );
  throws(
    () => assertNoSecrets({ seedPhrase: 'a b c' }),
    'secret-bearing field',
    'mnemonic field',
  );
});

test('audit allows public hashes (transaction, card digest)', () => {
  const audit = new AuditTrail({ sessionId: 'cs_test_hashes' });
  audit.record('payment.settlement.simulated', {
    outcome: 'PASS',
    reason: 'mock',
    payment: { transaction: TX },
    agent: { token_id: 1004 },
  });
  assertNoSecrets({ agent: { metadata_sha256: 'f'.repeat(64) } }, 'agent');
  eq(audit.all().length, 1, 'public hashes are permitted');
});

test('audit chain detects a sequence gap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-gap-'));
  const file = join(dir, 'trail.jsonl');
  try {
    const audit = new AuditTrail({ filePath: file, sessionId: 'cs_gap' });
    audit.record('agent.discovered', { outcome: 'PASS' });
    // Simulate tampering: drop a line and re-append out of order.
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const forged = JSON.parse(lines[0]);
    forged.seq = 5;
    writeFileSync(file, lines[0] + '\n' + JSON.stringify(forged) + '\n');
    const check = AuditTrail.verify(file);
    notOk(check.ok, 'gap must be detected');
    ok(check.problems.some(p => p.includes('seq')), `problems: ${check.problems.join('; ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a denied session still produces a complete audit trail', async () => {
  const audit = new AuditTrail({ sessionId: 'cs_test_denied' });
  await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
    audit,
    facilitator: mockFacilitator('reject'),
  }));
  const types = audit.all().map(e => e.type);
  ok(types.includes('commerce.access.denied'), 'denial recorded');
  notOk(types.includes('commerce.access.granted'), 'grant recorded only on success');
  const last = audit.all()[audit.all().length - 1];
  eq(last.type, 'commerce.access.denied', 'denial is the terminal event');
});

// ─── session isolation ───────────────────────────────────────────────────

test('two commerce sessions never mix audit events', async () => {
  const a = new AuditTrail({ sessionId: 'cs_session_A' });
  const b = new AuditTrail({ sessionId: 'cs_session_B' });

  const [ra, rb] = await Promise.all([
    runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({ audit: a })),
    runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
      audit: b,
      facilitator: mockFacilitator('reject'),
    })),
  ]);

  ok(ra.granted, 'session A granted');
  notOk(rb.granted, 'session B denied');

  ok(a.all().every(e => e.session_id === 'cs_session_A'), 'A only carries A events');
  ok(b.all().every(e => e.session_id === 'cs_session_B'), 'B only carries B events');
  ok(a.all().some(e => e.type === 'commerce.access.granted'), 'A has a grant');
  notOk(b.all().some(e => e.type === 'commerce.access.granted'), 'B has no grant');
  ok(b.all().some(e => e.type === 'commerce.access.denied'), 'B has a denial');
  // sequence numbers restart per session, not shared
  eq(a.all()[0].seq, 1, 'A starts at 1');
  eq(b.all()[0].seq, 1, 'B starts at 1');
});

test('sessions written to one file stay distinguishable and order-preserving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenttrust-multi-'));
  const file = join(dir, 'trail.jsonl');
  try {
    const a = new AuditTrail({ filePath: file, sessionId: 'cs_file_A' });
    const b = new AuditTrail({ filePath: file, sessionId: 'cs_file_B' });
    await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({ audit: a }));
    await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
      audit: b,
      facilitator: mockFacilitator('reject'),
    }));

    const check = AuditTrail.verify(file);
    ok(check.ok, `trail invalid: ${check.problems?.join('; ')}`);
    const aEvents = check.events.filter(e => e.session_id === 'cs_file_A');
    const bEvents = check.events.filter(e => e.session_id === 'cs_file_B');
    ok(aEvents.length >= 8, 'A events present');
    ok(bEvents.length >= 6, 'B events present');
    // append-only ordering is a property of file position, not of seq (which
    // restarts per session). Every A line must precede every B line.
    const aPositions = check.events.map((e, i) => ({ s: e.session_id, i })).filter(x => x.s === 'cs_file_A').map(x => x.i);
    const bPositions = check.events.map((e, i) => ({ s: e.session_id, i })).filter(x => x.s === 'cs_file_B').map(x => x.i);
    ok(Math.max(...aPositions) < Math.min(...bPositions), 'session A lines all precede session B lines');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── sensitive data exclusion ────────────────────────────────────────────

test('no payload, signature or key material reaches the audit log', async () => {
  const audit = new AuditTrail({ sessionId: 'cs_test_nosensitive' });
  const fac = mockFacilitator('ok');

  await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
    audit,
    facilitator: fac,
    createPaymentPayload: async req => {
      const p = structuralPayload(req) as any;
      // A realistic payload carries signature bytes. Prove they are not persisted.
      p.payload.signedTransaction.signatures = {
        sender: { '0': { '0': 'DEADBEEF'.repeat(16) } },
        sponsor: {},
      };
      return p;
    },
  }));

  const jsonl = audit.toJsonl();
  for (const needle of ['DEADBEEF', 'signedTransaction', 'signatures', 'signature', 'nonce', 'expiry']) {
    notOk(jsonl.includes(needle), `audit log must not contain "${needle}"`);
  }
  // The whole payment payload must never be serialised into an event.
  // Hash chain adds 2 x 64 hex chars per line; the bound only rules out payload blobs.
  ok(jsonl.length < 8000, 'trail stays compact — no payload blobs');

  // What IS allowed: public references.
  ok(jsonl.includes('req_'), 'requirement id present');
  ok(/\+ transaction/.test(jsonl) || jsonl.includes('"transaction"'), 'transaction reference present');
});

test('the redaction guard blocks secrets nested anywhere in an event', () => {
  // The event schema has no free-form payload slot, but a future edit might add
  // one. Prove the guard catches a secret however deeply it is nested.
  throws(
    () => assertNoSecrets({ payment: { requirement_id: 'r', extra: { signedTransaction: { privateKey: 'x' } } } }),
    'secret-bearing field',
    'nested privateKey is refused',
  );
  throws(
    () => assertNoSecrets({ nested: [{ deeper: { seed: 'abc' } }] }),
    'secret-bearing field',
    'secret inside an array is refused',
  );
  // And a bare 32-byte hex in a non-hash field is refused.
  throws(
    () => assertNoSecrets({ payment: { payer: 'A'.repeat(64) } }),
    'key material',
    'bare hex outside a hash field is refused',
  );
});

test('orchestrator event schema cannot carry a payload blob', async () => {
  const audit = new AuditTrail({ sessionId: 'cs_test_schema' });
  await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({ audit }));
  for (const e of audit.all()) {
    const keys = Object.keys(e);
    for (const k of keys) {
      ok(['seq', 'event_id', 'timestamp', 'session_id', 'type', 'outcome', 'reason', 'agent',
          'payment', 'evidence_ref', 'prev_hash', 'hash'].includes(k),
        `unexpected event key "${k}"`);
    }
    for (const k of Object.keys(e.payment ?? {})) {
      ok(['requirement_id', 'amount', 'asset', 'network', 'pay_to', 'payer', 'transaction'].includes(k),
        `unexpected payment key "${k}"`);
    }
  }
});

// ─── malformed / unavailable dependencies ────────────────────────────────

test('malformed discovery payload fails safely', async () => {
  const audit = new AuditTrail({ sessionId: 'cs_test_malformed_disc' });
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
    audit,
    discover: async () => ({ not_agents: 'nope' }),
  }));
  eq(result.stage, 'trust_rejected', 'stage');
  notOk(result.granted, 'denied');
  eq(result.receipt, null, 'no receipt');
});

test('malformed contract_info does not crash and fails closed where it matters', async () => {
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
    contractInfo: async () => {
      throw new Error('contract_info unavailable');
    },
  }));
  // Falls back to configured coordinates; verification still decides the outcome.
  eq(result.stage, 'access_granted', 'falls back to configured coordinates');
  ok(result.granted, 'granted only because verification independently passed');
});

test('a throwing payment adapter fails safely', async () => {
  const fac = mockFacilitator('ok');
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({
    facilitator: fac,
    createPaymentPayload: () => { throw new Error('adapter exploded'); },
  }));
  notOk(result.granted, 'denied');
  eq(result.receipt, null, 'no receipt');
  eq(fac.calls.length, 0, 'facilitator untouched');
});

test('a facilitator that throws on verify fails safely', async () => {
  const fac: ConsumerFacilitator = {
    async verify() { throw new Error('network down'); },
    async settle() { throw new Error('must not be reached'); },
    async getSupported() { return { kinds: [] }; },
  };
  const result = await runCommerce(client, { tokenId: TOKEN_ID }, REQUEST, baseDeps({ facilitator: fac }));
  notOk(result.granted, 'denied');
  eq(result.stage, 'payment_rejected', 'stage');
  eq(result.receipt, null, 'no receipt');
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
console.log(`\ntask05-commerce: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
