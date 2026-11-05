/**
 * TASK 02c — rebuild the Agent Card POST-MINT so the badge carries the
 * canonical tokenAddress, then prepare the setAgentURI re-pin for the new hash.
 *
 * Root cause of badge_valid=false after 02b: the card was generated pre-mint
 * (token_id=null), so capabilities.extensions[].params.tokenAddress was null.
 * check_badge requires tokenAddress to be present and to match the agent.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  getUpdateContractParameterSchema,
  serializeTypeValue,
  ContractName,
  EntrypointName,
} from '@concordium/web-sdk';
import { mcpFor } from '../src/registry/mcpClient.js';
import { TESTNET } from '../src/core/types.js';

const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const TOKEN_ID = 1004;
const AGENT_URI = 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json';
const MODULE_SCHEMA = '/tmp/cis8004-schema.bin';
const OUT = 'docs/evidence/task02';

mkdirSync(OUT, { recursive: true });
const mcp = mcpFor(TESTNET);

// ---- 1. Rebuild card with the known token_id ----------------------------
const card = await mcp.buildAgentCard({
  name: 'AgentTrust Gateway',
  description:
    'Reusable trust and commerce gateway for independently operated AI agents on Concordium. ' +
    'Provides identity verification, capability discovery, agent-to-agent payment, and verifiable activity evidence.',
  agentUri: AGENT_URI,
  ownerAccount: OWNER,
  tokenId: TOKEN_ID,
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

// build_agent_card leaves tokenAddress null even when token_id is supplied
// (it only pre-computes it when the tool can resolve the token on chain).
// build_agent_badge is the tool that actually merges the post-mint badge block.
const badged = await mcp.callToolRaw('build_agent_badge', {
  card_json: card.agent_card_json,
  owner_account: OWNER,
  token_id: TOKEN_ID,
});

const cardJsonV2 = badged.agent_card_json ?? badged.card_json;
if (!cardJsonV2) {
  throw new Error('build_agent_badge returned no card: ' + JSON.stringify(badged).slice(0, 400));
}

const bytes = Buffer.from(cardJsonV2, 'utf8');
const localHash = createHash('sha256').update(bytes).digest('hex');
const reportedHash = badged.metadata_hash_hex ?? badged.sha256;
if (reportedHash && reportedHash !== localHash) {
  throw new Error(`hash mismatch mcp=${reportedHash} local=${localHash}`);
}

const parsed = JSON.parse(cardJsonV2);
const ext = parsed?.capabilities?.extensions?.[0];
console.log('local sha256        :', localHash);
console.log('ext.params.tokenAddress:', ext?.params?.tokenAddress);
console.log('ext.params.agentWallet :', ext?.params?.agentWallet);
console.log('card bytes          :', bytes.length);
console.log('card sha256         :', localHash);
console.log('registrations       :', JSON.stringify(parsed?.registrations ?? null).slice(0, 200));

if (!ext?.params?.tokenAddress) {
  throw new Error('tokenAddress still empty — refusing to publish');
}

// ---- 2. Write the card for hosting -------------------------------------
writeFileSync(`${OUT}/agent-card.v2.json`, cardJsonV2);
writeFileSync('signing-site/.well-known/agent-card.json', cardJsonV2);
writeFileSync(`${OUT}/agent-card.sha256.v2`, localHash + '\n');
console.log('card written to signing-site/.well-known/agent-card.json');

// ---- 3. Build the setAgentURI re-pin for the NEW hash ------------------
const p = await mcp.buildSetAgentUri({
  tokenId: TOKEN_ID,
  agentUri: AGENT_URI,
  metadataHashHex: localHash,
  sender: OWNER,
});
console.log('receive  :', p.receive_name);
console.log('energy   :', p.suggested_energy);

// ---- 4. Round-trip + dry run -------------------------------------------
const { readFileSync } = await import('node:fs');
const moduleSchema = readFileSync(MODULE_SCHEMA);
const [cn, ep] = p.receive_name.split('.');
const paramSchema = getUpdateContractParameterSchema(
  moduleSchema,
  ContractName.fromStringUnchecked(cn),
  EntrypointName.fromStringUnchecked(ep),
  1,
);
const rtHex = Buffer.from(serializeTypeValue(p.parameter_json, paramSchema).buffer).toString('hex');
const rtMatch = rtHex === p.parameter_hex;
console.log('round-trip:', rtMatch ? 'OK' : 'MISMATCH');
if (!rtMatch) throw new Error('round-trip mismatch');

const { ConcordiumGRPCWebClient, AccountAddress, ContractAddress, ReceiveName, Parameter, Energy } =
  await import('@concordium/web-sdk');
const client = new ConcordiumGRPCWebClient(TESTNET.grpcHost, TESTNET.grpcPort, { useTls: TESTNET.useTls });
const invoke = await client.invokeContract({
  invoker: AccountAddress.fromBase58(OWNER),
  contract: ContractAddress.create(BigInt(p.contract_address.index), BigInt(p.contract_address.subindex)),
  method: ReceiveName.fromStringUnchecked(p.receive_name),
  parameter: Parameter.fromHexString(p.parameter_hex),
  energy: Energy.create(100000n),
});
console.log('dry-run  :', invoke.tag, 'energy:', String(invoke.usedEnergy?.value));
if (invoke.tag !== 'success') throw new Error(`dry run rejected: ${invoke.tag}`);

const nonce = await client.getNextAccountNonce(AccountAddress.fromBase58(OWNER));
console.log('next nonce:', String(nonce.nonce));

// ---- 5. Signing artefact ----------------------------------------------
const repin = {
  network: 'testnet',
  action: 'setAgentURI (v2 card, tokenAddress present)',
  tokenId: TOKEN_ID,
  contract: { index: p.contract_address.index, subindex: p.contract_address.subindex },
  receiveName: p.receive_name,
  owner: OWNER,
  newAgentUri: AGENT_URI,
  cardSha256: localHash,
  previousSha256: '1f001ec9bd89f8ce48f2d3bf343f9ebd41604155f42f6a2fec426dd5101d7f84',
  suggestedEnergy: p.suggested_energy,
  parameterHex: p.parameter_hex,
  parameterJson: p.parameter_json,
  moduleSchemaBase64: Buffer.from(moduleSchema).toString('base64'),
  nextNonce: String(nonce.nonce),
  dryRun: { tag: invoke.tag, usedEnergy: String(invoke.usedEnergy?.value), roundTripVerified: rtMatch },
  generatedAt: new Date().toISOString(),
};
writeFileSync('signing-site/repin.json', JSON.stringify(repin, null, 2));
writeFileSync(`${OUT}/repin-manifest.v2.json`, JSON.stringify(repin, null, 2));
console.log('READY_FOR_SIGNING');
