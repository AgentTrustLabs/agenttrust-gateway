# TASK 04 — x402 Exact Payment Integration (Concordium Testnet)

Date: 2026-11-05 · Network scope: **Concordium Testnet** (`ccd:4221332d34e1694168c2a0c0b3fd0f27`) · Asset: **CCD only**

**No settlement was executed. No transaction was created. No key was used.**

---

## Phase 1 — SDK and protocol inspection

### Installed, not assumed

Inspected from the project's own `node_modules`, not from documentation:

| Package | Version | Role |
|---|---|---|
| `@x402/concordium` | **2.29.0** | Concordium mechanism (client / server / facilitator) |
| `@x402/core` | **2.29.0** | protocol types, `x402Version = 2` |
| `@concordium/web-sdk` | 12.0.2 | transaction primitives (transitive dep of the x402 package) |
| Node.js | 26.7.0 | runtime |

`@x402/concordium` declares `"@concordium/web-sdk": "^12.0.0"` and `"@x402/core": "~2.29.0"` — the installed
graph is consistent, no duplicate core.

### Exports actually present

Package entrypoints: `.`, `./exact/client`, `./exact/server`, `./exact/facilitator`.

Root exports confirmed by import (not by reading a README):

```
ExactConcordiumScheme (client)   ClientConcordiumSigner      ExactConcordiumPayloadV2
FacilitatorConcordiumSigner      SignableV1Transaction       toConcordiumFacilitatorSigner
CONCORDIUM_MAINNET_CAIP2         CONCORDIUM_TESTNET_CAIP2    CONCORDIUM_WILDCARD_CAIP2
CCD_ASSET_IDENTIFIER = "CCD"     CCD_DECIMALS = 6            CONCORDIUM_ADDRESS_REGEX
MAX_EXPIRY_OFFSET_SECONDS = 600  DEFAULT_FINALIZATION_TIMEOUT_MS = 60000
getConcordiumGrpcUrl             getExplorerTxUrl            parseGrpcUrl
```

### Protocol surface confirmed at runtime

```
x402Version                    2
scheme                         exact
defaultAssetTransferMethod     default
paymentFlows.default           supported: ["authorization","upfront"], default "authorization"
mechanism (Concordium)         V1 sponsored transaction — client signs as sender,
                               facilitator adds sponsor signature, submits, waits for finalization
facilitator verification rules 9
maxExpiryOffsetSeconds         600
```

Interfaces read from the shipped `.d.mts` files, and reproduced from that shape:

```
PaymentRequirements  { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra }
PaymentRequired      { x402Version, error?, resource{url,description?,mimeType?}, accepts[], extensions? }
PaymentPayload       { x402Version, resource?, accepted, payload, extensions? }
VerifyResponse       { isValid, invalidReason?, invalidMessage?, payer? }
SettleResponse       { success, errorReason?, errorMessage?, payer?, transaction, network, amount? }
SchemeNetworkServer  parsePrice, enhancePaymentRequirements, getAssetDecimals, registerMoneyParser
SchemeNetworkClient  createPaymentPayload(x402Version, requirements)
FacilitatorClient    verify, settle, getSupported
```

`CCD` is not a token contract: `asset: "CCD"`, `amount` in microCCD, 6 decimals.

### Differences vs TASK 01

| TASK 01 said | Current package shows |
|---|---|
| version 2.29.0 | ✅ unchanged, 2.29.0 installed |
| payload `{signedTransaction, sender}` (from README) | the shipped type `ExactConcordiumPayloadV2` is `{ signedTransaction }` **only** — the README example is stale relative to the `.d.mts` |
| "client never broadcasts" | ✅ confirmed: client emits a partially-signed tx; facilitator sponsors and submits |
| facilitator pays gas | ✅ confirmed, and the sponsor address arrives via `/supported` → `enhancePaymentRequirements()` → `extra.feePayer` |

Three behaviours **not** captured by TASK 01, found by execution:

1. **`parsePrice` will not guess CCD.** A money price (`"$0.01"`, `"10"`) resolves to USDR or throws — CCD is
   never a silent fallback. An explicit `AssetAmount` is required, which is what this module always builds.
2. **`hasRegisteredScheme(network, scheme)`** takes **network first** — the opposite of the reading order of
   its name. Reading it the other way silently returns `false`.
3. **`CONCORDIUM_ADDRESS_REGEX` is `{45,55}`**, wider than the chain accepts. `AccountAddress.fromBase58`
   in web-sdk rejects anything that is not exactly 50 characters. This module matches the **chain**, not the
   SDK's permissive shape check.

Nothing was invented: every method above was called during this task, and the calls are captured in
`docs/evidence/task04/08-sdk-crosscheck.json`.

---

## Phase 2 — Gateway integration

New module set, isolated from identity and discovery:

```
src/payments/x402.ts       dependency-free protocol core (build / preflight / verify / settle / receipt)
src/payments/x402Sdk.ts    bridge to the official SDK: constants, price parse, resource server, explorer
```

`src/payments/*` imports nothing from `src/registry`, `src/verify` or `src/identity`. Payment correctness is
therefore testable with no agent, no card, and no registry.

### Required behaviour, all implemented

1. **Declare an exact CCD requirement** — `buildPaymentRequirements({ payTo, amountMicroCcd, … })`
   → `{ scheme:'exact', network, asset:'CCD', amount, payTo, maxTimeoutSeconds, extra }`.
   Validates: address shape (exactly 50 base58 chars), integer microCCD > 0, positive timeout,
   `feePayer` placed in `extra` (never top level — that field does not exist in the schema).
2. **402 response** — `buildPaymentRequired(...)` → `{ x402Version:2, error, resource, accepts:[…] }`,
   matching `PaymentRequired` field-for-field (asserted by a test that rejects unknown top-level keys).
3. **Client payload construction** — the official client path is
   `new ExactConcordiumScheme(signer).createPaymentPayload(2, requirements)`; it needs an
   `{accountAddress, signer}` pair. This module does **not** construct that signer and never holds a key.
   Instead it accepts the resulting `PaymentPayload` and validates it locally.
   Evidence fixture `04-payment-payload.fixture.json` is a **structural** payload with a placeholder
   signature, explicitly not settleable.
4. **Verify through the facilitator** — `authorizePayment({facilitator, …})` calls `facilitator.verify()`
   after local preflight. The facilitator is an injected `ConsumerFacilitator`.
5. **Settle through the official interface** — same entry point with `settle: true` calls
   `facilitator.settle()`; that is the *only* place settlement is invoked, and it is **off by default**.
6. **Structured receipt** — `{ success, transaction, network, payer?, amount, asset, payTo, settledAt,
   explorerUrl?, audit? }`. `audit` is where agent identity may be attached; it is optional and never
   consulted for protocol correctness.
7. **Failure never grants access** — preflight mismatch, invalid verify, verify throw, settle throw,
   settle failure, and settle-without-transaction all return `granted: false` with `receipt: null`.

### Expiry (spec rule 7)

`preflightPaymentPayload(payload, requirements, nowSeconds?)` checks the Concordium V1 transaction expiry
locally, before any facilitator call:

- expiry in the past (or exactly now) → rejected, `payment expired at …`
- expiry more than `MAX_EXPIRY_OFFSET_SECONDS` (600) ahead → rejected, rule 7
- expiry exactly at the ceiling → accepted (inclusive)
- no expiry claim in the payload → deferred to the facilitator
- non-numeric expiry → rejected

The clock is injectable (`nowSeconds`), so expiry tests are deterministic and never wait for real time.
`MAX_EXPIRY_OFFSET_SECONDS = 600` mirrors the SDK constant of the same name.

### Access gate semantics

| Situation | granted | reason |
|---|---|---|
| verified + settled + tx hash | ✅ true | `settled` |
| verified, `settle` not requested | ❌ false | `verified only — settlement not requested` |
| preflight mismatch | ❌ false | `preflight: …` (facilitator never called) |
| verify invalid | ❌ false | `verify rejected: …` |
| verify threw | ❌ false | `verify threw: …` |
| settle failed | ❌ false | `settle failed: …` |
| settle threw | ❌ false | `settle threw: …` |
| settle "success" with no tx hash | ❌ false | `settle reported success but returned no transaction hash` |
| no facilitator configured | ❌ false | `no facilitator configured: refusing to verify` |

Verification alone never grants access — a verified but unsettled payment is not a payment.

### Receipt structure

```ts
interface PaymentReceipt {
  success: boolean;        // always true — a failed settlement yields receipt: null
  transaction: string;     // on-chain tx hash from the facilitator
  network: string;         // CAIP-2
  payer?: string;          // base58 account, when the facilitator reports it
  amount: string;          // atomic units (microCCD), copied from the requirements
  asset: string;           // "CCD"
  payTo: string;           // base58 recipient, copied from the requirements
  settledAt: string;       // ISO-8601, set when the receipt is built
  explorerUrl?: string;    // ccdexplorer.io link; omitted for unknown networks
  errorReason?: string;    // reserved; failures return receipt: null instead
  errorMessage?: string;
  audit?: Record<string, unknown>;  // e.g. { agentId: 1004, tokenAddress, purpose }
}
```

`audit` is the only place agent identity may be attached, and it is never consulted for protocol
correctness — a payment receipt is valid with no agent identity at all.

### Facilitator requirements and configuration

| Requirement | Why |
|---|---|
| `verify(payload, requirements)` → `VerifyResponse` | signature, amount, sponsor and expiry are enforced by the facilitator (9 rules) |
| `settle(payload, requirements)` → `SettleResponse` | adds the sponsor signature, submits, waits for finalization |
| `getSupported()` → `{kinds, extensions?, signers?}` | the server copies the sponsor address into `extra.feePayer` |
| must advertise `exact` on `ccd:4221332d34e1694168c2a0c0b3fd0f27` | wrong network → no compatible payment option |
| a **funded sponsor account** | the facilitator pays the transaction fee |

Configuration surface: `createHttpFacilitator({ url, timeoutMs?, headers? })`. The URL is mandatory —
there is no default, no environment fallback, and no hosted endpoint is assumed to exist. No facilitator
credentials are stored anywhere in this repository.

---

## Phase 3 — Settlement safety gate

Implemented, **not executed**.

Safety properties, each enforced in code and asserted by test:

- **`settle` defaults to `false`.** Opting in requires `settle: true` explicitly.
- **`DENY_ALL_FACILITATOR`** is the only facilitator the module ships. It throws on `verify` and `settle`.
  There is no default endpoint and no implicit `HTTPFacilitatorClient` construction.
- **`createHttpFacilitator({url})` throws without a URL** — no environment fallback, no hardcoded host.
- **No key material anywhere.** The module accepts no signer, no seed, no private key. A test greps
  `src/payments/*` for `privateKey|seedPhrase|mnemonic = <hex>` and for hardcoded facilitator hosts.
- **No wallet creation, no credential issuance, no automatic signing.**
- **No network call in any code path exercised by this task.** The only `fetch` in the module set is inside
  `createHttpFacilitator`, which is never constructed.

A future live settlement requires, at minimum, all of:

```
explicit user authorization
  recipient  = <base58 account>        (must match requirements.payTo)
  amount     = <microCCD>              (must match requirements.amount)
  asset      = CCD
  network    = ccd:4221332d34e1694168c2a0c0b3fd0f27   (testnet)
  facilitator = <explicit URL>         (no default)
  maxTimeoutSeconds ≤ 600
```

---

## Phase 4 — Tests

| Suite | Tests | Scope |
|---|---|---|
| `test/task04-x402-exact.test.mts` | **44** | requirement construction, 402 shape, preflight, expiry (rule 7), verify/settle gating, receipts, conversions, and every required negative path |
| `test/task04-sdk-conformance.test.mts` | **15** | agreement with the installed SDK: version, CAIP-2, asset, decimals, price parsing, scheme registration, explorer helper, 402 key set, no hardcoded endpoints |

Deterministic and offline. The facilitator is a mock in every test; no socket is opened.

### Required case coverage (each is a named test)

| Required case | Test |
|---|---|
| Valid requirement construction | `builds a valid exact CCD requirement` + 5 rejection tests |
| Correct 402 response | `402 body matches the PaymentRequired schema`, `…has exactly the v2 top-level keys` |
| Valid payment payload | `accepts a well-formed payload`, `accepts a payload whose expiry is inside the window` |
| Facilitator verification success | `valid verify + successful settle grants access and returns a receipt` |
| Facilitator verification rejection | `invalid verify denies access without settling` |
| Settlement success (mock) | same as above — mock returns `success:true, transaction:<hash>` |
| Settlement failure (mock) | `settle failure denies access`, `settle claiming success without a transaction denies access` |
| **Expired payment** | `rejects an expired payment`, `rejects an expiry exactly at now`, `expired payment is denied and never reaches the facilitator` |
| **Wrong network** | `wrong network is rejected before any facilitator call` |
| **Wrong asset** | `wrong asset is rejected before any facilitator call` |
| **Insufficient amount** | `insufficient amount is rejected before any facilitator call` (1 / 249999 / 0) |
| **Malformed payment payload** | `malformed payloads are rejected without touching the facilitator` (null, undefined, string, number, array, missing `accepted`, empty `accepted`) |
| **Access denied when verification fails** | `invalid verify denies access without settling`, `verify throwing denies access` |
| **Access granted only after successful settlement** | `access is granted only after successful settlement, never before` (3-stage) |
| **Failed verification never reaches settlement** | `failed verification never reaches settlement` — asserts `settle` absent from the facilitator call log for both `invalid` and `throw` |
| **No real network transaction emitted** | `the whole gate runs with global fetch poisoned` — `globalThis.fetch` is replaced with a thrower for the duration; the full verify+settle gate still completes on the mock and `attempted` stays `false` |

Supporting assertions: overpayment is a mismatch (exact scheme is exact); expiry at the ceiling is
inclusive; expiry above the ceiling is rejected with a rule-7 reason; a payload with no expiry claim is
deferred to the facilitator; non-numeric expiry is rejected.

Also asserted: every preflight failure leaves the facilitator **uncontacted** (`fac.calls.length === 0`),
so no denial path performs a network call even in principle.

Conformance: `assertSdkAcceptsRequirements` proves `@x402/concordium`'s own `parsePrice` returns our asset
and amount unchanged; `buildResourceServer` proves the exact scheme registers on the testnet CAIP-2;
`assertConstantsAgree` throws on any drift; a source scan forbids hardcoded facilitator hosts and key
literals in `src/payments/*`.

---

## NOT TESTED

1. **Live facilitator.** No facilitator endpoint was contacted, so `/supported`, `/verify` and `/settle`
   have not been exercised against a real service. The adapter exists (`createHttpFacilitator`) but is
   unverified against a deployment.
2. **Real payment payload from the official client.** `createPaymentPayload` requires an
   `{accountAddress, signer}` pair; producing one means handling a key, which this task forbids. The
   fixture is structural only, and its signature is a placeholder that a real facilitator would reject at
   rule 8.
3. **End-to-end settle → explorer confirmation.** Excluded by the no-settlement constraint.
4. **PLT path.** Out of scope (CCD only). The SDK supports PLT with chain-fetched decimals; untested here.
5. **`x402ResourceServer` HTTP integration.** The official `x402HTTPResourceServer` route/middleware layer
   was not wired or tested; only the scheme registration was verified.

## BLOCKED

**Settlement execution is blocked by design, not by a technical fault.** Three independent reasons:

1. This task forbids a live settlement call and any transfer of CCD.
2. A real settlement requires a **facilitator with a funded sponsor account** — no public Concordium testnet
   x402 facilitator is known or configured. `facilitator.concordium.com` and
   `x402-facilitator.concordium.com` do not resolve.
3. The client side of a real payload requires a signing key. Under this task's constraints that key must be
   supplied by the operator in a later, explicitly authorized task.

Nothing else was blocked: the SDK, protocol and all interfaces were fully inspectable offline.

---

## FILES CHANGED

**New**
- `src/payments/x402.ts` — protocol core: requirements, 402 body, preflight, verify/settle gate, receipt,
  amount conversion, `DENY_ALL_FACILITATOR`
- `src/payments/x402Sdk.ts` — official-SDK bridge: constants, price-parse assertion, resource server,
  `createHttpFacilitator`, explorer helper
- `src/payments/SETTLEMENT-SAFETY.md` — the preconditions a future live settlement must satisfy
- `test/task04-x402-exact.test.mts` — 27 tests
- `test/task04-sdk-conformance.test.mts` — 15 tests
- `scripts/task04-conformance.mts` — live-free conformance printout
- `scripts/task04-evidence.mts` — deterministic evidence generator
- `docs/evidence/task04/` — 8 artefacts (SDK inspection, requirements, 402, fixture payload, preflight,
  mock settlement, denial paths, SDK cross-check)
- `docs/TASK04-result.md` — this report

**Modified**
- none outside `src/payments`, `test`, `scripts`, `docs`

**Untouched:** registry, verification, identity, registration scripts, signing site, all prior evidence,
and every prior test suite (all still green).

---

## TEST RESULTS

Recorded from the run in `/home/ubuntu/projects/agenttrust`:

```
$ npm test
PASS  finding-1-faucet.test.mjs                      finding-1-faucet: 6/6 passed
PASS  finding-2-account-derivation.test.mjs          finding-2-account-derivation: 7/7 passed
PASS  finding-3-agent-card.test.mjs                  finding-3-agent-card: 11/11 passed
PASS  finding-4-wallet-serialization.test.mjs        finding-4-wallet-serialization: 10/10 passed
PASS  regression-bytes.test.mjs                      regression-bytes: 9/9 passed
PASS  task03-cli-contract.test.mts                   task03-cli-contract: 11/11 passed
PASS  task03-discovery-and-trust.test.mts            task03-discovery-and-trust: 47/47 passed
PASS  task04-sdk-conformance.test.mts                task04-sdk-conformance: 15/15 passed
PASS  task04-x402-exact.test.mts                     task04-x402-exact: 44/44 passed
────────────────────────────────────────────────────────────────
all suites passed
exit=0
```

```
$ npx tsc --noEmit
exit=0
```

```
$ npx tsx scripts/task02-verify.mjs 1004 5abc7f8b…
local===chain : true
local===manifest: true
RESULT: VERIFIED
exit=0
```

```
$ npm run verify -- --token-id 1004
agent discovered           PASS
card retrieved             PASS
card valid                 PASS
TRUST DECISION             TRUSTED
card                       200 · 2777 bytes · https://…/.well-known/agent-card.json
sha256 (local)             3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
sha256 (on-chain)          3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
transactions               0 (read-only)
exit=0
```

```
$ npx tsx scripts/task04-conformance.mts
local requirements : {"scheme":"exact","network":"ccd:4221332d…","asset":"CCD","amount":"250000",…}
SDK   CAIP-2       : ccd:4221332d34e1694168c2a0c0b3fd0f27
SDK   constants    : {"ccdAsset":"CCD","ccdDecimals":6,"grpcUrl":"grpc.testnet.concordium.com:20000"}
constant agreement : OK
SDK parsePrice     : {"sdkAsset":"CCD","sdkAmount":"250000"}
scheme registered  : true
explorer (SDK)     : https://ccdexplorer.io/testnet/transaction/deadbeef
exit=0
```

**160 tests across 9 suites, all passing.** (6+7+11+10+9+11+47+15+44)

### On-chain transaction count

| Measurement | Before TASK 04 | After TASK 04 |
|---|---|---|
| account nonce | 4 | **4** |
| transaction count (CCDScan) | 5 | **5** |
| balance | 19943.619923 CCD | **19943.619923 CCD** |

**Zero.** No settlement, no transfer, no registration, no URI/metadata update, no operator or wallet change.
