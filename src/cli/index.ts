#!/usr/bin/env node
/**
 * CLI entry point for AgentTrust.
 * Orchestrates: card build → MCP payload → dry-run → sign → submit → verify.
 *
 * Wallet integration: Concordium Browser Wallet (browser) or manual export.
 * The key never enters this process — owner signs in their wallet, returns tx hash.
 */

import { mcpFor, type RegisterPayload, type BuiltCard } from '../registry/mcpClient.js';
import { buildRegisterTransaction, waitForFinalization } from '../registry/txBuilder.js';
import { sha256Hex, TESTNET, isValidAccount, isValidUri, assert } from '../core/types.js';
import { readFileSync } from 'fs';
import { redactJson } from '../core/redact.js';

interface CardSpec {
  name: string;
  description: string;
  agentUri: string;
  ownerAccount: string;
  skills: { id: string; name: string; description: string }[];
}

interface SignablePayload {
  transactionJson: string;
  sender: string;
  expiry: number;
  network: 'testnet';
}

/** Phase 1: Build agent card + compute SHA-256. */
async function phaseCard(spec: CardSpec) {
  const mcp = mcpFor(TESTNET);
  console.error('[1/6] Building Agent Card via MCP...');
  const card: BuiltCard = await mcp.buildAgentCard(spec);
  const cardJson = card.agent_card_json;
  console.error(`[1/6] Card built. URI=${card.agent_uri}`);
  console.error(`[1/6] SHA-256 = ${card.metadata_hash_hex}`);
  return { card, cardJson };
}

/** Phase 2: Build register payload from MCP. */
async function phaseBuildPayload(card: BuiltCard, ownerAccount: string) {
  const mcp = mcpFor(TESTNET);
  console.error('[2/6] Building CIS-8004 register payload...');
  const payload: RegisterPayload = await mcp.buildRegister({
    sender: ownerAccount,
    agentUri: card.agent_uri,
    metadataHashHex: card.metadata_hash_hex,
  });
  console.error(`[2/6] Contract=${payload.contract_address.index}.${payload.contract_address.subindex}, receive=${payload.receive_name}`);
  console.error(`[2/6] Suggested energy=${payload.suggested_energy}, sender=${payload.sender}`);
  return payload;
}

/** Phase 3: Dry-run on testnet via gRPC. */
async function phaseDryRun(payload: RegisterPayload) {
  console.error('[3/6] Dry-running register via gRPC invokeContract...');
  const { ConcordiumGRPCWebClient, AccountAddress, ContractAddress, ReceiveName, Parameter, Energy } = await import('@concordium/web-sdk');
  const client = new ConcordiumGRPCWebClient(TESTNET.grpcHost, TESTNET.grpcPort, { useTls: TESTNET.useTls });
  const param = Parameter.fromHexString(payload.parameter_hex);
  const result = await client.invokeContract({
    invoker: AccountAddress.fromBase58(payload.sender),
    contract: ContractAddress.create(BigInt(payload.contract_address.index), BigInt(payload.contract_address.subindex)),
    method: ReceiveName.fromStringUnchecked(payload.receive_name),
    parameter: param,
    energy: Energy.create(100000n),
  });
  console.error(`[3/6] invokeContract result: ${result.tag}, usedEnergy=${result.usedEnergy?.value}`);
  if (result.tag === 'success') {
    // ReturnValue carries the new token_id as a little-endian u64.
    const rv = (result as { returnValue?: { buffer?: Uint8Array } }).returnValue;
    if (rv?.buffer) {
      const hex = Buffer.from(rv.buffer).toString('hex');
      console.error(`[3/6] returnValue=${hex} -> token_id ${Buffer.from(hex, 'hex').readBigUInt64LE()}`);
    }
  } else {
    // Redacted: an unexpected invokeContract failure could carry an arbitrary
    // payload, and this line is printed unconditionally.
    console.error('[3/6] FAIL:', redactJson(result, 600));
    throw new Error(`Dry-run failed: ${result.tag}`);
  }
  return result;
}

/** Phase 4: Build signable JSON and present signing instructions. */
function phaseSigningInstructions(payload: RegisterPayload): SignablePayload {
  console.error('[4/6] Building transaction JSON for wallet signing...');
  const tx = buildRegisterTransaction(payload, TESTNET);
  const signable: SignablePayload = {
    transactionJson: tx.transactionJson,
    sender: tx.sender,
    expiry: tx.expiry,
    network: 'testnet',
  };
  return signable;
}

/** Phase 5: Wait for finalization after owner submits. */
async function phaseFinalize(txHash: string) {
  console.error(`[5/6] Waiting for finalization: ${txHash}...`);
  const result = await waitForFinalization(txHash, TESTNET);
  console.error(`[5/6] Finalized: block=${result.blockHash}, status=${result.status}`);
  console.error(`[5/6] Explorer: ${TESTNET.explorerTx(txHash)}`);
  return result;
}

/** Phase 6: Verify on-chain state. */
async function phaseVerify(tokenAddress: string) {
  console.error('[6/6] Verifying on-chain state...');
  const mcp = mcpFor(TESTNET);
  const record = await mcp.agentByTokenAddress(tokenAddress);
  console.error('[6/6] On-chain record:', redactJson(record, 400));
  return record;
}

/** Main flow. */
export async function run(spec: CardSpec, ownerAccount: string, txHash?: string, tokenAddress?: string) {
  assert(isValidAccount(ownerAccount), `Invalid account address: ${ownerAccount}`);
  assert(isValidUri(spec.agentUri), `Invalid URI: ${spec.agentUri}`);

  // 1. Card
  const { card, cardJson } = await phaseCard(spec);

  // 2. Payload
  const payload = await phaseBuildPayload(card, ownerAccount);

  // 3. Dry-run (always — no tx needed)
  await phaseDryRun(payload);

  // 4. Sign instructions
  const signable = phaseSigningInstructions(payload);
  console.log(JSON.stringify({
    step: 'sign',
    transactionJson: signable.transactionJson,
    sender: signable.sender,
    expiry: signable.expiry,
    instructions: 'Sign this transaction with your Concordium Browser Wallet (Testnet). Use the "Sign with Concordium Wallet" button in the signing UI.',
    submitNote: 'After signing, copy the returned tx hash and call this tool again with --tx-hash',
    cardJson,
    cardSha256: card.metadata_hash_hex,
    parameterHex: payload.parameter_hex,
  }));

  if (!txHash) {
    console.error('\n[STEP] Awaiting tx hash from wallet...');
    return { state: 'awaiting_signature', signable, card, payload };
  }

  // 5. Finalize
  const finalization = await phaseFinalize(txHash);

  // 6. Verify
  if (tokenAddress) {
    await phaseVerify(tokenAddress);
  }

  console.log(JSON.stringify({
    step: 'registered',
    txHash,
    blockHash: finalization.blockHash,
    status: finalization.status,
    explorerUrl: TESTNET.explorerTx(txHash),
    tokenId: parseTokenIdFromReturnValue(card.metadata_hash_hex), // placeholder
  }));
  return finalization;
}

/** Parse the new token_id from the dry-run return value hex. */
function parseTokenIdFromReturnValue(_hash: string): number {
  // caller should decode from dry-run result; placeholder
  return -1;
}

// Parse CLI args: --key value pairs.
const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token?.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[token.slice(2)] = next && !next.startsWith('--') ? next : 'true';
}

// Always execute. This file is a bin entry point, not a library: gating on
// `process.argv[1].includes('agenttrust')` meant `node dist/cli/index.js` exited 0
// having done nothing, which is worse than a usage error.
const name = args.name ?? 'AgentTrust Demo';
const description = args.description ?? 'Demo agent for Concordium Trusted Agents Hackathon';
const agentUri = args.uri ?? 'https://example.com/agent-card.json';
const owner = args.owner ?? process.env.AGENTTRUST_OWNER ?? '';
const txHash = args['tx-hash'] ?? '';
const tokenAddress = args['token-address'] ?? '';

if (!owner) {
  // Exit 1 = usage error, matching the pre-existing contract for a missing required flag.
  console.error('Usage: agenttrust --name "Name" --description "..." --uri https://... --owner <base58addr> [--tx-hash <hash>]');
  console.error('Or set AGENTTRUST_OWNER env var.');
  process.exit(1);
}

run({
  name,
  description,
  agentUri,
  ownerAccount: owner,
  skills: [{ id: 'trust-gateway', name: 'Trust Gateway', description: 'Multi-agent trust and commerce' }],
}, owner, txHash, tokenAddress).catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
