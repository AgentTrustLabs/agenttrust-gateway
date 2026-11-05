// Core types, network config, helpers. No private keys, no secrets.

export const TESTNET = {
  caip2: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  cis8004: { index: 12802n, subindex: 0n },
  cis8: { index: 12801n, subindex: 0n },
  mcpUrl: 'https://agent-registry-mcp.concordium.com/mcp',
  mcpHealth: 'https://agent-registry-mcp.concordium.com/healthz',
  indexerUrl: 'https://agent-registry-indexer.concordium.com',
  grpcHost: 'https://grpc.testnet.concordium.com',
  grpcPort: 20000,
  useTls: true,
  explorerBase: 'https://testnet.ccdscan.io',
  explorerTx: (hash: string) =>
    `https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=${hash}`,
  explorerAccount: (addr: string) =>
    `https://testnet.ccdscan.io/?dcount=0&dentity=id&daddr=${addr}`,
} as const;

export const MAINNET = {
  caip2: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb',
  cis8004: { index: 10082n, subindex: 0n },
  cis8: { index: 10081n, subindex: 0n },
  mcpUrl: 'https://agent-registry-mcp.concordium.com/mcp',
  mcpHealth: 'https://agent-registry-mcp.concordium.com/healthz',
  indexerUrl: 'https://agent-registry-indexer.concordium.com',
  grpcHost: 'https://grpc.mainnet.concordium.software',
  grpcPort: 20000,
  useTls: true,
  explorerBase: 'https://ccdscan.io',
  explorerTx: (hash: string) =>
    `https://ccdscan.io/?dcount=1&dentity=transaction&dhash=${hash}`,
  explorerAccount: (addr: string) =>
    `https://ccdscan.io/?dcount=0&dentity=id&daddr=${addr}`,
} as const;

export type Network = typeof TESTNET | typeof MAINNET;
export type NetworkName = 'testnet' | 'mainnet';

export const networkOf = (name: NetworkName): Network =>
  name === 'testnet' ? TESTNET : MAINNET;

export interface AgentRecord {
  tokenId: number;
  tokenAddress: string;
  ownerAccount: string;
  agentUri: string | null;
  metadataHash: string | null;
  agentWallet: string | null;
  status: 'Active' | 'Revoked' | 'Unknown';
  registeredAt: string;
  lastEventBlock: number;
}

/** SHA-256 of raw bytes, returned as hex string without 0x prefix. */
export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Hex string (with or without 0x) to Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  const s = hex.replace(/^0x/, '');
  if (s.length % 2 !== 0) throw new Error('Odd-length hex');
  return Uint8Array.from(s.match(/.{2}/g)!.map(b => parseInt(b, 16)));
}

/** Uint8Array to hex string without 0x prefix. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Concordium account address regex (Base58Check, 50-55 chars). */
export const ACCOUNT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{50,55}$/;
export const TOKEN_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{10,100}$/;
export const URI_REGEX = /^https?:\/\/.+/;

export function isValidAccount(addr: string): boolean {
  return ACCOUNT_REGEX.test(addr);
}

export function isValidUri(uri: string): boolean {
  return URI_REGEX.test(uri);
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertNetwork(
  n: Network,
  name: NetworkName,
): asserts n is Network {
  if (!n) throw new Error('Unknown network');
}
