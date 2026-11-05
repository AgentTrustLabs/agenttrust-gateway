/**
 * Concordium transaction builder.
 *
 * Takes a pre-built parameter hex from the MCP (no re-serialization needed — the MCP
 * already encoded exactly the bytes the contract expects) and wraps it in a full
 * account-update transaction ready for wallet signing.
 *
 * Key insight from live testing (web-sdk 12.0.2):
 * - Transaction.updateContract({ amount, address, receiveName, message }, maxEnergy)
 *   is the working overload — pass the full payload object, not just the contract address.
 * - tx.toJSON() serializes header.payload but uses bigint fields (safe: convert with
 *   replacer before JSON.stringify).
 * - The signer is injected at sign-time by the Concordium Browser Wallet or a local key;
 *   this module NEVER holds a private key.
 */

import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  Energy,
  Parameter,
  ReceiveName,
  SequenceNumber,
  Transaction,
  TransactionExpiry,
} from '@concordium/web-sdk';

import type { RegisterPayload } from '../registry/mcpClient.js';
import type { Network } from '../core/types.js';

export interface SignableTransaction {
  /** JSON-serializable transaction, ready for wallet signMessage. */
  transactionJson: string;
  /** Sender account address (base58). */
  sender: string;
  /** Transaction expiry as Unix seconds. */
  expiry: number;
  /** Network for explorerUrl. */
  network: Network;
}

export interface TransactionResult {
  txHash: string;
  network: Network;
  explorerUrl: string;
}

/** Builds a CIS-8004 contract-update transaction from MCP parameter bytes. */
export function buildRegisterTransaction(
  mcpPayload: RegisterPayload,
  network: Network,
  expirySecondsFromNow = 600,
): SignableTransaction {
  // Validate contract address
  const { index, subindex } = mcpPayload.contract_address;
  const expectedIndex = Number(network.cis8004.index);
  if (index !== expectedIndex) {
    throw new Error(
      `Contract index mismatch: expected ${expectedIndex}, got ${index} (network=${network === network ? 'testnet' : 'mainnet'})`,
    );
  }
  if (subindex !== 0) throw new Error(`Expected subindex 0, got ${subindex}`);

  // Validate receive name
  if (mcpPayload.receive_name !== 'CIS-8004.register') {
    throw new Error(`Unexpected receive name: ${mcpPayload.receive_name}`);
  }

  const paramBytes = Parameter.fromHexString(mcpPayload.parameter_hex);
  const address = ContractAddress.create(BigInt(index), BigInt(subindex));
  const receiveName = ReceiveName.fromStringUnchecked(mcpPayload.receive_name);
  const energy = Energy.create(BigInt(mcpPayload.suggested_energy));

  const tx = Transaction.updateContract(
    {
      amount: CcdAmount.zero(),
      address,
      receiveName,
      message: paramBytes,
    },
    energy,
  );

  const expiry = Math.floor(Date.now() / 1000) + expirySecondsFromNow;

  const txJson = tx.toJSON();
  const serialized = JSON.stringify(txJson, (_, v) => (typeof v === 'bigint' ? String(v) : v), 1);

  return {
    transactionJson: serialized,
    sender: mcpPayload.sender,
    expiry,
    network,
  };
}

/**
 * After finalization, poll the gRPC node until the transaction appears as finalized.
 * Returns the final block hash + transaction hash.
 */
export async function waitForFinalization(
  txHash: string,
  network: Network,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<{ blockHash: string; txHash: string; status: string }> {
  // web-sdk 12.x: getTransactionStatus() is gone. Use getBlockItemStatus().
  const { ConcordiumGRPCWebClient, TransactionHash } = await import('@concordium/web-sdk');
  const client = new ConcordiumGRPCWebClient(
    `https://${network.grpcHost.replace(/^https?:\/\//, '')}`,
    network.grpcPort,
    {},
  );
  const hash = TransactionHash.fromHexString(txHash);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await client.getBlockItemStatus(hash);
      if (status.status === 'finalized') {
        const blockHash = String(status.outcome.blockHash ?? '');
        return { blockHash, txHash, status: 'success' };
      }
      await sleep(1000);
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`Transaction ${txHash} did not finalize within ${timeoutMs}ms`);
}

/** Simple sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Verify transaction outcome was 'success'. */
export function assertSuccess(result: { status: string }): void {
  if (result.status !== 'success') {
    throw new Error(`Transaction failed with outcome: ${result.status}`);
  }
}
