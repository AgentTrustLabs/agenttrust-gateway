# Concordium Integration Lessons

Findings from **TASK 02** (first real CIS-8004 registration on Concordium Testnet), consolidated so
they are never re-learned at the cost of another on-chain transaction.

Project: `agenttrust` · Network: testnet (`ccd:4221332d34e1694168c2a0c0b3fd0f27`) · Contract: CIS-8004 `12802.0`

---

## Evidence vocabulary used in this document

| Label | Meaning |
|---|---|
| **VERIFIED — live** | Executed against Concordium testnet during TASK 02; the tx hash / HTTP response is recorded in `docs/evidence/task02/`. |
| **VERIFIED — source** | Not executed, but read directly from the official implementation (Concordium GitHub). Code is the contract. |
| **UNDOCUMENTED** | Works, is relied on, but appears in **no** official documentation. **Not a stability promise.** Treat as "observed behaviour of the current build". |
| **DOCUMENTED** | Present in `docs.concordium.com`. Safe to depend on. |

Nothing in this document is a claim that an undocumented API is supported, stable, or will survive an
upgrade. Where an undocumented behaviour is load-bearing, the mitigation is stated explicitly.

---

## 1. Undocumented testnet faucet endpoint

**Label: VERIFIED — live · UNDOCUMENTED**

```
PUT https://wallet-proxy.testnet.concordium.com/v0/testnetGTUDrop/{accountAddress}
→ 200 {"submissionId":"<64 hex>"}
```

### Evidence

| Item | Value |
|---|---|
| Account | `4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d` |
| submissionId | `eb21350f799e8ea41565033c55ea1cfdce89be2ac149e3bd571676bdd2a80ea4` |
| Before | `0` CCD (account existed, no funds) |
| After | `20 000` CCD (`getAccountInfo` via gRPC) |
| Repeat claim | idempotent — returns the same `submissionId`, mints nothing |

### Why it was needed

`faucet.testnet.concordium.com`, `faucet.concordium.com` and `testnet-faucet.concordium.com` are all
**NXDOMAIN** (confirmed via DNS-over-HTTPS). The documented path is the UI: Wallet for Web → account →
Activity → **Request CCD**. There is no documented programmatic faucet.

The endpoint was found in the official wallet source, `concordium-browser-wallet`:
`packages/browser-wallet/src/popup/shared/utils/wallet-proxy.ts`

```ts
export async function getCcdDrop(accountAddress: string): Promise<BrowserWalletAccountTransaction> {
    const response = await (await getWalletProxy()).put(`/v0/testnetGTUDrop/${accountAddress}`);
    ...
    CcdAmount.fromCcd(20000).microCcdAmount,
```

`20000 CCD` matches the amount returned live.

### Constraints (all observed, not assumed)

- **One claim per account**, and only for an account that has never received funds.
- The account must **already exist on chain** (see §2). An address alone is rejected.
- `v0` in the path — not `v1`. A `v1` probe 404s.
- Method is `PUT`. `GET`/`POST` on the same path 404.

### Stability position

**This is NOT a supported API.** It is an internal wallet-proxy route. It can be removed or moved to a
versioned path without notice.

Mitigation: it is used only for **testnet account bootstrap**, never in a product path. If it disappears,
the fallback is the documented UI flow (Wallet for Web → Request CCD), which costs one manual click.
Production/mainnet is unaffected — there is no faucet there by design.

Regression: `test/finding-1-faucet.test.mjs`

---

## 2. Account creation requires an Identity Provider credential

**Label: VERIFIED — live · DOCUMENTED (identity framework) · UNDOCUMENTED (the failure signature)**

A Concordium account **cannot** be created from a raw keypair. The account address is derived from a
*credential registration id*, which only exists after:

1. an Identity Provider issues an identity object (with 1–3 anonymity revokers), and
2. a credential deployment transaction is signed and submitted.

### The negative result, recorded

A freshly generated ed25519 keypair was turned into a structurally correct address:

```
address        4SjjGXAx3kt74spfwnZHHxscwFEomVnyuaVpULn37xRPuENXqB
length         50 (correct)
version byte   1 (correct)
checksum       valid double-SHA-256[:4] over the 32-byte payload
faucet         PUT /v0/testnetGTUDrop/<address>
response       HTTP 400 {"error":1,"errorMessage":"Account creation is not finalized"}
```

Address encoding (`test/finding-2-account-derivation.test.mjs`):

```
payload  = 0x01 ‖ publicKey[32]
checksum = SHA-256(SHA-256(payload))[0..4]
address  = base58( payload ‖ checksum )     → always 50 characters
```

Structurally valid ≠ usable. The chain has no credential for that address, so it is not an account.

### Testnet identity is free — no KYC

From official docs (`source/shared/setup-env.rst`):

> You don't have to provide an ID to create an identity on testnet when selecting **Concordium testnet IP**.
> Test identities are meant for testnet testing only.

Live testnet IDP registry (`GET https://wallet-proxy.testnet.concordium.com/v2/ip_info`):

| ipIdentity | Name | Anonymity revokers |
|---|---|---|
| 0 | Concordium testnet IP | 1, 2, 3 |
| 3 | Digital Trust Solutions TestNet | 1, 2, 3 |
| 4 | Global FinReg Testnet | 1, 2, 3 |
| 5 | Dataspike | 1, 2, 3 |

There is **no public issuance API**. Identity creation is a human step in the wallet UI (2 minutes,
auto-approved on testnet). Automation stops here by design — correctly, since the credential is the
user's identity material.

### Consequence for architecture

Any onboarding flow must treat "owner has a funded account" as an **external precondition**, not
something the system provisions. The gateway takes an account address as input; it never mints identities.

Regression: `test/finding-2-account-derivation.test.mjs`

---

## 3. Post-registration token identity in the Agent Card

**Label: VERIFIED — live · the "build_agent_card cannot do this alone" part is UNDOCUMENTED behaviour**

### What actually happens

`build_agent_card` **does** populate token identity when `token_id` is supplied — but only if the field
is actually forwarded. The original failure was ours: the typed wrapper `AgentRegistryMcp.buildAgentCard()`
accepted `{name, description, agentUri, ownerAccount, skills}` and had **no `tokenId` parameter**, so
`token_id` was never sent and the tool correctly produced a pre-mint card.

```
pre-mint card  : params.tokenAddress = null ,  no `registrations` entry   → badge_valid false
post-mint card : params.tokenAddress = "ccd:4221…/cis-2:JyP9YLib1wYgFmztkcKJL"
                 registrations = [{ agentId: 1004, agentRegistry: "ccd:4221…:12802.0" }]
```

### What the badge checker requires

`GET /v1/check-badge/JyP9YLib1wYgFmztkcKJL` reported, for the pre-mint card:

```
badge_well_formed      false
token_address_matches  false
issues: "badge is missing required field `tokenAddress`"
```

`tokenAddress` is **mandatory**; a null token identity fails validation regardless of hash correctness.

### The two tools, and when to use each

| Tool | Use | Notes |
|---|---|---|
| `build_agent_card` | new agent, pre- or post-mint | Produces a complete A2A v1.0 + ERC-8004 card. Pass `token_id` once known. |
| `build_agent_badge` | existing card, badge missing or stale | Merges/upgrades the badge block without disturbing other fields. Accepts `card_json` or `card_url`. |

Both converge on **byte-identical** output for the same inputs — verified:
the `build_agent_badge` result and the `build_agent_card(token_id=1004)` result are the same 2777 bytes,
hash `3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564`.

### Cost of getting this wrong

A pre-mint card must be re-anchored on chain when it changes, because `metadata_hash` is over exact bytes.
In TASK 02 that was **one extra on-chain transaction** (`cb0c2ef7…`, 1860 energy, 17.19 CCD) beyond the
URI fix. Testnet CCD is free, but on mainnet that mistake is paid in real money. Order of operations that avoids it:

1. build card **with** `token_id` (impossible pre-mint — so:)
2. register → obtain `token_id`
3. build the final card **with** `token_id`
4. host it
5. `setAgentURI` **once**, pinning the final hash

Never publish a card you intend to replace before the id is known.

### Where the fix lives

`src/registry/mcpClient.ts` — `buildAgentCard()` now accepts and forwards `tokenId` / `agentWallet`.
Regression `test/finding-3-agent-card.test.mjs` asserts the forwarding, and pins the fixture against the
on-chain anchored bytes so any drift is caught offline.

Regression: `test/finding-3-agent-card.test.mjs`

---

## 4. Concordium Wallet API serialization requirements

**Label: VERIFIED — live failure + VERIFIED — source (`concordium-browser-wallet`)**

Three shapes are required. Two of them fail loudly; one fails silently. All three cost a debugging cycle
in TASK 02.

### 3.1 Transaction type must be the **numeric** enum

```js
wallet.sendTransaction(account, 2, payload, params, schema)   // ✅
wallet.sendTransaction(account, 'Update', payload, …)         // ❌
```

Live error with the string:

```
The provided type does not have a handler: Update
```

Source: `wallet-api.ts` → `getAccountTransactionHandler(type)`. The helper types declare
`LaxNumberEnumValue<AccountTransactionType>` / `LaxStringEnumValue`; only the numeric path resolves to a
handler in the current build. `AccountTransactionType.Update === 2`, `InitContract === 1`,
`Transfer === 3`.

### 3.2 `receiveName` and `maxContractExecutionEnergy` must be `{ value }` objects

```js
payload = {
  amount: { microCcdAmount: 0n },
  address: { index: 12802n, subindex: 0n },
  receiveName: { value: 'CIS-8004.setAgentURI' },
  maxContractExecutionEnergy: { value: 30000n },
}
```

Live error when an object-typed field is missing:

```
Cannot read properties of undefined (reading 'value')
```

Source: `wallet-api/compatibility.ts` → `sanitizePayload()`:

```ts
const maxContractExecutionEnergy =
    typeof p.maxContractExecutionEnergy !== 'bigint'
        ? Energy.create(p.maxContractExecutionEnergy.value)   // ← throws if absent
        : Energy.create(p.maxContractExecutionEnergy);
const receiveName =
    typeof p.receiveName === 'string'
        ? ReceiveName.fromString(p.receiveName)
        : ReceiveName.fromString(p.receiveName.value);        // ← throws if absent
```

| Field | Accepted forms |
|---|---|
| `maxContractExecutionEnergy` | raw `bigint` **or** `{ value: bigint }` or `{ value: number }` |
| `receiveName` | plain `string` **or** `{ value: string }` |

**Hazard:** a flat *number* for energy does not throw — it silently evaluates to `undefined`. Only a
missing field throws. Never pass a bare number.

### 3.3 Schema must be `{ type: 'module', value: <base64 module schema> }`

```js
const schema = { type: 'module', value: moduleSchemaBase64 };
```

Two schema branches exist in the wallet:

| `schema.type` | Wallet does | Use for |
|---|---|---|
| `'module'` | `serializeUpdateContractParameters(...)` with the **module** schema | full module schema available |
| `'parameter'` | `serializeTypeValue(...)` with a **parameter-only** schema | parameter schema only |

Both were tested against our payload; both produce byte-identical output **when given the matching
schema**. `'module'` + module schema is what the live registration used.

The wallet **overwrites** `payload.message` from the separate `parameters` argument, so that what the
user sees is what gets signed. Passing a pre-serialized message inside the payload is pointless — it is
discarded.

### 3.4 `schemaVersion` may be omitted

The sixth argument was omitted on the live registration. Embedded module schemas self-describe their
version. Supplying `0` or `1` explicitly also worked in local round-trip tests.

### 3.5 The exact call

```js
const txHash = await window.concordium.sendTransaction(
  account,                                   // base58 string or AccountAddress
  2,                                         // AccountTransactionType.Update
  payload,                                   // { amount, address, receiveName:{value}, maxContractExecutionEnergy:{value} }
  parameterJson,                             // contract params as plain JSON
  { type: 'module', value: moduleSchemaB64 },// module schema
);
```

Regression: `test/finding-4-wallet-serialization.test.mjs`

---

## 5. Byte-level guarantees (the reason TASK 02 stayed verifiable)

Everything above is only useful if the bytes survive the journey. Two invariants are asserted offline:

**Invariant A — parameter bytes.** The JSON params the wallet serializes must equal the `parameter_hex`
the registry MCP produced, which is what was dry-run against the contract.

```
serializeTypeValue(parameter_json, getUpdateContractParameterSchema(moduleSchema, "CIS-8004", "register"))
  === parameter_hex            ✅ asserted for register and setAgentURI
```

**Invariant B — card hash.** The bytes served at `agent_uri` must hash to the on-chain `metadata_hash`.

```
sha256(agent-card.v2.json) = 3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
on-chain metadata_hash     = 3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564   ✅
```

Consequence: **any** re-serialization of the card (pretty-printing, JSON minification, key reordering,
CDN transformation) changes the hash and breaks the anchor. Publish immutable bytes; re-pin on change.

Regression: `test/regression-bytes.test.mjs`

---

## 6. Version matrix (as exercised)

| Component | Version | How used |
|---|---|---|
| `@concordium/web-sdk` | 12.0.2 | tx build, `invokeContract` dry-run, schema serialization, `getBlockItemStatus` |
| `@concordium/rust-bindings` | 4.0.1 | transitive — WASM schema serializer |
| `@concordium/browser-wallet-api-helpers` | 3.3.0 | types only (not in the app bundle; the page uses `window.concordium` directly) |
| concordium-browser-wallet | `main` @ `75e37c6c3f10` (2026-06-15) | source of truth for §1 and §4 |
| concordium-dapp-examples | `main` @ `2ea79d96cf4f` (2026-10-30) | payload shape reference (`piggybank/src/utils.ts`) |
| Agent Registry MCP | 0.1.0 (`/healthz`) | card build, parameter build, badge check |
| Node.js | 26.7.0 | runtime for scripts/tests |
| Concordium node (testnet) | gRPC v2 @ `grpc.testnet.concordium.com:20000` | chain access |

### Two SDK quirks worth recording

1. **`@concordium/node-sdk@9.5.3` does not load on Node 26** — its published tarball is missing
   `lib/util.js` (`Cannot find module './util'`). Only `@concordium/web-sdk` is used; `node-sdk` was
   removed from `package.json`.
2. **`ConcordiumGRPCClient` takes an `RpcTransport`, not a URL** in 12.0.2. Passing a URL string produces
   `this._transport.mergeOptions is not a function`. Use `new ConcordiumGRPCWebClient('https://host', 20000, {})`,
   and note the host needs its scheme for that constructor.
3. **`client.getTransactionStatus()` no longer exists** — use `getBlockItemStatus(TransactionHash)` or
   `waitForTransactionFinalization(...)`.
4. **`Transaction.updateContract(payload, energy)`** requires the full payload object
   (`{amount, address, receiveName, message}`); the contract address alone is not enough.
5. **MCP parameter naming**: `verify_agent_card` needs snake_case `token_id` (camelCase is silently
   reported as "missing token_id"); `search_agents` needs `q`, not `query`.

---

## 7. Direct references to TASK 02 evidence

| Artefact | Path | Shows |
|---|---|---|
| Result report | `docs/TASK02-result.md` | full trail: 3 finalized txs, block hashes, costs |
| Registration manifest | `docs/evidence/task02/registration-manifest.json` | sanitized register inputs/outputs |
| Register payload | `docs/evidence/task02/register-payload.json` | MCP `parameter_hex` + `parameter_json` |
| Dry run | `docs/evidence/task02/dry-run.json` | `invokeContract` accepted the payload |
| Card v1 (pre-mint) | `docs/evidence/task02/agent-card.json` | `tokenAddress: null` — the failure mode |
| Card v2 (anchored) | `docs/evidence/task02/agent-card.v2.json` | matches on-chain hash, 2777 bytes |
| Re-pin manifests | `docs/evidence/task02/repin-manifest{,.v2}.json` | both `setAgentURI` payloads |
| Module schema | `test/fixtures/cis8004-module-schema.bin` | 11 208 bytes, `sha256 9f8b59ab…` |
| MCP fixtures | `test/fixtures/mcp-build-agent-*.json` | captured tool responses |

Live chain facts: token **1004**, `JyP9YLib1wYgFmztkcKJL`, owner `4dWn8miA…Zg4d`, status **Active**,
`badge_valid: true`, `issues: []`.

---

## 8. What is still NOT proven

- `v1` `testnetGTUDrop` path, or any parameterised variant of the faucet.
- Whether the faucet endpoint exists on **mainnet** — it must not be assumed to (mainnet has no faucet).
- Whether `build_agent_card`'s `tokenAddress` behaviour is stable across MCP releases.
- Wallet behaviour for `schema.type: 'parameter'` in a **browser** context (tested only offline).
- Multi-credential accounts, operator/`updateOperator` flows, and `setAgentWallet` proof-of-control.
- Any behaviour on non-testnet networks.

These are open, not silently assumed.

---

## 9. Rules distilled

1. **Never generate an account from a key.** Take an address as input; identity issuance is human.
2. **Never publish a card before `token_id` is known** — you will pay for a second anchor transaction.
3. **Pass `token_id` explicitly** to `build_agent_card`; if you only have a card already, use
   `build_agent_badge`.
4. **Wallet call**: numeric type, `{value}` wrappers, `{type:'module'}`, params as a separate argument.
5. **Prove byte-equality before every signature** — parameter hex vs MCP, card hash vs on-chain.
6. **Label every undocumented behaviour as such**, and keep a documented fallback.
7. **Dry-run every contract call** (`invokeContract`) before asking a human to sign.
