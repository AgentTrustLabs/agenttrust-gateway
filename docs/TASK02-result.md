# TASK 02 — First Real CIS-8004 Registration · Result

Date: 2026-11-05 · Network: **Concordium Testnet** (`ccd:4221332d34e1694168c2a0c0b3fd0f27`)
Status: **COMPLETE — VERIFIED**

---

## Registry record (live)

| Field | Value |
|---|---|
| token_id | **1004** |
| token_address (badge) | **JyP9YLib1wYgFmztkcKJL** |
| owner_account | `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` |
| agent_uri | `https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json` |
| metadata_hash | `3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564` |
| agent_wallet | (owner, on-chain metadata key) |
| status | **Active** |
| contract | CIS-8004 @ `12802.0` |

## Transaction trail (3 txs, all finalized)

| # | Action | Tx hash | Block | Energy | Cost (CCD) |
|---|---|---|---|---|---|
| 1 | `CIS-8004.register` | `5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0` | 50388609 | 2380 | 22.010289 |
| 2 | `CIS-8004.setAgentURI` (URI fix) | `c93d702472b46492bdd0c354438cfd8cf4aaf72876cf9137a00fdb18ddf9c64e` | 50390030 | 1859 | 17.180273 |
| 3 | `CIS-8004.setAgentURI` (badge re-anchor) | `cb0c2ef73202f5e435d47322c32d83c83b64854270c8a39e7b30cdcd3f09cf3a` | 50390177 | 1860 | 17.189515 |

Explorer: `https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=<hash>`
Total on-chain cost: **56.380077 CCD**.

Balance reconciliation (exact, to the microCCD):

```
start            20000.000000 CCD
- 22.010289       register
- 17.180273       setAgentURI #1
- 17.189515       setAgentURI #2
= 19943.619923 CCD  == on-chain balance 19943.619923   ✅
```

Account nonce 4 = credential deployment (0) + three updates (1, 2, 3). No transaction outside this table
was sent by the account. Fee note: contract updates are expensive in CCD terms on testnet
(~17–22 CCD each, energy 1.8k–2.4k); testnet CCD is free and the account holds 20 000.

## Independent verification (local-first, not trusting the hosted checker)

```
card file        docs/evidence/task02/agent-card.v2.json
card bytes       2777
local sha256     3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
manifest         3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
on-chain         3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
local===chain    true
local===manifest true
RESULT: VERIFIED
```

Hosted cross-check `GET /v1/check-badge/JyP9YLib1wYgFmztkcKJL` → **`badge_valid: true`**, `issues: []`,
all 15 checks green (`card_fetched`, `hash_matches_on_chain`, `badge_well_formed`,
`token_address_matches`, `extension_conformant`, `verify_url_matches`, …).

## Card contents (A2A v1.0 + ERC-8004)

- A2A fields: `name/description/url/version/defaultInputModes/defaultOutputModes/authentication/skills[]` (3 skills)
- `capabilities.extensions[0].uri` = `https://docs.concordium.com/a2a-extensions/concordium-badge/v1`
- `params.tokenAddress` = `ccd:4221332d34e1694168c2a0c0b3fd0f27/cis-2:JyP9YLib1wYgFmztkcKJL` (CAIP-19)
- `params.owner.account` = CAIP-10 account
- `params.contracts` = `{cis8004: ccd:…:12802.0, cis8: ccd:…:12801.0}`
- `registrations` = `[{"agentId":1004,"agentRegistry":"ccd:4221332d…:12802.0"}]` (ERC-8004 interop)

## Workflow (reusable)

```
scripts/task02-register.mjs        card → register payload → dry-run → signable tx
scripts/build-signing-manifest.mjs round-trip proof → signing-page data
scripts/signing-server.mjs         static host + POST /tx capture
scripts/task02b-repin.mjs          setAgentURI for a new URI (same hash)
scripts/task02c-repin-v2.mjs       post-mint badge rebuild + setAgentURI (new hash)
scripts/task02-verify.mjs          independent on-chain + local-hash verification
```

Signing always via **Concordium Wallet for Web** on a static page; the agent process never sees a private key.

## What did NOT work / had to be corrected

1. **Faucet**: `faucet.testnet.concordium.com` is NXDOMAIN. Working path is the wallet's own REST call
   `PUT https://wallet-proxy.testnet.concordium.com/v0/testnetGTUDrop/{address}` (once per account,
   account must already exist on chain). Docs do not mention it; found in wallet source (`getCcdDrop`).
2. **Account creation cannot be automated**: Concordium accounts derive from an Identity-Provider-issued
   credential. A bare generated ed25519 keypair yields `Account creation is not finalized`. Identity issuance
   (testnet IP, no KYC) is a human step.
3. **`build_agent_card` ignores `token_id`** for `tokenAddress` — it stayed `null` even when passed.
   `build_agent_badge` is the tool that merges the post-mint badge block. This cost one extra on-chain tx.
4. **Wallet API shape** (all found in wallet source / official dApp examples, not docs):
   - type must be the **numeric** `AccountTransactionType.Update` (2); the string `'Update'` throws
     `The provided type does not have a handler`.
   - `receiveName` and `maxContractExecutionEnergy` must be `{ value: … }` objects — `sanitizePayload()` reads `.value`.
   - schema must be `{ type: 'module', value: <b64 module schema> }` and the params passed separately;
     verified to serialize byte-identically to the MCP `parameter_hex`.
5. **MCP param naming**: `verify_agent_card` requires snake_case `token_id` (camelCase silently reports
   "missing token_id"). `search_agents` requires `q`, not `query`.
6. **`sabolabs.dev` does not exist** (RDAP 404, NXDOMAIN) — the original `agent_uri` host was never real.
   Card is now hosted on `api.sabokun.my.id`.

## Artefacts

```
docs/evidence/task02/
  agent-card.json                  v1 (pre-mint, tokenAddress null — superseded)
  agent-card.v2.json               v2 (on-chain anchored)
  agent-card.sha256                v1 hash
  agent-card.sha256.v2             v2 hash
  register-payload.json            MCP register payload
  dry-run.json                     invokeContract proof
  signable-transaction.json        tx template
  registration-manifest.json       sanitized manifest (no keys)
  repin-manifest.json              tx2 manifest
  repin-manifest.v2.json           tx3 manifest
  parameter-schema.bin             CIS-8004 register param schema
```

No seed phrase, private key, or credential appears in any artefact.
