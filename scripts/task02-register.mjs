/**
 * TASK 02 — live registration orchestration.
 *
 * Runs the real flow against testnet with the funded owner account:
 *   1. build Agent Card (MCP)
 *   2. build CIS-8004 register payload (MCP)
 *   3. dry-run via gRPC invokeContract (proves payload is accepted by contract)
 *   4. emit signable transaction for the owner's wallet
 *   5. on tx hash: wait for finalization, verify on-chain
 *
 * No private key is read, stored, or logged by this script.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mcpFor } from '../src/registry/mcpClient.js';
import { buildRegisterTransaction, waitForFinalization } from '../src/registry/txBuilder.js';
import { TESTNET } from '../src/core/types.js';

const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const AGENT_URI = 'https://agenttrust.sabolabs.dev/.well-known/agent-card.json';
const OUT = 'docs/evidence/task02';

async function main() {
  mkdirSync(OUT, { recursive: true });
  const mcp = mcpFor(TESTNET);

  // ---- 0. Preflight -------------------------------------------------------
  console.log('[0] preflight');
  const health = await mcp.health();
  console.log('    mcp:', JSON.stringify(health));
  if (!health.ok) throw new Error('MCP not healthy');

  const contract = await mcp.contractInfo();
  console.log('    cis8004:', JSON.stringify(contract.cis8004_contract));
  if (contract.cis8004_contract.index !== 12802) {
    throw new Error(`Unexpected contract index ${contract.cis8004_contract.index}`);
  }

  // ---- 1. Agent Card ------------------------------------------------------
  console.log('[1] build agent card');
  const card = await mcp.buildAgentCard({
    name: 'AgentTrust Gateway',
    description:
      'Reusable trust and commerce gateway for independently operated AI agents on Concordium. ' +
      'Provides identity verification, capability discovery, agent-to-agent payment, and verifiable activity evidence.',
    agentUri: AGENT_URI,
    ownerAccount: OWNER,
    skills: [
      {
        id: 'identity-verification',
        name: 'Agent Identity Verification',
        description: 'Resolve a CIS-8004 agent, confirm its owner and Active status, and verify its Agent Card hash.',
      },
      {
        id: 'capability-discovery',
        name: 'Capability Discovery',
        description: 'Search and filter registered agents by capability, owner, or status via the registry indexer.',
      },
      {
        id: 'payment-settlement',
        name: 'Agent Payment Settlement',
        description: 'Execute and evidence agent-to-agent payments over the x402 protocol on Concordium.',
      },
    ],
  });

  console.log('    uri:', card.agent_uri);
  console.log('    sha256:', card.metadata_hash_hex);
  console.log('    card bytes:', Buffer.byteLength(card.agent_card_json, 'utf8'));

  // Independent hash check: recompute local SHA-256 over the exact bytes.
  const localHash = createHash('sha256').update(Buffer.from(card.agent_card_json, 'utf8')).digest('hex');
  console.log('    local sha256:', localHash);
  if (localHash !== card.metadata_hash_hex) {
    throw new Error(`HASH MISMATCH: mcp=${card.metadata_hash_hex} local=${localHash}`);
  }
  console.log('    hash check: OK');

  writeFileSync(`${OUT}/agent-card.json`, card.agent_card_json);
  writeFileSync(`${OUT}/agent-card.sha256`, card.metadata_hash_hex + '\n');

  // ---- 2. Register payload ------------------------------------------------
  console.log('[2] build register payload');
  const payload = await mcp.buildRegister({
    sender: OWNER,
    agentUri: card.agent_uri,
    metadataHashHex: card.metadata_hash_hex,
  });
  console.log('    contract:', `${payload.contract_address.index}.${payload.contract_address.subindex}`);
  console.log('    receive:', payload.receive_name);
  console.log('    param hex len:', payload.parameter_hex.length);
  console.log('    energy:', payload.suggested_energy);

  writeFileSync(`${OUT}/register-payload.json`, JSON.stringify(payload, null, 2));

  // ---- 3. Dry run ---------------------------------------------------------
  console.log('[3] dry run (invokeContract)');
  const { ConcordiumGRPCWebClient, AccountAddress, ContractAddress, ReceiveName, Parameter, Energy } =
    await import('@concordium/web-sdk');
  const client = new ConcordiumGRPCWebClient(TESTNET.grpcHost, TESTNET.grpcPort, { useTls: TESTNET.useTls });

  const ownerInfo = await client.getAccountInfo(AccountAddress.fromBase58(OWNER));
  const balance = String(ownerInfo.accountAmount.microCcdAmount);
  console.log('    owner balance:', Number(balance) / 1e6, 'CCD');

  const invoke = await client.invokeContract({
    invoker: AccountAddress.fromBase58(OWNER),
    contract: ContractAddress.create(
      BigInt(payload.contract_address.index),
      BigInt(payload.contract_address.subindex),
    ),
    method: ReceiveName.fromStringUnchecked(payload.receive_name),
    parameter: Parameter.fromHexString(payload.parameter_hex),
    energy: Energy.create(100000n),
  });

  console.log('    tag:', invoke.tag, 'energy used:', String(invoke.usedEnergy?.value));
  if (invoke.tag !== 'success') {
    writeFileSync(`${OUT}/dry-run.json`, JSON.stringify(invoke, (_, v) => (typeof v === 'bigint' ? String(v) : v), 2));
    throw new Error(`Dry run failed: ${invoke.tag}`);
  }

  const rvHex = invoke.returnValue?.buffer ? Buffer.from(invoke.returnValue.buffer).toString('hex') : null;
  const predictedTokenId = rvHex ? Buffer.from(rvHex, 'hex').readBigUInt64LE().toString() : null;
  console.log('    returnValue:', rvHex, '-> token_id', predictedTokenId);

  writeFileSync(
    `${OUT}/dry-run.json`,
    JSON.stringify(
      {
        tag: invoke.tag,
        usedEnergy: String(invoke.usedEnergy?.value),
        returnValueHex: rvHex,
        predictedTokenId,
        events: invoke.events?.length ?? 0,
      },
      null,
      2,
    ),
  );

  // ---- 4. Signable transaction -------------------------------------------
  console.log('[4] build signable transaction');
  const nonce = await client.getNextAccountNonce(AccountAddress.fromBase58(OWNER));
  const signable = buildRegisterTransaction(payload, TESTNET);
  console.log('    sender:', signable.sender);
  console.log('    nonce:', String(nonce.nonce));
  console.log('    expiry:', signable.expiry);

  writeFileSync(
    `${OUT}/signable-transaction.json`,
    JSON.stringify(
      {
        about:
          'CIS-8004 agent registration on Concordium testnet. Sign with the Concordium Wallet for Web ' +
          '(Testnet). No private key appears in this file.',
        network: 'testnet',
        contract: `ccd:${TESTNET.caip2.split(':')[1]}:12802.0`,
        entrypoint: 'CIS-8004.register',
        owner: OWNER,
        nextNonce: String(nonce.nonce),
        transaction: JSON.parse(signable.transactionJson),
      },
      null,
      2,
    ),
  );

  // ---- Manifest -----------------------------------------------------------
  const manifest = {
    task: 'TASK 02 — first real CIS-8004 registration',
    network: 'testnet',
    caip2: TESTNET.caip2,
    generatedAt: new Date().toISOString(),
    owner: OWNER,
    ownerBalanceMicroCcd: balance,
    contract: { index: 12802, subindex: 0, standard: 'CIS-8004' },
    entrypoint: 'CIS-8004.register',
    agentUri: card.agent_uri,
    cardSha256: card.metadata_hash_hex,
    cardBytes: Buffer.byteLength(card.agent_card_json, 'utf8'),
    parameterHex: payload.parameter_hex,
    suggestedEnergy: payload.suggested_energy,
    dryRun: { tag: invoke.tag, usedEnergy: String(invoke.usedEnergy?.value), predictedTokenId },
    nextNonce: String(nonce.nonce),
    status: 'awaiting_signature',
    privateKeyHandled: false,
    tokenId: null,
    txHash: null,
  };
  writeFileSync(`${OUT}/registration-manifest.json`, JSON.stringify(manifest, null, 2));

  console.log('[5] manifest written:', `${OUT}/registration-manifest.json`);
  console.log('READY_FOR_SIGNING');
}

main().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
