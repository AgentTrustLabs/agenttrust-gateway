#!/usr/bin/env node
/**
 * agenttrust commerce — one-command trust-gated commerce demo.
 *
 * Discovers a provider through the live Agent Registry, verifies it independently,
 * applies a trust policy, then runs the x402 payment flow through a MOCK
 * facilitator and writes an append-only audit trail.
 *
 * SIMULATED: settlement is mocked. No transaction is signed, submitted or on-chain.
 *
 *   agenttrust commerce --token-id 1004 --out docs/evidence/task05
 *   agenttrust commerce --token-id 1004 --facilitator reject --out /tmp/x
 *   agenttrust commerce --token-id 1004 --expect-owner <other> --out /tmp/x
 *
 * Exit codes: 0 access granted · 1 trust rejected · 2 payment rejected · 3 usage/transport
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommerce, type CommerceClient, type OrchestratorDeps } from '../commerce/orchestrator.js';
import { AuditTrail } from '../audit/trail.js';
import { CCD_TESTNET_CAIP2 } from '../payments/x402.js';
import {
  mockFacilitator,
  structuralPayload,
  type FacilitatorMode,
} from '../commerce/simulation.js';

const MCP_DEFAULT = 'https://agent-registry-mcp.concordium.com';


interface Args {
  tokenId: number;
  out: string;
  amount: string;
  expectOwner?: string;
  network: 'testnet' | 'mainnet' | 'devnet';
  resourceUrl: string;
  facilitator: FacilitatorMode;
  json: boolean;
  mcp: string;
}

function usage(): void {
  console.error(`
agenttrust commerce — trust-gated x402 commerce demo (MOCK settlement)

  --token-id <n>        provider CIS-8004 token id (required)
  --out <dir>           directory for audit-trail.jsonl + commerce-result.json
  --amount <ccd>        price in CCD (default 0.25)
  --expect-owner <b58>  pin the provider owner; a mismatch fails verification
  --network <net>       testnet | mainnet | devnet   (default testnet)
  --resource-url <url>  protected resource URL
  --facilitator <mode>  ok | reject | settle-fail | settle-nohash   (default ok)
  --mcp <url>           registry MCP base URL
  --json                print only the structured result

SETTLEMENT IS SIMULATED. No transaction is signed, submitted, or on-chain.

Exit: 0 access granted · 1 trust rejected · 2 payment rejected · 3 usage/transport`);
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    tokenId: -1,
    out: 'docs/evidence/task05',
    amount: '0.25',
    network: 'testnet',
    resourceUrl: 'https://api.sabokun.my.id/agenttrust/paid/resource',
    facilitator: 'ok',
    json: false,
    mcp: MCP_DEFAULT,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i]!;
    switch (arg) {
      case '--token-id': a.tokenId = Number(next()); break;
      case '--out': a.out = next(); break;
      case '--amount': a.amount = next(); break;
      case '--expect-owner': a.expectOwner = next(); break;
      case '--network': a.network = next() as Args['network']; break;
      case '--resource-url': a.resourceUrl = next(); break;
      case '--facilitator': a.facilitator = next() as FacilitatorMode; break;
      case '--mcp': a.mcp = next().replace(/\/mcp$/, ''); break;
      case '--json': a.json = true; break;
      case '-h': case '--help': usage(); process.exit(0);
      default:
        if (arg.startsWith('-')) { console.error(`unknown flag: ${arg}`); usage(); process.exit(3); }
    }
  }
  if (!Number.isInteger(a.tokenId) || a.tokenId < 0) {
    console.error('--token-id <n> is required');
    usage();
    process.exit(3);
  }
  if (!['ok', 'reject', 'settle-fail', 'settle-nohash'].includes(a.facilitator)) {
    console.error(`unknown --facilitator mode: ${a.facilitator}`);
    process.exit(3);
  }
  return a;
}

// ─── registry reads (live, read-only) ────────────────────────────────────
async function rpc(base: string, method: string, params: unknown): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() & 0x7fffffff, method, params }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status} (${method})`);
  return res.json();
}

async function tool(base: string, name: string, args: Record<string, unknown>): Promise<any> {
  const body = await rpc(base, 'tools/call', { name, arguments: args });
  if (body?.error) throw new Error(body.error.message);
  const text = body?.result?.content?.[0]?.text;
  if (body?.result?.isError) throw new Error(String(text));
  return JSON.parse(text);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const log = (m: string) => { if (!args.json) console.error(m); };

  mkdirSync(args.out, { recursive: true });
  const auditPath = join(args.out, 'audit-trail.jsonl');

  const client: CommerceClient = {
    mcpBase: args.mcp,
    network: args.network,
    caip2: args.network === 'mainnet'
      ? 'ccd:9dd9ca4d19e9393877d2c44b70f89acb'
      : CCD_TESTNET_CAIP2,
    cis8004: '12802.0',
    cis8: '12801.0',
  };

  const facilitator = mockFacilitator(args.facilitator);
  const audit = new AuditTrail({
    filePath: auditPath,
    sessionId: `cs_${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${Math.random().toString(36).slice(2, 8)}`,
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
    createPaymentPayload: async req => structuralPayload(req),
    discover: async (c, target) => {
      const record = await tool(c.mcpBase, 'agent_of', { network: c.network, token_id: target.tokenId });
      return { agents: [record] };
    },
    contractInfo: async c => tool(c.mcpBase, 'contract_info', { network: c.network }),
    audit,
  };

  log(`[1/4] discovering token ${args.tokenId} on ${args.network}`);
  log(`[2/4] verifying identity independently (live registry + card bytes)`);
  log(`[3/4] trust policy + x402 exact payment (facilitator mode: ${args.facilitator})`);
  log(`[4/4] MOCK settlement — no transaction is signed or submitted`);

  const result = await runCommerce(
    client,
    { tokenId: args.tokenId, ...(args.expectOwner ? { expectOwner: args.expectOwner } : {}) },
    {
      resourceUrl: args.resourceUrl,
      description: 'AgentTrust gated resource (mock settlement)',
      mimeType: 'application/json',
      // The orchestrator converts CCD decimals to atomic units when needed.
      amountMicroCcd: args.amount,
    },
    deps,
  );

  writeFileSync(join(args.out, 'commerce-result.json'), JSON.stringify(result, null, 2));

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const pad = (s: string) => s.padEnd(26);
    console.log('');
    console.log(pad('session'), result.sessionId);
    console.log(pad('stage'), result.stage);
    console.log(pad('agent trust'), result.trust?.trust_decision ?? '—');
    console.log(pad('trust policy'), result.policy?.code ?? '—');
    console.log(pad('payment requirement'),
      result.requirements ? `${result.requirements.amount} microCCD ${result.requirements.asset}` : '—');
    console.log(pad('facilitator (MOCK)'), facilitator.calls.join(', ') || 'not called');
    if (result.receipt) {
      console.log(pad('settlement'), 'SIMULATED — not on chain');
      console.log(pad('simulated txn'), result.receipt.transaction);
    } else {
      console.log(pad('settlement'), 'none');
    }
    console.log(pad('access granted'), String(result.granted));
    console.log(pad('reason'), result.reason);
    console.log('─'.repeat(60));
    console.log(pad('audit trail'), auditPath);
    console.log(pad('audit events'), String(result.audit.events));
    console.log('');
    console.log('NO REAL PAYMENT · NO ON-CHAIN TRANSACTION · NO KEY USED');
  }

  if (result.stage === 'access_granted') return 0;
  if (result.stage === 'trust_rejected') return 1;
  if (result.stage === 'payment_rejected') return 2;
  return 3;
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(`ERROR: ${e.message}`);
    process.exit(3);
  });
