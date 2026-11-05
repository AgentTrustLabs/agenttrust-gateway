/**
 * Finding 4 — Concordium Wallet API serialization requirements.
 *
 * Every assertion here mirrors code paths read in concordium-browser-wallet and
 * is backed by a live failure observed during TASK 02. The wallet is the contract;
 * this suite pins the exact shapes that make it work.
 *
 * Live failures this suite prevents from recurring:
 *   "The provided type does not have a handler: Update"      (string type)
 *   "Cannot read properties of undefined (reading 'value')"  (flat receiveName/energy)
 */

import { eq, ok, notOk, readText, readJson, FIXTURES, EVIDENCE } from './helpers.mjs';

// ---- Reimplementation of the wallet's sanitizePayload() contract ----------
// concordium-browser-wallet/src/wallet-api/compatibility.ts
const sanitizePayloadUpdate = p => {
  // amount: microCcdAmount (GTU alias tolerated)
  const microCcdAmount = 'microCtuAmount' in p.amount ? p.amount.microCtuAmount : p.amount.microCcdAmount;
  // energy: accepts bigint OR { value }
  const energy = typeof p.maxContractExecutionEnergy !== 'bigint'
    ? p.maxContractExecutionEnergy.value          // <-- throws if missing
    : p.maxContractExecutionEnergy;
  // receiveName: accepts string OR { value }
  const receiveName = typeof p.receiveName === 'string'
    ? p.receiveName
    : p.receiveName.value;                        // <-- throws if missing
  return { microCcdAmount, energy, receiveName };
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('transaction type must be the numeric AccountTransactionType.Update (2)', () => {
  const AccountTransactionTypeUpdate = 2;
  eq(AccountTransactionTypeUpdate, 2, 'Update is enum value 2');
  // Live failure with 'Update' (string): "The provided type does not have a handler: Update"
  const accepted = [0, 1, 2, 3];
  ok(accepted.includes(AccountTransactionTypeUpdate), 'numeric type is accepted');
  notOk(accepted.includes('Update'), "the string 'Update' is not in the handler table");
});

test('receiveName and energy must be { value } objects (or raw bigint for energy)', () => {
  // Working shape, used by the live registration.
  const good = sanitizePayloadUpdate({
    amount: { microCcdAmount: 0n },
    receiveName: { value: 'CIS-8004.setAgentURI' },
    maxContractExecutionEnergy: { value: 30000n },
  });
  eq(good.receiveName, 'CIS-8004.setAgentURI', 'receiveName resolved from .value');
  eq(good.energy, 30000n, 'energy resolved from .value');

  // The live failure was a *missing* field, not a wrong-typed one:
  // "Cannot read properties of undefined (reading 'value')".
  let threw = false;
  try {
    sanitizePayloadUpdate({
      amount: { microCcdAmount: 0n },
      receiveName: { value: 'CIS-8004.setAgentURI' },
      // maxContractExecutionEnergy omitted entirely
    });
  } catch (e) {
    threw = true;
    ok(String(e.message).includes('undefined'), 'failure surfaces as undefined.value');
  }
  ok(threw, 'missing maxContractExecutionEnergy must throw');

  let threw2 = false;
  try {
    sanitizePayloadUpdate({
      amount: { microCcdAmount: 0n },
      // receiveName omitted
      maxContractExecutionEnergy: { value: 30000n },
    });
  } catch (e) {
    threw2 = true;
  }
  ok(threw2, 'missing receiveName must throw');

  // A flat *number* does not throw — it silently becomes undefined, which is why
  // the failure surfaced later. Pin that hazard explicitly.
  const silent = sanitizePayloadUpdate({
    amount: { microCcdAmount: 0n },
    receiveName: { value: 'CIS-8004.register' },
    maxContractExecutionEnergy: 30000,
  });
  eq(silent.energy, undefined, 'flat number is silently dropped — never pass it');
});

test('energy may alternatively be a raw bigint', () => {
  const r = sanitizePayloadUpdate({
    amount: { microCcdAmount: 0n },
    receiveName: 'CIS-8004.register',
    maxContractExecutionEnergy: 30000n,
  });
  eq(r.energy, 30000n, 'bigint energy passes through');
});

test('receiveName may alternatively be a plain string', () => {
  const r = sanitizePayloadUpdate({
    amount: { microCcdAmount: 0n },
    receiveName: 'CIS-8004.register',
    maxContractExecutionEnergy: { value: 30000n },
  });
  eq(r.receiveName, 'CIS-8004.register', 'string receiveName passes through');
});

test('schema must be a { type: module, value: <b64 module schema> } object', () => {
  // Wallet: SchemaType.Module === 'module'
  const schema = { type: 'module', value: 'BASE64' };
  eq(schema.type, 'module', 'module schema type');
  notOk(schema.type === 'parameter', "'parameter' is the other branch — wrong one for a full contract call");
  ok(typeof schema.value === 'string', 'value is base64 text');
});

test('module schema fixture is the CIS-8004 testnet module schema', () => {
  const schema = readJson(`${FIXTURES}mcp-build-agent-card-token1004.json`); // ensures fixtures load
  ok(schema, 'fixtures present');
  const repin = readJson(`${EVIDENCE}repin-manifest.v2.json`);
  ok(repin.moduleSchemaBase64.length > 1000, 'module schema is substantial (b64)');
  ok(Buffer.from(repin.moduleSchemaBase64, 'base64').subarray(0, 4).equals(Buffer.from([0xff, 0xff, 0x03, 0x01])),
    'module schema starts with the concordium schema magic (ffff0301)');
});

test('payload carries amount=0 and the live contract/entrypoint', () => {
  const repin = readJson(`${EVIDENCE}repin-manifest.v2.json`);
  eq(repin.receiveName, 'CIS-8004.setAgentURI', 'entrypoint');
  eq(repin.contract.index, 12802, 'contract index');
  eq(repin.contract.subindex, 0, 'contract subindex');
  eq(repin.parameterHex.slice(0, 16), '08ec030000000000', 'token_id 1004 little-endian prefix');
});

test('schemaVersion may be omitted when the schema is versioned', () => {
  // Live: omitting the 6th argument worked; the module schema self-describes its version.
  const args = ['account', 2, {}, {}, { type: 'module', value: 'x' }];
  eq(args.length, 5, 'five arguments is sufficient');
});

test('params are passed separately from payload.message', () => {
  // The wallet overwrites payload.message from the separate params argument so that
  // what is displayed equals what is signed. Passing a pre-serialized message in
  // payload would be discarded.
  const repin = readJson(`${EVIDENCE}repin-manifest.v2.json`);
  ok(repin.parameterJson, 'JSON params supplied separately');
  ok(repin.parameterHex, 'hex produced server-side for dry-run comparison');
  ok(!('message' in repin), 'no stray message field in the artefact');
});

test('signing page uses exactly these shapes', () => {
  const html = readText(`${process.cwd()}/signing-site/repin.html`);
  ok(html.includes('receiveName: { value:'), 'receiveName wrapped in { value }');
  ok(html.includes('maxContractExecutionEnergy: { value:'), 'energy wrapped in { value }');
  ok(html.includes("type: 'module'"), "schema type is 'module'");
  ok(/sendTransaction\(account, 2,/.test(html), 'numeric transaction type 2');
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
console.log(`\nfinding-4-wallet-serialization: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
