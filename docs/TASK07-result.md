# TASK 07 — x402 Facilitator & Operator Signing Readiness

Date: 2026-11-05 · Readiness + integration-boundary task.
**No settlement. No transaction. No key handled.**

---

## 1. VERIFIED

### 1.1 No publicly reachable CCD facilitator exists

Every plausible Concordium facilitator hostname is **NXDOMAIN**. Verified with `getent hosts`
and `curl GET /supported` from this host:

| Host | DNS | `GET /supported` |
|---|---|---|
| `facilitator.concordium.com` | NXDOMAIN | `000` (no connection) |
| `x402-facilitator.concordium.com` | NXDOMAIN | `000` |
| `x402.concordium.com` | NXDOMAIN | `000` |
| `facilitator.testnet.concordium.com` | NXDOMAIN | `000` |
| `x402.testnet.concordium.com` | NXDOMAIN | `000` |
| `agent-registry-mcp.concordium.com` | resolves | `404` (registry MCP only, not a facilitator) |
| `x402.org` | resolves | `404` (`/facilitator/supported` is the real path) |

Evidence: `docs/evidence/task07/dns-tls-probe.json`, `docs/evidence/task07/ccd-guess.json`.

### 1.2 The public x402.org facilitator does not serve Concordium

`GET https://x402.org/facilitator/supported` → **200**, 11 kinds, networks:

```
algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe · aptos:2 · base-sepolia · eip155:84532
hedera:testnet · solana-devnet · solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
stellar:testnet · xrpl:1
```

Schemes: `exact`, `upto`, `batch-settlement`. Signer families: `eip155:*`, `solana:*`,
`algorand:*`, `aptos:*`, `stellar:*`, `hedera:*`, `xrpl:*`. **No `ccd:*`, no `concordium:*`.**

Confirmed independently through `/verify` (a CCD requirement was rejected by the facilitator
itself):

```json
{"isValid":false,"invalidReason":"unexpected_error",
 "invalidMessage":"No facilitator registered for scheme: exact and network: ccd:4221332d34e1694168c2a0c0b3fd0f27"}
```

Two `/verify` observations were made by hand — empty body (400 `missing_parameters`) and the CCD
requirement above (500). `/settle` was **never** called; only `OPTIONS` to confirm the route
exists (204) and a `POST /nonexistent-xyz` baseline (404). Evidence:
`docs/evidence/task07/x402-org.json`, `verify-endpoint-observations.json`.

### 1.3 Official documentation does not publish a facilitator URL

`docs/mainnet/how-to/integrations/x402-integration` (fetched from Concordium docs, mirrored at
`/tmp/ccd/mainnet_how-to_integrations_x402-integration.txt`) describes the facilitator as a
**service the resource server operates** — it documents the `/verify` and `/settle` roles and the
MCP-middleware flow, but publishes **no hostname, no testnet URL, and no managed-facilitator
offering**. The SDK ships the facilitator *implementation* (`@x402/concordium/exact/facilitator`),
not a hosted endpoint.

### 1.4 The exact-CCD scheme is specified and sponsored-transaction based

`x402-foundation/x402` `specs/schemes/exact/scheme_exact_concordium.md` (HTTP 200, 10 121 bytes,
fetched to `/tmp/spec.md`). Load-bearing rules:

- CCD **or PLT**; we implement **CCD only**.
- Flow is **client-driven with facilitator sponsorship**: requirements carry
  `extra.feePayer`; client builds a **V1 sponsored transaction** with the facilitator as sponsor,
  signs as sender only, leaves `signatures.sponsor` **empty**; facilitator verifies, adds the
  sponsor signature, submits, waits for finalization.
- `PaymentRequirements.extra.feePayer` = the facilitator's sponsor account.
- Facilitator MUST enforce: version `1`; `header.sender` a valid base58 account;
  `header.sponsor.address == extra.feePayer`; expiry in the future and `<= now + maxTimeoutSeconds`;
  sender signature valid; transfer recipient/amount matching the requirement.
- `signedTransaction.header.sender` is the source of truth for the payer.

### 1.5 SDK signing surface (installed `@x402/concordium@2.29.0`)

From `node_modules/@x402/concordium/dist/esm/signer-C4ReoBLp.d.mts`:

```ts
interface ClientConcordiumSigner { accountAddress: AccountAddress.Type; signer: AccountSigner }
interface FacilitatorConcordiumSigner {
  getAddress(): string; getNetwork(): Network;
  getAccountInfo(address: string): Promise<AccountInfo>;
  addSponsorSignature(tx: SignableV1Transaction): Promise<Transaction.JSON>;
  submitTransaction(signedTxJSON: Transaction.JSON): Promise<string>;   // tx hash (hex)
  waitForFinalization(txHash: string, timeoutMs?: number): Promise<TransactionInfo>;
  getTokenBalance(address: string, tokenId: string): Promise<bigint | undefined>;
  getTokenDecimals(tokenId: string): Promise<number>;
}
declare function toConcordiumFacilitatorSigner(
  sponsorAddress: string, sponsorSigner: AccountSigner, grpcConfig: GrpcConfig): FacilitatorConcordiumSigner;
```

Consequence: **the client side needs an `AccountSigner`** — the SDK's only client contract is
`signer: AccountSigner` from `@concordium/web-sdk`, i.e. a signer that already holds a key. The
gateway therefore must never construct one; it produces a *signing request* and accepts a
*finished payload*. This is the architectural fact the signing boundary is built on.

### 1.6 Facilitator error taxonomy (extracted from the installed SDK)

Rejection reasons the facilitator can return, from `exact/facilitator/index.mjs`:

```
missing_payload · missing_payload_field · missing_header · missing_header_sender
missing_header_expiry · missing_header_sponsor · missing_sender_signature
missing_signed_transaction · missing_signatures · missing_fee_payer · missing_sponsor_in_header
invalid_transaction_format · invalid_sender_address · invalid_sender_signature
invalid_expiry_field · invalid_amount_format · invalid_required_amount
invalid_token_amount · invalid_token_amount_decimals · invalid_token_operations
invalid_token_recipient · invalid_token_transfer
recipient_mismatch · on_chain_recipient_mismatch · on_chain_sender_mismatch
sponsor_as_sender · sponsor_mismatch · unexpected_token_operation
unexpected_token_operations_count · transaction_expired · network_mismatch
unsupported_scheme · fee_payer_not_managed_by_facilitator
preflight_insufficient_funds · preflight_insufficient_token_funds · preflight_nonce_mismatch
preflight_missing_account_amount · preflight_missing_account_nonce
preflight_invalid_account_amount · preflight_invalid_account_nonce
preflight_token_balance_lookup_failed · token_decimals_lookup_failed
finalization_timeout · verification_failed
```

This is the vocabulary a future integration must classify against; none of it is required for
TASK 07 since nothing is settled.

---

## 2. NOT TESTED

- **A real `/settle` call.** Prohibited by this task; no CCD facilitator exists to call anyway.
- **Sponsor signature production and broadcast.** Requires a funded sponsor account with a key.
- **Finalization / `waitForFinalization`.** Unreachable without a submission.
- **Whether any managed Concordium facilitator is coming.** No published roadmap found.

## 3. BLOCKED

**Real x402 CCD settlement on Testnet is blocked by an infrastructural gap, not by our code.**

1. No official, public, or documented Testnet facilitator exists for `ccd:4221332d34e1694168c2a0c0b3fd0f27`.
2. Running one ourselves requires a funded sponsor account **and its private key in the process**,
   contradicting the no-key-handling constraint.
3. Sponsored transactions need a sponsor signature; there is no third party to provide it.

The gateway is therefore **facilitator-agnostic and ready**: point `probeFacilitator` at a URL that
advertises exact-CCD-v2 with a fee payer and the pipeline becomes usable without code changes.

---

## 4. FACILITATOR STATUS

| Question | Answer | Basis |
|---|---|---|
| Official Testnet facilitator exists? | **No** | DNS + `/supported` + `/verify` rejection |
| Documented base URL? | **None published** | Concordium x402 docs |
| `/supported`, `/verify`, `/settle` available? | Only on `x402.org/facilitator` (non-CCD) | direct HTTP |
| Supported networks | 8 non-CCD families | `/supported` body |
| CCD support | **No** | `/supported` + `/verify` error |
| Auth / rate limits | Not documented, not observed | `/supported` unauthenticated, 200 |
| Sponsored transactions | The *scheme* requires sponsorship; the public facilitator does not sponsor CCD | spec + `/supported` |

```bash
npx tsx scripts/task07-facilitator-probe.mts https://x402.org/facilitator
# → outcome: reachable, compatibility.usable: false, code: NO_CCD_NETWORK
```

---

## 5. SDK COMPATIBILITY

Installed: `@x402/core@2.29.0`, `@x402/concordium@2.29.0`, `@concordium/web-sdk@12.0.2`.

| Aspect | Status |
|---|---|
| x402 version | `2` — matches `X402_VERSION` in `src/payments/x402.ts` |
| Scheme | `exact` — matches requirements and the scheme spec |
| Network id | `ccd:4221332d34e1694168c2a0c0b3fd0f27` (CAIP-2), matches TASK 04 |
| Requirement shape | unchanged since TASK 04; `extra.feePayer` is now **required** for a sponsored flow |
| Verify/settle shapes | unchanged; `authorizePayment` contract untouched |
| Receipt semantics | `settle.transaction` (hex) required, unchanged |
| Expiry | `header.expiry` must be > now and ≤ now + `maxTimeoutSeconds`; matches TASK 04 preflight |
| Replay | per-transaction nonce from the chain; `header.nonce` is part of the payload |

**Contract preservation:** `src/payments/x402.ts` was **not modified**. TASK 04's 59 tests still pass
unmodified. The new modules only *read* TASK 04 types.

---

## 6. SIGNING ARCHITECTURE

Four strictly separated stages. The gateway is only capable of stages 1 and 4.

```
①  Authorization     operator states terms out-of-band → OperatorAuthorization
                     (network, asset, amount, payTo, feePayer, resourceUrl, ceiling)
                     ── gateway stores, never a key ──

②  Signing request   gateway validates terms vs facilitator + requirement
                     → SigningRequest (a description of what must be signed)

③  Signing           OUT OF PROCESS: Concordium Wallet / operator-held AccountSigner
                     produces the V1 sponsored tx with an EMPTY sponsor slot
                     ── gateway never sees a key, seed, or signature ──

④  Settlement gate   guardSettlement(): authorization + structure + sponsor + expiry
                     → only then may a future task call facilitator.settle()
```

### Who may request signatures

Only `requestSigning()` — and it refuses unless **all** hold: facilitator usable, requirement
matches the facilitator, asset is CCD, network supported, `extra.feePayer` equals the facilitator's
sponsor, sender is a valid account, and the authorization passes (`NO_AUTHORIZATION`,
`AUTHORIZATION_MALFORMED`, `AUTHORIZATION_EXPIRED`, `AMOUNT_EXCEEDS_AUTHORIZATION`,
`TERMS_MISMATCH`).

### Preserved operator authorization

`OperatorAuthorization` is a separate object from a signature. Holding one grants no key. An
authorization is bound to exact terms, has a hard `maxAmountMicroCcd` ceiling, and expires
(15 min default). Term drift on **any** of `network, asset, amount, payTo, feePayer, resourceUrl`
invalidates it — so a compromised or replayed requirement cannot be re-signed under an old
approval.

### Cancellation / expiry / replay

| Event | Behaviour |
|---|---|
| Operator declines | no `OperatorAuthorization` → `NO_AUTHORIZATION`, nothing signable |
| Authorization older than 15 min | `AUTHORIZATION_EXPIRED` |
| Payload expiry in the past | `PAYLOAD_INVALID` — "header.expiry is in the past (expired)" |
| Expiry beyond `maxTimeoutSeconds` | `PAYLOAD_INVALID` |
| Replay of an old payload | indistinguishable at this layer; rejected by the chain via `header.nonce` and by the facilitator's preflight nonce check |
| Sponsor slot filled by the client | `PAYLOAD_INVALID` — "signatures.sponsor must be empty" |
| Sponsor ≠ facilitator | `PAYLOAD_INVALID` |
| Settlement ambiguous (timeout) | **no retry** — one call, then deny |

### Signing format, exactly

From the scheme spec + SDK types: a **`VersionedTransaction` v1 sponsored JSON** with
`header.sender` (base58), `header.nonce` (integer), `header.expiry` (unix seconds),
`header.numSignatures`, `header.sponsor.address`, a `transfer` payload
(`toAddress`, `amount`, `energy`), `signatures.sender` populated, and `signatures.sponsor` **empty**.
No seed phrases, no key export — the signer produces only the sender's credential signature map.

---

## 7. SECURITY FINDINGS

Audited the existing TASK 04 module against the eight requested areas:

| # | Area | Finding |
|---|---|---|
| 1 | Accidental facilitator URL fallback | **None.** `DENY_ALL_FACILITATOR` is the only default; `createHttpFacilitator('')` throws; no env var is read in `src/payments/*` |
| 2 | Credentials leaking through errors | **None found.** `authorizePayment` surfaces `e.message` from the facilitator; a malicious facilitator could echo payload content. Mitigated for our own paths — `inspectSignedPayload().facts` never carries signature bytes, and `requestSigning` output contains no key material (test 29) |
| 3 | Untrusted facilitator responses | **Hardened.** `validateSupportedShape` + `classifyCompatibility` treat the response as untrusted; unknown networks/schemes/versions are hard blocks, never "best effort" |
| 4 | Settlement retries duplicating payments | **None.** `authorizePayment` calls settle at most once, no loop, no retry (tests 25, 26) |
| 5 | Missing transaction-hash validation | **Present.** Success without `settle.transaction` denies access (test 27) |
| 6 | Replay / expiry bypass | **Blocked.** Structural expiry window + nonce; and the pre-existing TASK 04 preflight |
| 7 | Trust-policy bypass via direct payment calls | **None.** `src/payments/*` imports nothing from `registry`/`verify`/`commerce`; the commerce layer calls the payment layer, never the reverse |
| 8 | Audit events with signing material | **Blocked.** `assertNoSecrets` rejects 64-hex values and secret-named fields before hashing; test 30 proves a payment event carrying key material is refused and nothing is written |

**Additional finding (documented, not fixed):** the SDK's client-side contract is
`signer: AccountSigner`, which implies in-process key custody. Any future integration that imports
`ClientConcordiumSigner` into the gateway process would put a key in the gateway. The signing
boundary exists specifically to prevent that; it should be treated as a review invariant.

---

## 8. FILES CHANGED

**New**
- `src/payments/facilitator.ts` — `/supported` probe, schema validation, compatibility
  classification, requirement↔facilitator validation
- `src/payments/operatorSigning.ts` — authorization, signing request, structural payload
  inspection, settlement guard
- `test/task07-facilitator-readiness.test.mts` — 30 tests
- `scripts/task07-facilitator-probe.mts` — read-only CLI probe
- `docs/evidence/task07/` — 4 artifacts
- `docs/TASK07-result.md` — this report

**Modified:** none. `src/payments/x402.ts`, `src/commerce/*`, `src/audit/*`, `src/registry/*`,
`src/verify/*` are untouched.

---

## 9. TEST RESULTS

```
$ npx tsx test/task07-facilitator-readiness.test.mts
  ok   01. facilitator unavailable → classified failure, never a fallback
  ok   02. DNS vs TLS vs refusal vs timeout are distinguished
  ok   03. HTTP error and invalid JSON are distinguished from network errors
  ok   04. probe only ever requests /supported
  ok   05. /supported schema validation rejects malformed bodies
  ok   06. unsupported network is a hard block with the networks listed
  ok   07. unsupported scheme on our network is a hard block
  ok   08. wrong x402 version is a hard block
  ok   09. a facilitator with no fee payer cannot sponsor, so it is unusable
  ok   10. a fully compatible announcement is usable
  ok   11. requirement/facilitator mismatch is rejected both ways
  ok   12. missing operator authorization blocks signing
  ok   13. authorization term drift blocks signing
  ok   14. authorization ceiling and expiry are enforced
  ok   15. signing request names the sponsor and forbids a sponsor signature
  ok   16. an unusable facilitator or bad sender blocks the signing request
  ok   17. a well-formed payload passes structural inspection and leaks no signature
  ok   18. expired, wrong-sponsor, wrong-amount, wrong-recipient payloads are rejected
  ok   19. a payload signed by the sponsor is rejected — only the facilitator may sponsor
  ok   20. malformed payloads fail structurally rather than throwing
  ok   21. non-settling mode refuses before any settlement call
  ok   22. settlement guard rejects a valid payload with no authorization
  ok   23. settlement guard rejects a structurally invalid payload
  ok   24. verification rejection never reaches settle (counted facilitator)
  ok   25. verification timeout is not retried and never settles
  ok   26. ambiguous settlement is not retried
  ok   27. settlement success without a transaction hash denies access
  ok   28. the default facilitator denies every operation
  ok   29. no signing material appears in any produced artifact
  ok   30. audit trail rejects a payment event carrying key material

task07-facilitator-readiness: 30/30 passed
```

```
$ npm test
PASS  finding-1-faucet.test.mjs                      6/6
PASS  finding-2-account-derivation.test.mjs          7/7
PASS  finding-3-agent-card.test.mjs                 11/11
PASS  finding-4-wallet-serialization.test.mjs       10/10
PASS  regression-bytes.test.mjs                      9/9
PASS  task03-cli-contract.test.mts                  11/11
PASS  task03-discovery-and-trust.test.mts           47/47
PASS  task04-sdk-conformance.test.mts               15/15
PASS  task04-x402-exact.test.mts                    44/44
PASS  task05-commerce.test.mts                      36/36
PASS  task06-audit-integrity.test.mts               25/25
PASS  task06.1-lock-hardening.test.mts              14/14
PASS  task07-facilitator-readiness.test.mts         30/30
────────────────────────────────────────────────────────────
all suites passed                                  265 tests
exit=0
```

| Command | Exit | Result |
|---|---|---|
| `npx tsc --noEmit` | 0 | no type errors |
| `npm run verify -- --token-id 1004` | 0 | `TRUSTED` |
| `task02-verify.mjs` | 0 | `VERIFIED` |
| `task04-conformance.mts` | 0 | OK |
| `task06-verify-trails.mts docs/evidence/task05` | 0 | `ALL TRAILS VERIFIED` |
| `task07-facilitator-probe.mts https://x402.org/facilitator` | 0 | `NO_CCD_NETWORK` |

---

## 10. REMAINING BLOCKERS (for a future task)

1. **Facilitator.** Either a managed CCD facilitator must appear, or one must be run — the latter
   requires an operator-held sponsor key, which needs its own explicit authorization.
2. **Sponsor funding.** A sponsor account with enough CCD for fees on Testnet.
3. **Real settlement.** Cannot be claimed until an authorized `/settle` succeeds and returns a hash
   verifiable in CCDScan. Nothing in this repository claims otherwise.

---

## 11. ON-CHAIN STATUS

**Zero transactions.** `accountNonce 4`, `pendingNonce 4`, balance `19943.619923 CCD` — unchanged
since TASK 02. No CCD or PLT moved. No real `/settle` was invoked.
