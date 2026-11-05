/**
 * Shared helpers for the regression suite.
 *
 * Design rules:
 *  - Offline. No MCP calls, no gRPC, no network. Fixtures only.
 *  - Absolutely no credentials, keys or seed phrases anywhere.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const ROOT = new URL('..', import.meta.url).pathname;
export const FIXTURES = `${ROOT}test/fixtures/`;
export const EVIDENCE = `${ROOT}docs/evidence/task02/`;

export const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
export const readText = p => readFileSync(p, 'utf8');

export const sha256Hex = buf => createHash('sha256').update(buf).digest('hex');

/** Known-good values captured live in TASK 02 (see docs/TASK02-result.md). */
export const TASK02 = {
  network: 'testnet',
  caip2: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  contractIndex: 12802,
  cis8Index: 12801,
  tokenId: 1004,
  tokenAddress: 'JyP9YLib1wYgFmztkcKJL',
  owner: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d',
  agentUri: 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json',
  cardSha256: '3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564',
  cardBytes: 2777,
  preMintSha256: '1f001ec9bd89f8ce48f2d3bf343f9ebd41604155f42f6a2fec426dd5101d7f84',
  registerParamHex:
    '013b00000068747470733a2f2f6167656e7474727573742e7361626f6c6162732e6465762f2e77656c6c2d6b6e6f776e2f6167656e742d636172642e6a736f6e' +
    '011f001ec9bd89f8ce48f2d3bf343f9ebd41604155f42f6a2fec426dd5101d7f840000000000',
  txHashes: {
    register: '5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0',
    setAgentUri1: 'c93d702472b46492bdd0c354438cfd8cf4aaf72876cf9137a00fdb18ddf9c64e',
    setAgentUri2: 'cb0c2ef73202f5e435d47322c32d83c83b64854270c8a39e7b30cdcd3f09cf3a',
  },
};

/** Minimal assertion helpers — keeps the suite dependency-free. */
export function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}\n  expected: ${String(expected)}\n  actual  : ${String(actual)}`);
  }
}

export function ok(value, label) {
  if (!value) throw new Error(label);
}

export function notOk(value, label) {
  if (value) throw new Error(`${label} (expected falsy, got ${String(value)})`);
}

export function throws(fn, match, label) {
  try {
    fn();
  } catch (e) {
    if (match && !String(e.message).toLowerCase().includes(match.toLowerCase())) {
      throw new Error(`${label}: threw, but message did not contain "${match}"\n  actual: ${e.message}`);
    }
    return e;
  }
  throw new Error(`${label}: expected a throw, none happened`);
}
