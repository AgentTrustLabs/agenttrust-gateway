/**
 * Probe: can an agent-generated Ed25519 keypair become a funded testnet account?
 *
 * Concordium accounts are NOT derived from a bare public key — the address is
 * derived from a credential registration ID, which requires an identity object
 * signed by an Identity Provider (with anonymity revokers). This script proves
 * that by trying the official faucet path against a freshly generated address.
 *
 * ── Output policy ───────────────────────────────────────────────────────
 *
 * The keypair is generated only to derive a public address, and the private half
 * is discarded without ever being formatted. It is never printed, hashed for
 * display, or written to disk — an ephemeral, unfunded key is still a key, and
 * printing one teaches the wrong habit (and sets a bad precedent for the pattern
 * of "just this once").
 *
 * Emitted: the public address, its length, the public key (public by definition),
 * and the faucet's HTTP status. All useful diagnostics are preserved.
 *
 *   node scripts/probe-agent-account.mjs [--no-faucet]
 */

import { generateKeyPairSync, createHash } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf) {
  if (buf.every(b => b === 0)) return B58[0];
  let n = BigInt('0x' + buf.toString('hex'));
  let out = '';
  while (n > 0n) {
    const r = n % 58n;
    n = n / 58n;
    out = B58[Number(r)] + out;
  }
  const leadingZeros = buf.findIndex(b => b !== 0);
  return B58[0].repeat(leadingZeros > 0 ? leadingZeros : 0) + out;
}

const kp = generateKeyPairSync('ed25519');
const spki = kp.publicKey.export({ type: 'spki', format: 'der' });

// Public half only. The private key is intentionally never exported at all.
const pubRaw = spki.subarray(spki.length - 32);

const payload = Buffer.concat([Buffer.from([1]), Buffer.from(pubRaw)]);
const checksum = createHash('sha256')
  .update(createHash('sha256').update(payload).digest())
  .digest()
  .subarray(0, 4);

const address = base58Encode(Buffer.concat([payload, checksum]));

console.log(JSON.stringify({
  address,
  addressLength: address.length,
  publicKeyHex: Buffer.from(pubRaw).toString('hex'),
  privateKeyPrinted: false,
  privateKeyPersisted: false,
}, null, 2));

if (process.argv.includes('--no-faucet')) {
  console.log('faucet: skipped (--no-faucet)');
  process.exit(0);
}

// Now try the official faucet endpoint against this address.
const res = await fetch(
  `https://wallet-proxy.testnet.concordium.com/v0/testnetGTUDrop/${address}`,
  { method: 'PUT' },
);
console.log('faucet HTTP', res.status);
console.log('faucet body:', (await res.text()).slice(0, 300));
