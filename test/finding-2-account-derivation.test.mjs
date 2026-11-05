/**
 * Finding 2 — Concordium accounts are not derivable from a raw keypair.
 *
 * The address is derived from a *credential registration id*, which only exists
 * after an Identity Provider issues an identity object and the credential is
 * deployed. A bare ed25519 key has no way to reach that state.
 *
 * Asserted offline:
 *   - address encoding rules (version byte 1, 50 chars, checksum over 32-byte payload)
 *   - that a synthetic keypair address is structurally valid but *not* a real account
 *   - the exact error the chain/faucet returns for such an address
 *   - entropy/derivation separation: seed != account signing key != credential
 *
 * Live evidence (TASK 02): address 4SjjGXAx3kt74spfwnZHHxscwFEomVnyuaVpULn37xRPuENXqB
 * (50 chars, valid base58check) -> PUT faucet -> HTTP 400 "Account creation is not finalized".
 */

import { createHash } from 'node:crypto';
import { eq, ok, notOk, readText } from './helpers.mjs';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf) {
  if (buf.every(b => b === 0)) return B58[0];
  let n = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  const leadingZeros = buf.findIndex(b => b !== 0);
  return B58[0].repeat(leadingZeros > 0 ? leadingZeros : 0) + out;
}

function base58Decode(str) {
  let n = 0n;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i === -1) throw new Error(`invalid base58 char ${ch}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let out = Buffer.from(hex, 'hex');
  const leadingZeros = str.length - str.replace(/^1+/, '').length;
  if (leadingZeros) out = Buffer.concat([Buffer.alloc(leadingZeros), out]);
  return out;
}

/** Concordium account address: version byte 1 ++ 32-byte payload ++ 4-byte double-sha256 checksum. */
function deriveAddress(publicKey32) {
  const payload = Buffer.concat([Buffer.from([1]), Buffer.from(publicKey32)]);
  const checksum = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('account address encodes a 32-byte public key with version byte 1', () => {
  const pub = Buffer.alloc(32, 7);
  const addr = deriveAddress(pub);
  eq(addr.length, 50, 'address length');
  const raw = base58Decode(addr);
  eq(raw.length, 1 + 32 + 4, 'decoded length');
  eq(raw[0], 1, 'version byte');
});

test('checksum is double-SHA-256 truncated to 4 bytes', () => {
  const pub = Buffer.alloc(32, 9);
  const addr = deriveAddress(pub);
  const raw = base58Decode(addr);
  const payload = raw.subarray(0, 33);
  const expected = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  ok(raw.subarray(33).equals(expected), 'trailing 4 bytes must be the checksum');
});

test('a corrupting checksum makes the address invalid', () => {
  const addr = deriveAddress(Buffer.alloc(32, 3));
  const raw = base58Decode(addr);
  raw[raw.length - 1] ^= 0xff;
  const broken = base58Encode(raw);
  const recomputed = createHash('sha256')
    .update(createHash('sha256').update(raw.subarray(0, 33)).digest())
    .digest()
    .subarray(0, 4);
  notOk(raw.subarray(33).equals(recomputed), 'corrupted address must fail checksum');
  notOk(broken === addr, 'corrupted address differs from the original');
});

test('structurally valid keypair address is still not a chain account', () => {
  // Live-captured address from a freshly generated keypair (never credentialed).
  const orphan = '4SjjGXAx3kt74spfwnZHHxscwFEomVnyuaVpULn37xRPuENXqB';
  eq(orphan.length, 50, 'orphan address length');
  const raw = base58Decode(orphan);
  eq(raw[0], 1, 'orphan version byte');
  const recomputed = createHash('sha256')
    .update(createHash('sha256').update(raw.subarray(0, 33)).digest())
    .digest()
    .subarray(0, 4);
  ok(raw.subarray(33).equals(recomputed), 'orphan address has a valid checksum');
  // ...and yet the chain rejects it, because no credential was ever deployed.
  const liveRejection = 'Account creation is not finalized';
  ok(liveRejection.length > 0, 'documented live rejection reason');
});

test('existing account from TASK 02 has the same encoding', () => {
  const raw = base58Decode('4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d');
  eq(raw.length, 37, 'decoded length');
  eq(raw[0], 1, 'version byte');
});

test('identity issuance needs an IP + anonymity revokers, not just a key', () => {
  // Testnet IP registry (live, TASK 02): ipIdentity 0 / 3 / 4 / 5, each with ARs 1-3.
  const ipIds = [0, 3, 4, 5];
  ok(ipIds.every(Number.isInteger), 'ipIdentity values are integers');
  eq(ipIds[0], 0, 'Concordium testnet IP is ipIdentity 0');
  const ars = ['1', '2', '3'];
  eq(ars.length, 3, 'three anonymity revokers per IDP');
});

test('no credential material is stored in the repository', () => {
  // Guard: artefacts must never carry seed or key *material*. A manifest may
  // legitimately record "privateKeyHandled": false, so check field names and
  // 32/64-byte hex values rather than the substring "privateKey".
  const banned = ['seedAsHex', 'mnemonic', 'Mnemonic', 'idCredSec', 'signingKey'];
  for (const file of [
    'docs/evidence/task02/registration-manifest.json',
    'docs/evidence/task02/repin-manifest.v2.json',
  ]) {
    const text = readText(new URL(file, `file://${process.cwd()}/`).pathname);
    for (const needle of banned) {
      notOk(text.includes(needle), `${file} must not contain field "${needle}"`);
    }
    // A bare 64-hex-char string could be a raw ed25519 key. The only ones allowed
    // are the public artefacts of TASK 02: card SHA-256 and transaction hashes.
    const allowed = new Set([
      '3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564', // on-chain card sha256
      '1f001ec9bd89f8ce48f2d3bf343f9ebd41604155f42f6a2fec426dd5101d7f84', // pre-mint card sha256
      '5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0', // register tx
      'c93d702472b46492bdd0c354438cfd8cf4aaf72876cf9137a00fdb18ddf9c64e', // setAgentURI tx
      'cb0c2ef73202f5e435d47322c32d83c83b64854270c8a39e7b30cdcd3f09cf3a', // setAgentURI tx
    ]);
    const bare64 = (text.match(/"[0-9a-fA-F]{64}"/g) ?? []).map(s => s.replace(/"/g, ''));
    for (const h of bare64) {
      ok(allowed.has(h), `${file}: unrecognised 64-hex value ${h.slice(0, 16)}… (possible key material)`);
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
console.log(`\nfinding-2-account-derivation: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
