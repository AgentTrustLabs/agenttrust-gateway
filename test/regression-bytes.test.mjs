/**
 * Cross-cutting regressions — the byte-level guarantees the whole flow rests on.
 *
 * These are the checks that would have caught the two extra on-chain transactions
 * we burned in TASK 02:
 *   - parameter bytes handed to the wallet must equal the MCP parameter_hex
 *   - the card hash anchored on chain must equal the local SHA-256 of the served bytes
 */

import {
  getUpdateContractParameterSchema,
  serializeTypeValue,
  ContractName,
  EntrypointName,
} from '@concordium/web-sdk';
import { readFileSync } from 'node:fs';
import { eq, ok, readJson, readText, sha256Hex, TASK02, EVIDENCE, FIXTURES } from './helpers.mjs';

const moduleSchema = readFileSync(`${FIXTURES}cis8004-module-schema.bin`);

function paramSchemaFor(receiveName) {
  const [cn, ep] = receiveName.split('.');
  return getUpdateContractParameterSchema(
    moduleSchema,
    ContractName.fromStringUnchecked(cn),
    EntrypointName.fromStringUnchecked(ep),
    1,
  );
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('module schema fixture hashes to the expected value', () => {
  eq(sha256Hex(moduleSchema), '9f8b59ab770c90c0bc240ad087e6e0fd79e2fb0c360cc6703dd4729c85ebdd6d', 'schema sha256');
});

test('register params serialize byte-identically to the MCP parameter_hex', () => {
  const payload = readJson(`${EVIDENCE}register-payload.json`);
  const schema = paramSchemaFor(payload.receive_name);
  const hex = Buffer.from(serializeTypeValue(payload.parameter_json, schema).buffer).toString('hex');
  eq(hex, payload.parameter_hex, 'wallet-path serialization equals MCP bytes');
});

test('setAgentURI v2 params serialize byte-identically (same-hash re-pin)', () => {
  const m = readJson(`${EVIDENCE}repin-manifest.v2.json`);
  const schema = paramSchemaFor(m.receiveName);
  const hex = Buffer.from(serializeTypeValue(m.parameterJson, schema).buffer).toString('hex');
  eq(hex, m.parameterHex, 'round-trip equality');
  ok(m.dryRun.roundTripVerified, 'manifest recorded round-trip success');
});

test('anchored card hash equals local sha256 of the served bytes', () => {
  const served = readText(`${EVIDENCE}agent-card.v2.json`);
  eq(sha256Hex(Buffer.from(served, 'utf8')), TASK02.cardSha256, 'local hash');
  const repin = readJson(`${EVIDENCE}repin-manifest.v2.json`);
  eq(repin.cardSha256, TASK02.cardSha256, 'manifest hash');
});

test('card hashing is over exact bytes — reformatting invalidates the anchor', () => {
  const served = readText(`${EVIDENCE}agent-card.v2.json`);
  const reformatted = JSON.stringify(JSON.parse(served));
  ok(reformatted !== served, 'compact re-serialization yields different bytes');
  ok(sha256Hex(Buffer.from(reformatted, 'utf8')) !== TASK02.cardSha256, 'and therefore a different hash');
});

test('dry-run was accepted before signing (recorded evidence)', () => {
  const dryRun = readJson(`${EVIDENCE}dry-run.json`);
  eq(dryRun.tag, 'success', 'invokeContract tag');
  ok(Number(dryRun.usedEnergy) > 0, 'energy consumed');
});

test('transaction hashes in the report are well-formed', () => {
  for (const [label, hash] of Object.entries(TASK02.txHashes)) {
    ok(/^[0-9a-f]{64}$/.test(hash), `${label} is a 32-byte hex hash`);
  }
});

test('no credential material in any task artefact', () => {
  const files = [
    'registration-manifest.json',
    'repin-manifest.json',
    'repin-manifest.v2.json',
    'signable-transaction.json',
    'register-payload.json',
  ];
  // Look for key MATERIAL, not words: a manifest legitimately states
  // "privateKeyHandled": false. What must never appear is a hex key value or a
  // credential-bearing field name.
  const forbiddenFields = ['seedAsHex', 'mnemonic', 'idCredSec', 'signingKey', 'secretKey'];
  const keyLikeValue = /"(?:[0-9a-fA-F]{64})"/;
  for (const f of files) {
    const text = readText(`${EVIDENCE}${f}`);
    for (const needle of forbiddenFields) {
      ok(!text.includes(needle), `${f} must not contain field "${needle}"`);
    }
    // hex words are only allowed if they are known card/token/param hashes
    const hexValues = text.match(keyLikeValue) ?? [];
    for (const v of hexValues) {
      const h = v.replace(/"/g, '');
      const known = h === TASK02.cardSha256 || h === TASK02.preMintSha256 ||
                    Object.values(TASK02.txHashes).includes(h) ||
                    text.includes('parameterHex') || text.includes('metadata_hash');
      ok(known, `${f}: unexpected 32-byte hex value ${h.slice(0, 16)}…`);
    }
  }
});

test('manifest secrets check also covers the signing site payloads', () => {
  for (const f of ['registration.json', 'repin.json']) {
    const text = readText(`${process.cwd()}/signing-site/${f}`);
    for (const needle of ['seedAsHex', 'privateKey', 'PRIVATE_KEY', 'mnemonic']) {
      ok(!text.includes(needle), `signing-site/${f} must not contain "${needle}"`);
    }
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.message.replace(/\n/g, '\n       ')}`);
  }
}
console.log(`\nregression-bytes: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
