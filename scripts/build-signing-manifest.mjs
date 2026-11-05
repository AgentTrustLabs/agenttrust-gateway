/**
 * Generates signing-site/registration.json from the TASK 02 artifacts:
 * parameterJson (contract params), parameterSchemaBase64 (parameter schema),
 * plus display fields. Also writes the schema binary once.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  getUpdateContractParameterSchema,
  serializeTypeValue,
  ContractName,
  EntrypointName,
} from '@concordium/web-sdk';

const SCHEMA_BIN = '/tmp/cis8004-schema.bin';
const EV = 'docs/evidence/task02';

const payload = JSON.parse(readFileSync(`${EV}/register-payload.json`, 'utf8'));
const manifest = JSON.parse(readFileSync(`${EV}/registration-manifest.json`, 'utf8'));

const moduleSchema = readFileSync(SCHEMA_BIN);
const paramSchema = getUpdateContractParameterSchema(
  moduleSchema,
  ContractName.fromStringUnchecked('CIS-8004'),
  EntrypointName.fromStringUnchecked('register'),
  1,
);

// Prove byte-exactness before publishing the page.
const roundTrip = serializeTypeValue(payload.parameter_json, paramSchema);
const roundTripHex = Buffer.from(roundTrip.buffer).toString('hex');
if (roundTripHex !== payload.parameter_hex) {
  throw new Error('parameter round-trip mismatch — refusing to publish signing page');
}
console.log('round-trip: OK (byte-identical to MCP parameter_hex)');

const out = {
  network: 'testnet',
  contract: { index: payload.contract_address.index, subindex: payload.contract_address.subindex },
  receiveName: payload.receive_name,
  owner: manifest.owner,
  suggestedEnergy: payload.suggested_energy,
  agentUri: manifest.agentUri,
  cardSha256: manifest.cardSha256,
  parameterHex: payload.parameter_hex,
  parameterJson: payload.parameter_json,
  parameterSchemaBase64: Buffer.from(paramSchema).toString('base64'),
};

out.moduleSchemaBase64 = Buffer.from(moduleSchema).toString('base64');

writeFileSync('signing-site/registration.json', JSON.stringify(out, null, 2));
writeFileSync(`${EV}/parameter-schema.bin`, paramSchema);
console.log('schema b64 length:', out.parameterSchemaBase64.length);
console.log('wrote signing-site/registration.json');
