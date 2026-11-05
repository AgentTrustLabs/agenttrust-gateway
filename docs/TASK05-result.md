# TASK 05 — Trust-Gated Agent Commerce & Audit Trail

Date: 2026-11-05 · Concordium **Testnet** · Asset: CCD · **settlement simulated, zero on-chain transactions**

Every output below was produced by running the command shown; nothing is transcribed success text.

---

## Architecture and integration decisions

Three new modules, zero changes to existing ones:

```
src/commerce/trustPolicy.ts     TrustResult → allow / deny (deny-by-default)
src/commerce/orchestrator.ts    runCommerce(): the pipeline, all I/O injected
src/audit/trail.ts              append-only JSONL, secret refusal, tamper detection
src/cli/commerce.ts             `agenttrust commerce` entry point
```

Reused as-is: `verify/crossAgent` (identity), `payments/x402` (protocol + access gate),
`registry/mcpClient` patterns (read-only registry access). No crypto is reimplemented; the orchestrator
computes no hash and holds no key.

**Interface adaptations, not redesigns** — three mismatches were absorbed at the seam:

| Mismatch | Adaptation |
|---|---|
| `verifyAgent` wants `{agents: […]}`; `agent_of` returns one record | orchestrator wraps it: `{ agents: [record] }` |
| `verifyAgent` needs CAIP-2 + contract coordinates | read live via `contract_info`; config fallback fails **closed** (bad coordinates become a trust failure, not a pass) |
| `payTo` is not part of the trust result | taken from the registry record's `owner_account`, never from the card or the caller |

**Why the policy only reads `TrustResult`:** the card's claims are already folded into that result by the
verifier. Re-reading the card in the policy could only weaken the decision, so it is not done.

**Why settlement is mocked:** no public Concordium testnet x402 facilitator exists
(`facilitator.concordium.com`, `x402-facilitator.concordium.com` do not resolve), no funded sponsor account,
and a real client payload requires a signing key this task forbids touching. The mock is explicit: its
"transaction" is a deterministic local hash over `simulated:payTo:amount:asset`, labelled
`payment.settlement.simulated`, and printed as `SIMULATED — not on chain`.

---

## Exact CLI invocation

```
npm run commerce -- --token-id 1004 --out docs/evidence/task05
# or directly
node dist/cli/commerce.js --token-id 1004 --out docs/evidence/task05
```

Flags: `--token-id`, `--out`, `--amount` (CCD, default 0.25), `--expect-owner`, `--network`,
`--resource-url`, `--facilitator {ok|reject|settle-fail|settle-nohash}`, `--mcp`, `--json`.

Exit codes: **0** access granted · **1** trust rejected · **2** payment rejected · **3** usage/transport.

---

## Successful demonstration output

`node dist/cli/commerce.js --token-id 1004 --out docs/evidence/task05` → **exit 0**

```
[1/4] discovering token 1004 on testnet
[2/4] verifying identity independently (live registry + card bytes)
[3/4] trust policy + x402 exact payment (facilitator mode: ok)
[4/4] MOCK settlement — no transaction is signed or submitted

session                    cs_20261105012708655_lrmydo
stage                      access_granted
agent trust                TRUSTED
trust policy               ALLOWED
payment requirement        250000 microCCD CCD
facilitator (MOCK)         verify, settle
settlement                 SIMULATED — not on chain
simulated txn              25ed2e41cb483e8469d3dbf1ac97cc97e36a36d0316cc2dfbddb7cef8d8983e6
access granted             true
reason                     trust verified and payment settled
────────────────────────────────────────────────────────────
audit trail                docs/evidence/task05/audit-trail.jsonl
audit events               8

NO REAL PAYMENT · NO ON-CHAIN TRANSACTION · NO KEY USED
```

## Trust rejection demonstration

`--expect-owner 3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8` (a wrong pin) → **exit 1**

```
stage                      trust_rejected
agent trust                REJECTED
trust policy               TRUST_REJECTED
payment requirement        —
facilitator (MOCK)         not called
settlement                 none
access granted             false
reason                     trust gate: verification rejected: owner_matches=FAIL
audit events               4
```

The facilitator was **never called** and no payment requirement was built — the rejection happens before
any payment object exists. Trail: `discovered → card.retrieved → trust.rejected → access.denied`.

## Payment rejection demonstration

`--facilitator reject` (mock verify refuses) → **exit 2**

```
agent trust                TRUSTED
trust policy               ALLOWED
payment requirement        250000 microCCD CCD
facilitator (MOCK)         verify          ← settle never called
settlement                 none
access granted             false
reason                     payment gate: verify rejected: sender_signature_invalid — mock rejection
```

Two further failure modes recorded in `docs/evidence/task05/rejections/`, both exit 2:

| Mode | Result |
|---|---|
| `--facilitator settle-fail` | settlement returns `success:false` → access denied, no receipt |
| `--facilitator settle-nohash` | settlement "succeeds" with no transaction → **access denied** (unaufitable) |

---

## Audit trail example

`docs/evidence/task05/audit-trail.jsonl` — 8 lines, one per event, append-only. First event:

```json
{"seq":1,"event_id":"…","timestamp":"2026-11-05T01:27:08.655Z","session_id":"cs_20261105012708655_lrmydo","type":"agent.discovered","outcome":"PASS","reason":"token found in registry","agent":{"token_id":1004,"token_address":"JyP9YLib1wYgFmztkcKJL","owner_account":"4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d","agent_uri":"https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json","metadata_sha256":"3f614404…"},"evidence_ref":"evidence.discovery"}
```

Event order (granted session):

```
1 agent.discovered             PASS
2 agent.card.retrieved         PASS
3 agent.trust.verified         PASS
4 payment.requirement.created  PASS
5 payment.payload.received     PASS
6 payment.verified             PASS
7 payment.settlement.simulated PASS
8 commerce.access.granted      PASS
```

Event order (payment rejection) — the terminal event is always the decision:

```
1 agent.discovered PASS · 2 agent.card.retrieved PASS · 3 agent.trust.verified PASS
4 payment.requirement.created PASS · 5 payment.payload.received PASS
6 payment.rejected FAIL · 7 commerce.access.denied FAIL
```

Each event carries: `seq`, `event_id` (UUIDv4), `timestamp` (UTC ISO-8601), `session_id`, `type`,
`outcome`, and optionally `reason`, `agent{…}`, `payment{…}`, `evidence_ref`.

---

## Tamper evidence — exact guarantees and limits

`AuditTrail.verify(file)` re-reads a trail and reports:

**It DOES detect**
- malformed JSON lines
- **per-session** `seq` gaps or reordering (each session's sequence must run 1,2,3… in file order)
- timestamps that are not UTC ISO-8601
- events missing `event_id`, `session_id`, `type` or `outcome`

**It does NOT do, and must not be claimed**
- The file is **append-only by convention, not immutable.** Anyone with write access can edit, truncate or
  rewrite lines. There is no hash chain linking events, no signature, and no external anchor.
- `seq` and `event_id` are self-declared fields inside the record they describe. A determined editor can
  renumber a forged event so the file still validates. Detection here is *accident* detection, not
  adversary-proof tamper evidence.
- Deleting trailing lines is invisible: a truncated tail is indistinguishable from a session that ended
  earlier.
- No file locking. Two processes appending concurrently can interleave partial lines; `verify` would report
  malformed JSON after the fact rather than prevent the corruption.

What real tamper evidence would require (out of scope here): hash-chaining each event to the previous one,
signing the chain head, and anchoring that head somewhere the writer cannot rewrite.

---

## Sensitive data exclusion

Enforced at write time by `assertNoSecrets()`, called on every event before persistence:

- any field whose name matches `private|secret|seed|mnemonic|passphrase|password|signerkey|apikey` → refused
- a bare 32-byte hex value → refused, **unless** the field is a declared public hash
  (`*.transaction`, `*.metadata_sha256`, `*_sha256`, `*_hash`)
- the event schema is closed: `payment` may only carry
  `requirement_id, amount, asset, network, pay_to, payer, transaction` — there is no slot for a payload,
  a signature or a signed transaction

Proven by test `no payload, signature or key material reaches the audit log`: a payload carrying
`signatures.sender['0']['0'] = DEADBEEF…` is passed through the entire pipeline, and the serialised trail is
asserted to contain none of `DEADBEEF`, `signedTransaction`, `signatures`, `nonce` or `expiry`.

---

## Test results

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
PASS  task05-commerce.test.mts                       task05-commerce: 36/36 passed
────────────────────────────────────────────────────────────────
all suites passed
exit=0

$ npx tsc --noEmit                                       exit=0
$ npm run verify -- --token-id 1004                      exit=0   TRUST DECISION: TRUSTED
$ npx tsx scripts/task02-verify.mjs 1004 5abc7f8b…       exit=0   RESULT: VERIFIED
$ npx tsx scripts/task04-conformance.mts                 exit=0
```

**196 tests across 10 suites, all passing** (160 prior + 36 here).

TASK 05 suite (`test/task05-commerce.test.mts`, 36 tests) covers all twelve required cases:

| # | Required case | Test |
|---|---|---|
| 1 | Successful discovery + trust verification | `full pipeline grants access with a receipt and a complete audit trail` |
| 2 | Trust rejection prevents payment flow | `failed trust verification stops the flow before any payment object exists` |
| 3 | Inconclusive trust prevents payment flow | `agent not in the registry blocks commerce`, `policy rejects INCONCLUSIVE by default` |
| 4 | Valid verify → simulated settlement | happy-path test, asserts `verify,settle` order and receipt |
| 5 | Failed verification never reaches settlement | `failed payment verification never reaches settlement` |
| 6 | Settlement failure denies access | `settlement failure denies access` |
| 7 | Settlement without tx reference denies access | `settlement success without a transaction reference denies access` |
| 8 | Access only after all gates pass | `access is granted only after successful settlement, never before` (3-stage) |
| 9 | Audit events in correct order | happy-path asserts the exact 8-event sequence |
| 10 | Sensitive data not written | `no payload, signature or key material reaches the audit log` |
| 11 | Sessions do not mix | `two commerce sessions never mix audit events`, `sessions written to one file stay distinguishable and order-preserving` |
| 12 | Malformed / unavailable deps fail safely | malformed discovery, throwing `contract_info`, throwing adapter, throwing facilitator |

Every one of these drives `runCommerce()` end-to-end through the real orchestrator — not isolated helpers.

---

## Known limitations

1. **Settlement is simulated.** The facilitator is a mock; the "transaction" is a local hash and does not
   exist on chain. Labelled as such in the CLI output, the audit event type, and the receipt path.
2. **The client payload is structural.** Its sender signature is a placeholder (`00`); a real facilitator
   would reject it at rule 8. TASK 04 forbids key handling, so no real payload can exist yet.
3. **Audit is not adversary-proof.** No hash chain, no signature, no anchoring, no file locking — see above.
4. **Single provider per session.** Multi-provider selection ("cheapest trusted provider") is not
   implemented and was not required.
5. **`contract_info` fallback** degrades to configured coordinates rather than aborting; safe (fails closed)
   but only implicitly exercised.
6. **Concurrent appenders** are not safe; `verify` flags the resulting malformed lines after the fact.

## Blocked

Live settlement — the same three reasons as TASK 04: no public testnet facilitator, no funded sponsor
account, no operator-supplied signing key. TASK 05 does not require entering that path.
