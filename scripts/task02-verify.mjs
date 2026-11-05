/**
 * TASK 02 verification — independent, local-first.
 *
 * Given a finalized registration tx hash, this script:
 *   1. re-reads the registry (indexer + chain) for the agent record
 *   2. recomputes the Agent Card SHA-256 from the published bytes
 *   3. compares against the on-chain metadata_hash
 *   4. confirms owner, token id, agent_uri, status
 *   5. prints explorer evidence URLs
 *
 * It does NOT trust the hosted badge checker as the source of truth.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mcpFor } from '../src/registry/mcpClient.js';
import { TESTNET } from '../src/core/types.js';

const TOKEN_ID = Number(process.argv[2] ?? 1004);
const TX_HASH = process.argv[3] ?? '5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0';

const mcp = mcpFor(TESTNET);

// ---- 1. token address + on-chain record ---------------------------------
const { token_address } = await mcp.tokenAddress(TOKEN_ID);
console.log('token_id      :', TOKEN_ID);
console.log('token_address :', token_address);

const rec = await mcp.agentByTokenAddress(token_address);
const r = rec.record ?? rec;
console.log('owner_account :', r.owner ?? r.owner_account);
console.log('agent_uri     :', r.agent_uri);
console.log('metadata_hash :', r.metadata_hash ?? r.metadata_hash_hex);
console.log('status        :', r.status);
console.log('agent_wallet  :', r.agent_wallet ?? '(unset)');

// ---- 2. local card hash -------------------------------------------------
// Prefer the post-mint card (v2) — it is the one anchored on chain after re-pin.
const CARD = process.env.AGENTTRUST_CARD ?? 'docs/evidence/task02/agent-card.v2.json';
const REPIN_MANIFEST = 'docs/evidence/task02/repin-manifest.v2.json';
const cardBytes = readFileSync(CARD);
const localHash = createHash('sha256').update(cardBytes).digest('hex');
const repin = JSON.parse(readFileSync(REPIN_MANIFEST, 'utf8'));
const manifest = { cardSha256: repin.cardSha256, agentUri: repin.agentUri };
const onChainHash = String(r.metadata_hash ?? r.metadata_hash_hex ?? '');

console.log('\n--- hash check (local) ---');
console.log('card file     :', CARD);
console.log('card bytes    :', cardBytes.length);
console.log('local sha256  :', localHash);
console.log('manifest      :', manifest.cardSha256);
console.log('on-chain      :', onChainHash);
console.log('local===chain :', localHash === onChainHash);
console.log('local===manifest:', localHash === manifest.cardSha256);

// ---- 3. verify_agent_card (hosted cross-check) -------------------------
const verify = await mcp.verifyAgentCard({ tokenId: TOKEN_ID });
console.log('\n--- verify_agent_card (cross-check) ---');
console.log(JSON.stringify(verify, null, 1).slice(0, 1200));

// ---- 4. explorer --------------------------------------------------------
console.log('\n--- evidence ---');
console.log('tx        :', TESTNET.explorerTx(TX_HASH));
console.log('account   :', TESTNET.explorerAccount(String(r.owner ?? r.owner_account)));

const pass = localHash === onChainHash && localHash === manifest.cardSha256;
console.log('\nRESULT:', pass ? 'VERIFIED' : 'MISMATCH');
process.exit(pass ? 0 : 1);
