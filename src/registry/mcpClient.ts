// MCP client for the hosted Concordium Agent Registry service.
// Stateless, no credentials. Every write tool returns sign-ready parameter bytes.

import { TESTNET, type Network } from '../core/types.js';

export interface McpToolError {
  code: number;
  message: string;
}

export interface RegisterPayload {
  network: string;
  contract_address: { index: number; subindex: number };
  receive_name: string;
  parameter_json: unknown;
  parameter_hex: string;
  suggested_energy: number;
  sender: string;
}

export interface BuiltCard {
  network: string;
  agent_card_json: string;
  metadata_hash_hex: string;
  token_address: string | null;
  agent_uri: string;
  owner_account: string;
  notes: string[];
}

export interface RegisterArgs {
  sender: string;
  agentUri: string;
  metadataHashHex: string;
  externalReference?: unknown;
  initialMetadata?: [string, string][];
}

export class AgentRegistryMcp {
  constructor(
    private readonly endpoint: string,
    private readonly networkName: 'testnet' | 'mainnet',
  ) {}

  /** Calls a tool and unwraps the JSON text content. Throws on tool-level errors. */
  private async callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now() & 0x7fffffff,
        method: 'tools/call',
        params: { name, arguments: { network: this.networkName, ...args } },
      }),
    });

    if (!res.ok) throw new Error(`MCP HTTP ${res.status} for ${name}`);

    const body = (await res.json()) as {
      result?: { content: { type: string; text: string }[]; isError?: boolean };
      error?: { message: string };
    };

    if (body.error) throw new Error(`MCP ${name}: ${body.error.message}`);

    const content = body.result?.content?.[0]?.text;
    if (content === undefined) throw new Error(`MCP ${name}: empty response`);

    if (body.result?.isError) throw new Error(`MCP ${name}: ${content}`);

    // Tools return JSON text; surface the raw string on parse failure.
    try {
      return JSON.parse(content) as T;
    } catch {
      throw new Error(`MCP ${name}: non-JSON response: ${content.slice(0, 200)}`);
    }
  }

  health(): Promise<{ ok: boolean; version: string }> {
    return fetch(this.endpoint.replace(/\/mcp$/, '/healthz')).then(r => r.json() as Promise<{ ok: boolean; version: string }>);
  }

  tools(): Promise<{ tools: { name: string; description: string }[] }> {
    return fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }).then(r => r.json() as Promise<{ tools: { name: string; description: string }[] }>);
  }

  contractInfo(): Promise<{
    network: string;
    cis8004_contract: { index: number; subindex: number };
    cis8_contract: { index: number; subindex: number };
    cis8004_module_ref: string;
    explorer_base: string;
  }> {
    return this.callTool('contract_info');
  }

  /**
   * Builds a complete A2A v1.0 + ERC-8004 agent card plus its SHA-256.
   *
   * `tokenId` must be forwarded explicitly: when supplied for an already-minted
   * token the tool populates `params.tokenAddress` (CAIP-19) and the ERC-8004
   * `registrations` entry. Omitting it yields a pre-mint card with
   * `tokenAddress: null`, which fails badge validation.
   */
  buildAgentCard(args: {
    name: string;
    description: string;
    agentUri: string;
    ownerAccount: string;
    skills: { id: string; name: string; description: string }[];
    tokenId?: number;
    agentWallet?: string;
  }): Promise<BuiltCard> {
    return this.callTool('build_agent_card', {
      name: args.name,
      description: args.description,
      agent_uri: args.agentUri,
      owner_account: args.ownerAccount,
      skills: args.skills,
      ...(args.tokenId !== undefined ? { token_id: args.tokenId } : {}),
      ...(args.agentWallet ? { agent_wallet: args.agentWallet } : {}),
    });
  }

  /** Escape hatch for tools without a typed wrapper (task-scoped). */
  callToolRaw<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.callTool<T>(name, args);
  }

  /** CIS-8004 register parameter, ready for a contract-update transaction. */
  buildRegister(args: RegisterArgs): Promise<RegisterPayload> {
    return this.callTool('build_register', {
      sender: args.sender,
      agent_uri: args.agentUri,
      metadata_hash_hex: args.metadataHashHex,
      external_reference: args.externalReference ?? null,
      initial_metadata: args.initialMetadata ?? [],
    });
  }

  /** CIS-8004 setAgentURI/setMetadata-hash parameter for re-pinning a card. */
  buildSetAgentUri(args: {
    tokenId: number;
    agentUri: string;
    metadataHashHex: string;
    sender: string;
  }): Promise<RegisterPayload> {
    return this.callTool('build_set_agent_uri', {
      token_id: args.tokenId,
      agent_uri: args.agentUri,
      metadata_hash_hex: args.metadataHashHex,
      sender: args.sender,
    });
  }

  /**
   * Full verify cycle: fetch card, compare SHA-256 with on-chain hash.
   * Transport note: the MCP tool wants snake_case `token_id`, NOT `tokenId`
   * (camelCase silently falls through as "missing token_id"). The REST twin
   * /v1/verify-agent-card/{badge} takes the Base58 token address instead.
   */
  verifyAgentCard(args: { tokenId: number } | { tokenAddress: string }): Promise<Record<string, unknown>> {
    const params =
      'tokenAddress' in args
        ? { token_address: args.tokenAddress }
        : { token_id: args.tokenId };
    return this.callTool('verify_agent_card', params);
  }

  /** Resolve one agent by its Base58Check CIS-2 token address. */
  agentByTokenAddress(tokenAddress: string): Promise<Record<string, unknown>> {
    return this.callTool('agent_by_token_address', { token_address: tokenAddress });
  }

  /** Resolve one agent by CIS-8004 token id. */
  agentOf(account: string): Promise<Record<string, unknown>> {
    return this.callTool('agent_of', { account });
  }

  checkBadge(id: string): Promise<Record<string, unknown>> {
    return this.callTool('check_badge', { badge: id });
  }

  tokenAddress(tokenId: number): Promise<{ token_address: string }> {
    return this.callTool('token_address', {
      contract_index: Number(TESTNET.cis8004.index),
      subindex: 0,
      token_id: tokenId,
    });
  }
}

export const mcpFor = (net: Network, name: 'testnet' | 'mainnet' = 'testnet') =>
  new AgentRegistryMcp(net.mcpUrl, name);
