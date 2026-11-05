/**
 * TASK 02b — build the CIS-8004.setAgentURI re-pin payload.
 *
 * Re-points token 1004 at the live card host and re-anchors the same SHA-256.
 * Dry-runs against testnet before emitting the signing artefacts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { getUpdateContractParameterSchema, serializeTypeValue, ContractName, EntrypointName } from '@concordium/web-sdk';
import { mcpFor } from '../src/registry/mcpClient.js';
import { TESTNET } from '../src/core/types.js';

const OWNER = '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d';
const TOKEN_ID = 1004;
const NEW_URI = 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json';
const CARD_SHA256 = '1f001ec9bd89f8ce48f2d3bf343f9ebd41604155f42f6a2fec426dd5101d7f84';
const MODULE_SCHEMA = '/tmp/cis8004-schema.bin';
const OUT = 'docs/evidence/task02';

mkdirSync(OUT, { recursive: true });
const mcp = mcpFor(TESTNET);

// ---- 1. MCP payload -----------------------------------------------------
const p = await mcp.buildSetAgentUri({
  tokenId: TOKEN_ID,
  agentUri: NEW_URI,
  metadataHashHex: CARD_SHA256,
  sender: OWNER,
});

console.log('contract :', `${p.contract_address.index}.${p.contract_address.subindex}`);
console.log('receive  :', p.receive_name);
console.log('energy   :', p.suggested_energy);
console.log('hex      :', p.parameter_hex);

// ---- 2. Round-trip against the module schema ---------------------------
const { readFileSync } = await import('node:fs');
const moduleSchema = readFileSync(MODULE_SCHEMA);
const [contractName, entrypoint] = p.receive_name.split('.');
const paramSchema = getUpdateContractParameterSchema(
  moduleSchema,
  ContractName.fromStringUnchecked(contractName),
  EntrypointName.fromStringUnchecked(entrypoint),
  1,
);
const roundTrip = serializeTypeValue(p.parameter_json, paramSchema);
const roundTripHex = Buffer.from(roundTrip.buffer).toString('hex');
const rtMatch = roundTripHex === p.parameter_hex;
console.log('round-trip:', rtMatch ? 'OK' : 'MISMATCH');
if (!rtMatch) throw new Error(`round-trip mismatch\n mcp=${p.parameter_hex}\n loc=${roundTripHex}`);

// ---- 3. Dry run ---------------------------------------------------------
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
console.log('dry-run  :', invoke.tag, 'energy used:', String(invoke.usedEnergy?.value));
if (invoke.tag !== 'success') {
  console.log(JSON.stringify(invoke, (_, v) => (typeof v === 'bigint' ? String(v) : v), 1).slice(0, 800));
  throw new Error(`dry run rejected: ${invoke.tag}`);
}

const nonce = await client.getNextAccountNonce(AccountAddress.fromBase58(OWNER));
console.log('next nonce:', String(nonce.nonce));

// ---- 4. Artefacts -------------------------------------------------------
const repin = {
  network: 'testnet',
  action: 'setAgentURI',
  tokenId: TOKEN_ID,
  contract: { index: p.contract_address.index, subindex: p.contract_address.subindex },
  receiveName: p.receive_name,
  owner: OWNER,
  newAgentUri: NEW_URI,
  cardSha256: CARD_SHA256,
  suggestedEnergy: p.suggested_energy,
  parameterHex: p.parameter_hex,
  parameterJson: p.parameter_json,
  moduleSchemaBase64: Buffer.from(moduleSchema).toString('base64'),
  nextNonce: String(nonce.nonce),
  dryRun: { tag: invoke.tag, usedEnergy: String(invoke.usedEnergy?.value), roundTripVerified: rtMatch },
  generatedAt: new Date().toISOString(),
};

writeFileSync('signing-site/repin.json', JSON.stringify(repin, null, 2));
writeFileSync(`${OUT}/repin-manifest.json`, JSON.stringify(repin, null, 2));
console.log('wrote signing-site/repin.json');
console.log('READY_FOR_SIGNING');
