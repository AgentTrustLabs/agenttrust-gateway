/**
 * TASK 05 demo — full trust-gated commerce run against the LIVE registry, with a
 * MOCK facilitator. No settlement, no transaction, no key.
 *
 * Writes:
 *   docs/evidence/task05/audit-trail.jsonl   append-only trail for the session
 *   docs/evidence/task05/commerce-result.json structured outcome
 *
 * Run: npx tsx scripts/task05-demo.mts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { runCommerce, type CommerceClient, type OrchestratorDeps } from '../src/commerce/orchestrator.js';
import { AuditTrail } from '../src/audit/trail.js';
import { CCD_TESTNET_CAIP2, CCD_ASSET, X402_VERSION, type ConsumerFacilitator } from '../src/payments/x402.js';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

const OUT = 'docs/evidence/task05';
const MCP = 'https://agent-registry-mcp.concordium.com';
const NETWORK = 'testnet';
const TOKEN_ID = 1004;

mkdirSync(OUT, { recursive: true });

// ─── registry reads (live, read-only) ─────────────────────────────────────
async function rpc(method: string, params: unknown) {
  const res = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() & 0x7fffffff, method, params }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status} (${method})`);
  return res.json();
}

async function tool(name: string, args: Record<string, unknown>) {
  const body = (await rpc('tools/call', { name, arguments: { network: NETWORK, ...args } })) as any;
  if (body?.error) throw new Error(body.error.message);
  const text = body?.result?.content?.[0]?.text;
  if (body?.result?.isError) throw new Error(String(text));
  return JSON.parse(text);
}

const client: CommerceClient = {
  mcpBase: MCP,
  network: NETWORK,
  caip2: CCD_TESTNET_CAIP2,
  cis8004: '12802.0',
  cis8: '12801.0',
};

// ─── MOCK facilitator ────────────────────────────────────────────────────
// Deterministic, offline, and obviously fake: the "transaction" is derived from
// the payee + amount so it is stable and attributable, and is NOT a real hash.
const fakeTx = (req: PaymentRequirements) => {
  const seed = `${req.payTo}:${req.amount}:${req.asset}`;
  let h = 0n;
  for (const ch of seed) h = (h * 131n + BigInt(ch.codePointAt(0)!)) % (1n << 256n);
  return h.toString(16).padStart(64, '0');
};

const calls: string[] = [];
const facilitator: ConsumerFacilitator = {
  async verify(payload: PaymentPayload, requirements: PaymentRequirements) {
    calls.push('verify');
    const signed = (payload.payload as any)?.signedTransaction;
    if (!signed || signed.version !== 1) {
      return { isValid: false, invalidReason: 'invalid_transaction_format' };
    }
    return { isValid: true, payer: signed?.header?.sender ?? requirements.payTo };
  },
  async settle(_payload: PaymentPayload, requirements: PaymentRequirements) {
    calls.push('settle');
    return {
      success: true,
      transaction: fakeTx(requirements),
      network: requirements.network,
      payer: requirements.payTo,
    };
  },
  async getSupported() {
    return { kinds: [{ x402Version: X402_VERSION, scheme: 'exact', network: CCD_TESTNET_CAIP2 }] };
  },
};

// ─── client payment adapter (structural payload, no key) ─────────────────
async function createPaymentPayload(requirements: PaymentRequirements): Promise<PaymentPayload> {
  const now = Math.floor(Date.now() / 1000);
  return {
    x402Version: X402_VERSION,
    accepted: requirements,
    payload: {
      signedTransaction: {
        version: 1,
        header: {
          sender: requirements.payTo,
          nonce: 1,
          expiry: now + 300,
          executionEnergyAmount: 300,
          numSignatures: 1,
          sponsor: { account: requirements.payTo, numSignatures: 1 },
        },
        payload: { type: 'transfer', toAddress: requirements.payTo, amount: requirements.amount },
        signatures: { sender: { '0': { '0': '00' } }, sponsor: {} },
      },
    },
  } as PaymentPayload;
}

const audit = new AuditTrail({
  filePath: `${OUT}/audit-trail.jsonl`,
  sessionId: `cs_task05_demo_${Date.now()}`,
});

const deps: OrchestratorDeps = {
  fetchImpl: (u: string) =>
    fetch(u).then(r => ({
      ok: r.ok,
      status: r.status,
      headers: { get: (n: string) => r.headers.get(n) },
      arrayBuffer: () => r.arrayBuffer(),
    })),
  facilitator,
  createPaymentPayload,
  discover: async (c, target) =>
    tool('agent_of', { network: c.network, token_id: target.tokenId }).then(record => ({
      agents: [record],
    })),
  contractInfo: async c => tool('contract_info', { network: c.network }),
  audit,
};

const result = await runCommerce(
  client,
  { tokenId: TOKEN_ID },
  {
    resourceUrl: 'https://api.sabokun.my.id/agenttrust/paid/resource',
    description: 'AgentTrust gated resource (demo)',
    mimeType: 'application/json',
    amountMicroCcd: '250000', // 0.25 CCD
  },
  deps,
);

writeFileSync(`${OUT}/commerce-result.json`, JSON.stringify(result, null, 2));

// ─── report ──────────────────────────────────────────────────────────────
const pad = (s: string) => s.padEnd(28);
console.log('\n' + '─'.repeat(60));
console.log(pad('session'), result.sessionId);
console.log(pad('stage'), result.stage);
console.log(pad('trust'), result.trust?.trust_decision ?? '—');
console.log(pad('policy'), result.policy?.code ?? '—');
console.log(pad('payment requirement'), result.requirements ? `${result.requirements.amount} ${result.requirements.asset}` : '—');
console.log(pad('facilitator calls'), calls.join(', ') || 'none');
console.log(pad('settlement tx'), result.receipt?.transaction ?? '—');
console.log(pad('access granted'), String(result.granted));
console.log('─'.repeat(60));

const verify = AuditTrail.verify(`${OUT}/audit-trail.jsonl`);
console.log(pad('audit events'), String(result.audit.events));
console.log(pad('audit chain valid'), String(verify.ok));
if (!verify.ok) console.log('  problems:', verify.problems);
console.log(pad('event types'), [...new Set(verify.events.map(e => e.type))].join(' → '));
console.log('\nNO REAL SETTLEMENT · NO TRANSACTION · NO KEY');
process.exit(result.granted ? 0 : 1);
