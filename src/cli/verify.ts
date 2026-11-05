#!/usr/bin/env node
/**
 * agenttrust verify — read-only cross-agent verification.
 *
 * Discovers an agent through the live Agent Registry, fetches its Agent Card from
 * the registered URI, recomputes SHA-256 locally over the exact response bytes,
 * and cross-checks identity, ownership, status and contract references.
 *
 * Read-only: builds no transaction, signs nothing, submits nothing.
 * Nothing is hardcoded: token address, owner, contract coordinates and hashes come
 * from the live registry at run time.
 *
 *   agenttrust verify --token-id 1004
 *   agenttrust verify --token-id 1004 --expect-owner <base58>
 *   agenttrust verify --q AgentTrust          # discover by name instead of id
 *   agenttrust verify --json                  # machine-readable output only
 *
 * Exit codes: 0 TRUSTED · 1 REJECTED · 2 INCONCLUSIVE · 3 usage/transport error
 */

import {
  readToolSchema,
  assertToolAccepts,
  verifyAgent,
  type ContractExpectation,
  type RegistryRecord,
} from '../verify/crossAgent.js';

const DEFAULT_MCP = 'https://agent-registry-mcp.concordium.com';
const TOOL = 'search_agents';

interface Args {
  tokenId?: number;
  q?: string;
  expectOwner?: string;
  network: 'testnet' | 'mainnet' | 'devnet';
  mcp: string;
  json: boolean;
  quiet: boolean;
  /** Consult the hosted badge checker as corroboration. Advisory only. */
  badgeCheck: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { network: 'testnet', mcp: DEFAULT_MCP, json: false, quiet: false, badgeCheck: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i]!;
    switch (arg) {
      case '--token-id': a.tokenId = Number(next()); break;
      case '--q': a.q = next(); break;
      case '--expect-owner': a.expectOwner = next(); break;
      case '--network': a.network = next() as Args['network']; break;
      case '--mcp': a.mcp = next()!.replace(/\/mcp$/, ''); break;
      case '--json': a.json = true; break;
      case '--quiet': a.quiet = true; break;
      case '--badge-check': a.badgeCheck = true; break;
      case '--no-badge-check': a.badgeCheck = false; break;
      case '-h': case '--help': usage(); process.exit(0);
      default:
        if (arg.startsWith('-')) { console.error(`unknown flag: ${arg}`); usage(); process.exit(3); }
    }
  }
  if (a.tokenId === undefined && a.q === undefined) {
    console.error('one of --token-id or --q is required');
    usage();
    process.exit(3);
  }
  if (a.tokenId !== undefined && !Number.isInteger(a.tokenId)) {
    console.error(`--token-id must be an integer, got ${a.tokenId}`);
    process.exit(3);
  }
  return a;
}

function usage(): void {
  console.error(`
agenttrust verify — read-only cross-agent verification

  --token-id <n>        CIS-8004 token id to verify
  --q <text>            discover by registry search term (alternative to --token-id)
  --expect-owner <addr> optional: require this base58 owner on the registry record
  --network <net>       testnet | mainnet | devnet  (default: testnet)
  --mcp <url>           registry MCP base URL
  --json                print only the trust result JSON
  --quiet               suppress progress output
  --no-badge-check      skip the hosted badge checker (local evidence only)
                        the checker is advisory: the verdict never depends on it

Exit: 0 TRUSTED · 1 REJECTED · 2 INCONCLUSIVE · 3 usage/transport error`);
}

async function rpc(base: string, method: string, params: unknown): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() & 0x7fffffff, method, params }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status} (${method})`);
  return res.json();
}

async function callTool(base: string, name: string, args: Record<string, unknown>): Promise<any> {
  const body = await rpc(base, 'tools/call', { name, arguments: args });
  if (body?.error) throw new Error(`${name}: ${body.error.message}`);
  const text = body?.result?.content?.[0]?.text;
  if (body?.result?.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name}: non-JSON response`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const log = (m: string) => { if (!args.quiet && !args.json) console.error(m); };

  // ── 1. Schema inspection: never assume the registry contract ────────────
  log('[1/5] reading live registry schema');
  const toolsList = await rpc(args.mcp, 'tools/list', {});
  const schema = readToolSchema(toolsList, TOOL);
  assertToolAccepts(schema, 'q');
  log(`      ${TOOL} requires: ${schema.required.join(', ')}`);

  // ── 2. Live discovery ──────────────────────────────────────────────────
  const query = args.q ?? String(args.tokenId);
  log(`[2/5] discovering via ${TOOL} q="${query}"`);
  const discovery = await callTool(args.mcp, TOOL, { network: args.network, q: query, limit: 50 });

  let record: RegistryRecord | undefined = (discovery.agents ?? []).find(
    (a: RegistryRecord) => args.tokenId === undefined || Number(a.token_id) === args.tokenId,
  );
  // --q without --token-id: take the sole match, or refuse to guess
  if (!record && args.tokenId === undefined) {
    const hits = discovery.agents ?? [];
    if (hits.length === 1) record = hits[0];
    else {
      console.error(`ambiguous: ${hits.length} agents matched "${query}" — pass --token-id`);
      return 3;
    }
  }
  if (record && args.tokenId === undefined) args.tokenId = Number(record.token_id);
  log(`      token_id=${recordsOr(record)}`);

  // ── 3. Contract coordinates, from the registry itself ──────────────────
  const tokenId = record ? Number(record.token_id) : args.tokenId!;
  log('[3/5] reading contract coordinates');
  const info = await callTool(args.mcp, 'contract_info', { network: args.network });
  const expect: ContractExpectation = {
    network: networkCaip(args.network, info),
    cis8004: `${info.cis8004_contract.index}.${info.cis8004_contract.subindex}`,
    cis8: `${info.cis8_contract.index}.${info.cis8_contract.subindex}`,
    tokenId,
    ownerAccount: args.expectOwner,
  };
  log(`      cis8004=${expect.network}:${expect.cis8004}  cis8=${expect.network}:${expect.cis8}`);

  // ── 4. Card fetch + local hash + identity checks ───────────────────────
  // The hosted checker is consulted for corroboration only; it can neither
  // manufacture nor veto a locally-derived verdict.
  let badge = { consulted: false, raw: null as any, error: null as string | null };
  if (args.badgeCheck && record) {
    log('[4/5] consulting hosted badge checker (advisory)');
    try {
      const addr = await tokenAddressOf(args.mcp, args.network, tokenId);
      const res = await fetch(`${args.mcp}/v1/check-badge/${addr}`);
      badge = { consulted: true, raw: JSON.parse(await res.text()), error: null };
    } catch (e) {
      badge = { consulted: true, raw: null, error: (e as Error).message };
    }
  }
  log('[4/5] fetching card and verifying locally');
  const result = await verifyAgent({
    expect,
    discoveryPayload: discovery,
    badge,
    fetchImpl: (u: string) =>
      fetch(u).then(r => ({
        ok: r.ok,
        status: r.status,
        headers: { get: (n: string) => r.headers.get(n) },
        arrayBuffer: () => r.arrayBuffer(),
      })),
  });

  // ── 5. Report ──────────────────────────────────────────────────────────
  log('[5/5] done');
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const pad = (s: string) => s.padEnd(26);
    console.log('');
    for (const k of [
      'agent_discovered', 'card_retrieved', 'card_valid', 'badge_valid',
      'hash_matches_on_chain', 'owner_matches', 'status_active', 'contract_references_match',
    ] as const) {
      console.log(pad(k.replace(/_/g, ' ')), result[k]);
    }
    console.log('─'.repeat(56));
    console.log(pad('TRUST DECISION'), result.trust_decision);
    const card = result.evidence.card as any;
    const hash = result.evidence.hash as any;
    if (card) console.log(pad('card'), `${card.http_status} · ${card.byte_length} bytes · ${card.url}`);
    if (hash) console.log(pad('sha256 (local)'), hash.local_sha256);
    if (hash) console.log(pad('sha256 (on-chain)'), hash.on_chain_sha256);
    console.log(pad('transactions'), '0 (read-only)');
  }

  return result.trust_decision === 'TRUSTED' ? 0 : result.trust_decision === 'REJECTED' ? 1 : 2;
}

const recordsOr = (r?: RegistryRecord) => (r ? r.token_id : 'not found');

/** Resolve the Base58 token address the registry REST badge endpoint expects. */
async function tokenAddressOf(base: string, network: string, tokenId: number): Promise<string> {
  const r = await callTool(base, 'agent_of', { network, token_id: tokenId });
  const addr = r?.token_address;
  if (!addr) throw new Error('registry did not return a token_address for this token id');
  return addr;
}

/**
 * The registry reports contract coordinates but not the CAIP-2 chain id.
 * Derive it from a live on-chain value (the record's token address is unavailable
 * here), falling back to the documented per-network CAIP-2 ids.
 */
function networkCaip(net: string, info: any): string {
  if (typeof info?.caip2 === 'string') return info.caip2;
  const documented: Record<string, string> = {
    testnet: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
    mainnet: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb',
    devnet: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  };
  return documented[net] ?? documented.testnet!;
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(`ERROR: ${e.message}`);
    process.exit(3);
  });
