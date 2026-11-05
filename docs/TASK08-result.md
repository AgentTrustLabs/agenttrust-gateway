# TASK 08 — MCP Interface & End-to-End Hackathon Demonstration

Date: 2026-11-05 · Integration + usability task. **No new blockchain infrastructure, zero transactions.**

---

## 1. VERIFIED

### 1.1 Architecture inspection (before writing code)

| Checked | Finding |
|---|---|
| MCP server already present? | **No.** `src/mcp/` existed as an empty directory — no server, no handler, no dependency (`package.json` had only `@concordium/web-sdk`, `@x402/*`). |
| Existing CLI | `agenttrust` (register), `agenttrust-verify` (TASK 03, exit 0/1/3), `agenttrust-commerce` (TASK 05, exit 0/1/2/3) |
| Registry client | `src/registry/mcpClient.ts` — already speaks JSON-RPC to the Concordium registry MCP, with `callToolRaw` as a typed escape hatch |
| Trust pipeline | `src/verify/crossAgent.ts` → `verifyAgent({expect, discoveryPayload, fetchImpl, badge})`, pure orchestration over injected I/O |
| Trust policy | `src/commerce/trustPolicy.ts` → `evaluateTrustPolicy(TrustResult, policy, intent)` |
| Commerce | `src/commerce/orchestrator.ts` → `runCommerce(client, target, request, deps)` with injected facilitator/fetch/audit |
| Audit | `src/audit/trail.ts` → `AuditTrail`, `AuditTrail.verify(filePath, opts)` |
| Duplicated logic found | `mockFacilitator` + `structuralPayload` lived **inside** `src/cli/commerce.ts`. Extracted to `src/commerce/simulation.ts` so the MCP layer reuses them instead of copying. CLI behaviour unchanged (verified: same output, exit 0). |

No existing MCP tool surface existed, so nothing had to be preserved beyond CLI behaviour, which is unchanged.

### 1.2 Protocol and interoperability

| Requirement | Evidence |
|---|---|
| Tool discovery | `tools/list` returns exactly 6 tools with full schemas (tests 27, 32) |
| Input/output schemas | Closed (`additionalProperties: false`); every property bounded or enumerated (test 32) |
| Tool invocation | all 6 invoked end-to-end over a real subprocess (demo; tests 11–24) |
| Error handling | `{code, message}` only, one line, no stack frames (tests 3, 26, 30) |
| Structured results | every result is JSON and round-trips losslessly (test 33) |
| Protocol version | MCP `2024-11-05`; `initialize` → `serverInfo {name: "agenttrust-gateway", version: "1.0.0"}` (test 27) |
| Clean startup/shutdown | stdin close → exit 0, not SIGTERM (test 31); every stdout line is a valid JSON-RPC response and **stderr is empty** (test 29) |
| No stdout contamination | test 29 asserts exactly N responses for N requests plus empty stderr |

No MCP SDK dependency was added: the protocol is ~120 lines over `node:readline`. That keeps
the dependency surface at zero and avoids SDK version coupling.

### 1.3 Live third-party agent (demo step 4)

`registry.search` over the live Testnet registry returns 25 agents. Candidate cards were
fetched and hashed **before** writing the demo; four had byte-exact on-chain hash matches:

| token | card bytes | sha256 vs on-chain |
|---|---|---|
| 10 | 2 227 | match |
| 12 | 1 998 | match |
| 18 | 1 643 | match |
| 19 | 2 313 | match |
| 9 | 1 354 | **mismatch** — card was re-published |

The demo takes the first reachable candidate. In the recorded run it selected **token 19**, a
real third-party agent, and the real pipeline returned **`REJECTED`**: the on-chain hash
matches, but the card carries no Concordium badge extension, so `card_valid`,
`owner_matches` and `contract_references_match` all FAIL. No fixture was needed;
`fixture_used: false` in the evidence. That is a genuine third-party rejection.

### 1.4 Six tools exposed — the smallest useful set

| Tool | Delegates to | Why it is needed |
|---|---|---|
| `registry.search` | `AgentRegistryMcp.callToolRaw('search_agents')` | discovery by query |
| `registry.card` | `agent_of` + `fetchCardBytes` | card bytes + locally computed SHA-256 |
| `trust.verify` | `verifyAgent` (TASK 03) | TRUSTED / REJECTED / INCONCLUSIVE + per-check evidence |
| `trust.policy` | `evaluateTrustPolicy` (TASK 05) | explain the gate independently of a full run |
| `commerce.simulate` | `runCommerce` + mock facilitator | the end-to-end demo |
| `audit.verify` | `AuditTrail.verify` (TASK 06) | prove the trail the run produced |

Candidates deliberately **not** implemented: agent registration, card building, badge
re-verification as a separate tool (already inside `trust.verify`), payment settlement, and
anything touching signing. Registration mutates chain state and belongs to a wallet-holding
operator; exposing it over MCP would be authority escalation, not convenience.

Full schemas, invocation examples, and interpretation: `docs/MCP-GUIDE.md` §4–§6.

### 1.5 Live end-to-end demo over the real MCP transport

`scripts/task08-demo.mjs` spawns `dist/mcp/server.js` as a subprocess and talks to it only through newline-delimited JSON-RPC — it imports no handler. Actual run:

```
tools                6
1 discover          token 1004
2 card              2777 bytes  sha256 3f6144046d843b7b…
3 trust             TRUSTED
4 second agent      19  REJECTED  (live third-party)
6 success           access_granted  settled=false (SIMULATED)
7 trust reject      trust_rejected  facilitator calls=0
8 payment reject    payment_rejected  settled=false
9 audit verified    3/3
  forged auth       AUTHORIZATION_NOT_ACCEPTED
  shutdown          exit 0, stderr clean
NO REAL PAYMENT · NO ON-CHAIN TRANSACTION · NO SIGNING KEY USED
EXIT=0
```

Recorded facts from the same run (`docs/evidence/task08/demo-results.json`):

- `registry.search("AgentTrust", limit 5)` → 1 agent, `token_id 1004`
- `registry.card(1004)` → `byte_length 2777`, `sha256 3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564`, status `Active`
- `trust.verify(1004)` → all of `agent_discovered, card_retrieved, card_valid, hash_matches_on_chain, owner_matches, status_active, contract_references_match` = **PASS**; `badge_valid = NOT_TESTED` (hosted checker not consulted — see §2)
- `commerce.simulate` → `access_granted`, mock calls `verify,settle`, 8 audit events
- `audit.verify` on all three trails → `ok: true`, checkpoints `matches: true`
- shutdown: exit 0, no SIGTERM, stderr empty

---

## 2. NOT TESTED

- **Any MCP host integration** (Claude Desktop / Cursor config files). The server implements the documented `initialize` / `tools/list` / `tools/call` methods over stdio and was driven by a real subprocess client, but no third-party host was wired up.
- **HTTP/SSE transport.** Not implemented — stdio only. A remote deployment would need it plus real authentication, which the authorization invariant (§8) is not yet ready for.
- **Concurrency.** MCP requests are handled as they arrive; `AuditTrail` locking (TASK 06.1) protects the file, but parallel tool storms were not load-tested.
- **`badge_valid`.** The hosted `verify_agent_card` checker was not consulted during the demo, so that check is `NOT_TESTED` rather than `PASS`. It is corroboration only by design (TASK 03).
- **Live third-party agents in general.** Only the handful reachable during the run were inspected. Several registry entries point at dead URLs (`tippingservice.co.uk/…` → 404) or at `localhost`, and token 9's card no longer matches its on-chain hash.

---

## 3. BLOCKED

Nothing in TASK 08 is blocked. Two things carried over from TASK 07 are unchanged:

1. **Real x402 CCD settlement** — no publicly reachable CCD facilitator exists.
2. **Operator authorization channel** — `OperatorAuthorization` (TASK 07) is unbound JSON with
   no cryptographic proof, so it is refused at the MCP boundary (§5). Until a signed, TTL'd,
   single-use authorization exists on a non-MCP transport, no client can authorize settlement.
   That is the correct state, not a defect to paper over.

The demo is honest about this: every commerce result carries
`settled: false` and the fixed disclaimer
`"SIMULATED settlement: no transaction was signed, submitted, or recorded on chain."`.

---

## 4. MCP ARCHITECTURE

```
MCP host  ──stdio JSON-RPC 2.0──►  src/mcp/server.ts     (protocol only)
                                        │
                                   src/mcp/tools.ts      (validation boundary only)
                                        │
        ┌───────────────┬───────────────┼──────────────┬────────────────┐
        ▼               ▼               ▼              ▼                ▼
  registry/mcpClient  verify/crossAgent  commerce/     commerce/     audit/trail
   (TASK 02/03)         (TASK 03)       trustPolicy   orchestrator     (TASK 06)
                                          (TASK 05)     (TASK 05)
                                                          │
                                                    commerce/simulation
                                                     (mock facilitator)
```

Two rules held throughout:

1. **No business logic in the MCP layer.** Every handler is validate → delegate → shape.
2. **No new chain, contract, indexer, dashboard, or hosted service.**

`src/mcp/*` imports nothing from `@concordium/web-sdk` and never names `AccountSigner` —
asserted by test 34, not by review.

---

## 5. EXPOSED TOOLS

Six tools, each delegating to an existing module:

| Tool | Module | Purpose |
|---|---|---|
| `registry.search` | `AgentRegistryMcp.callToolRaw('search_agents')` | discovery by query |
| `registry.card` | `agent_of` + `fetchCardBytes` | card bytes + local SHA-256 |
| `trust.verify` | `verifyAgent` (TASK 03) | TRUSTED / REJECTED / INCONCLUSIVE + evidence |
| `trust.policy` | `evaluateTrustPolicy` (TASK 05) | explain the gate |
| `commerce.simulate` | `runCommerce` + mock facilitator | the demo flow |
| `audit.verify` | `AuditTrail.verify` (TASK 06) | prove the trail |

Deliberately **not** exposed: agent registration, card building, badge re-check as a
separate tool (already inside `trust.verify`), settlement, anything signing-related.
Registration mutates chain state and belongs to a wallet-holding operator.

Full schemas, invocation examples, and result interpretation: `docs/MCP-GUIDE.md` §4–§6.

---

## 6. END-TO-END DEMONSTRATION

`node scripts/task08-demo.mjs` — spawns `dist/mcp/server.js`, talks only JSON-RPC, imports
no handler.

| Step | Result |
|---|---|
| 1. Discover AgentTrust | `registry.search("AgentTrust")` → 1 record, token 1004 |
| 2. Retrieve its card | 2 777 bytes, SHA-256 `3f614404…` = the on-chain `metadata_hash` |
| 3. Verify identity | all required checks PASS → `TRUSTED` |
| 4. Second agent | token **19**, live third-party, `REJECTED` (no badge extension) |
| 5/6. Trust-gated commerce | `access_granted`, mock `verify`+`settle`, `settled: false` |
| 7. Trust failure | owner-pin mismatch → `trust_rejected`, **facilitator calls = 0**, no requirement built |
| 8. Payment failure | `mode: "reject"` → `payment_rejected`, `receipt: null`, nothing settled |
| 9. Audit | 3/3 trails verify; 8 events (grant) / 4 (trust rejection) / 7 (payment rejection), checkpoints match |

Audit event order for the grant (test 37 asserts exactly this string):

```
agent.discovered → agent.card.retrieved → agent.trust.verified →
payment.requirement.created → payment.payload.received → payment.verified →
payment.settlement.simulated → commerce.access.granted
```

Rejection runs record `agent.trust.rejected` / `payment.rejected` plus
`commerce.access.denied`, and contain **no** grant and **no** settlement event (test 38).

**Simulated vs real, labelled everywhere:** `simulation.settled: false`,
`simulation.facilitator: "mock"`, `receipt.settled: false`, `receipt.simulated_transaction`
plus an explicit note that it is derived from `payTo:amount:asset` and never submitted, and
the fixed disclaimer *"SIMULATED settlement: no transaction was signed, submitted, or
recorded on chain."* The ledger side — discovery, card bytes, SHA-256, on-chain hash
comparison, owner/status/contract checks, policy, audit chain — is **real**.

---

## 7. SECURITY BOUNDARIES

### 7.1 Input validation

Every tool goes through the same gauntlet **before** any module is touched:

1. `assertInputSize` — 8 KiB cap on the serialized arguments.
2. `assertNoForbiddenFields` — recursive key scan (depth 6, arrays flattened).
3. Closed schema per tool (`additionalProperties: false`).

Typed validators: `assertNetwork` (enum `testnet|mainnet|devnet`, default `testnet`), `assertTokenId` (positive integer ≤ 2³²-1, numeric strings accepted), `assertAmount` (decimal integer string, > 0, ≤ 1 000 000 000 microCCD demo ceiling), `assertAccount` (base58 shape only — never a key), `assertPolicyName` (enum).

Bounded: max string length 512, max search limit 25, execution timeout 30 s (`withTimeout` → `TIMEOUT`).

### 7.2 Not exposed

| Capability | Status |
|---|---|
| Arbitrary filesystem read | **No.** `audit.verify` takes a *bare filename*, rejects `/`, `\`, `..`, and absolute paths, resolves inside `AGENTTRUST_AUDIT_ROOT`, and re-checks the prefix after resolution. |
| Directory listing | **No.** |
| Shell execution | **No.** |
| Registry/endpoint override | **No.** `registryBase` comes from `AGENTTRUST_REGISTRY_MCP` (operator env). `mcp_base`, `endpoint`, `url`, `registry`, `path`, `file` are all in `REJECTED_FIELDS` and rejected outright. |
| Credentials / keys / seeds | **No.** `privatekey`, `seed`, `mnemonic`, `password`, `token`, `bearer` rejected as input; nothing in output ever contains them (test 25). |
| Stack traces | **No.** `toToolError` reduces every failure to `{code, message}` with a single 300-char line; the RPC layer truncates to 200 chars. Test 26 proves an upstream `ECONNREFUSED … at Socket.<anonymous>` becomes one clean line. |

### 7.3 Trust and policy cannot be bypassed

- `trust.verify` always calls the real TASK 03 pipeline; there is no parameter that selects a cheaper path.
- `commerce.simulate` always calls `runCommerce`, which applies the policy **before** building any payment requirement. The demo shows this concretely: an owner-pin mismatch yields `trust_rejected` with `facilitator calls = 0` and `requirement = null` — the payment stage never existed.
- `trust.policy` accepts a verdict string (it is a policy *explainer*), but it labels the result `verdict_source: "client_supplied"` and points the caller at `trust.verify`. It cannot be used to authorize anything: `commerce.simulate` does not read a client-supplied verdict at all — it recomputes one.

---

## 8. OPERATOR AUTHORIZATION INVARIANT

**Implemented as a hard rejection, not a silent ignore.**

TASK 07 introduced `OperatorAuthorization` — a plain object with `authorization_id`, `issued_by`, `issued_at`, `terms`, `maxAmountMicroCcd`. It has **no cryptographic binding**, so any client that could post one over MCP would be able to forge it. Accordingly:

- **No tool issues, accepts, mutates, stores, or returns an `OperatorAuthorization`.**
- `REJECTED_FIELDS` contains `authorization`, `operatorauthorization`, `operator_authorization`, `authorization_id`, `issued_by`, `max_amount_micro_ccd`. Their presence anywhere in the argument tree (nested, arrayed, any depth ≤ 6) yields `AUTHORIZATION_NOT_ACCEPTED` with the message:

  > `OperatorAuthorization cannot be supplied over MCP (field 'authorization'). Authorization is issued out-of-process by the operator; no MCP tool accepts or creates it.`

- Authorization-shaped fields get their **own** error code so a client that tried to self-authorize is told exactly why, instead of believing it succeeded.
- The settlement switches `settle` / `allow_settlement` are rejected under the same boundary.

Verified four ways: unit (`assertNoForbiddenFields`), per-tool matrix (8 payload shapes × 6 tools, test 04), no-leak (test 07 checks no tool result ever emits `operatorauthorization` or a ceiling it was never given), and over the wire through the real server (test 28, `isError: true`, `AUTHORIZATION_NOT_ACCEPTED`).

### 8.1 What a real operator boundary would require

Documented, **not implemented** — this is the honest gap:

1. **Authenticated issuance.** The operator signs an authorization with a key the gateway cannot hold (e.g. an EIP-712 / Concordium-signed statement over the exact terms), delivered out-of-band (file, local socket, OS keychain prompt).
2. **Verification in-gateway, issuance outside.** The gateway would verify the signature against a pinned operator public key — never mint one.
3. **Short TTL + single use.** Nonce-style replay protection, bound to one `session_id` and one requirement hash.
4. **No MCP path.** Any future operator channel must remain a separate transport with its own authentication; MCP stays unauthenticated and therefore unauthorized by construction.

Until 1–3 exist, settlement cannot be authorized by any MCP client — which is the correct state for a hackathon demo.

---

## 9. FILES CHANGED

**New**
- `src/mcp/tools.ts` — six tools, validators, error reduction, authorization boundary, `LIMITS`
- `src/mcp/server.ts` — stdio JSON-RPC server (`initialize`, `tools/list`, `tools/call`, `ping`)
- `src/commerce/simulation.ts` — `mockFacilitator`, `structuralPayload`, `SIMULATION_DISCLAIMER` extracted from the CLI
- `test/task08-mcp-interface.test.mts` — 38 tests, subprocess-based for transport
- `docs/MCP-GUIDE.md` — setup, schemas, invocation examples, demo instructions
- `scripts/task08-demo.mjs` — end-to-end demo over the real transport
- `docs/evidence/task08/demo-results.json`, `demo-transcript.jsonl`
- `docs/TASK08-result.md` — this report

**Modified**
- `src/cli/commerce.ts` — the two inlined simulation helpers removed; now imports from `src/commerce/simulation.ts`. Behaviour identical (same output, exit 0).
- `package.json` — `bin.agenttrust-mcp`, `scripts.mcp`

**Untouched:** `src/verify/*`, `src/registry/mcpClient.ts`, `src/audit/*`, `src/payments/*`, `src/commerce/orchestrator.ts`, `src/commerce/trustPolicy.ts`, TASK 02 registration.

---

## 10. TEST RESULTS

```
$ npx tsx test/task08-mcp-interface.test.mts
  ok   01. exactly six tools are exposed, all with closed input schemas
  ok   02. no tool can settle, sign, or take a path/URL/credential
  ok   03. unknown tool names are rejected without a stack trace
  ok   04. a client cannot submit an OperatorAuthorization through any tool
  ok   05. the authorization rejection names the field and explains the boundary
  ok   06. authorization-shaped fields are rejected even when nested or arrayed
  ok   07. no tool result ever contains an authorization object
  ok   08. networks, token ids, and amounts are validated strictly
  ok   09. oversized input is rejected before any work happens
  ok   10. search limit bounds and required fields are enforced
  ok   11. trust.verify reports TRUSTED from independently recomputed evidence
  ok   12. trust.verify rejects a tampered card
  ok   13. trust.verify rejects an owner pin mismatch
  ok   14. registry.card returns bytes, hash, and the card body
  ok   15. a client cannot point any tool at a different registry
  ok   16. trust policy denies REJECTED and INCONCLUSIVE, allows TRUSTED
  ok   17. a client-supplied verdict is labelled as such
  ok   18. policy names and intents are validated
  ok   19. commerce.simulate grants access but never settles on chain
  ok   20. a trust rejection stops commerce before any payment work
  ok   21. mock payment rejection and settlement failure both deny access
  ok   22. commerce rejects an amount above the demo ceiling
  ok   23. audit.verify reads only bare filenames inside the audit root
  ok   24. audit.verify detects tampering in a server-written trail
  ok   25. no tool output contains key material or stack traces
  ok   26. errors from upstream are reduced to one bounded line
  ok   27. the stdio server answers initialize, tools/list, and a bad method
  ok   28. the server rejects an authorization payload over the wire
  ok   29. stdout carries only JSON-RPC; diagnostics never contaminate the stream
  ok   30. malformed MCP requests fail safely and keep the server alive
  ok   31. a graceful shutdown exits 0 and leaves no stray process
  ok   32. the exposed schemas are JSON-Schema shaped and bounded
  ok   33. tool output is structured JSON, never prose
  ok   34. MCP cannot reach AccountSigner or any signing material
  ok   35. MCP cannot trigger real settlement
  ok   36. an inconclusive agent blocks commerce at the trust gate
  ok   37. audit events for a demo run are ordered and complete
  ok   38. a rejected commerce run records the rejection, not a grant

task08-mcp-interface: 38/38 passed
exit=0
```

Mapping to the 18 required regression cases: server start (27, 31) · tool discovery (27, 32) ·
valid discovery (11) · invalid discovery input (8, 10) · valid trust (11) · rejected trust
(12, 13) · inconclusive trust (36) · simulated success (19) · untrusted commerce (20, 36) ·
invalid payment (21) · forged authorization (04, 06, 28) · policy bypass (16, 20) · no real
settlement (35) · no signing material (34) · audit generation (37) · audit integrity (24, 37) ·
malformed requests (30) · TASK 02–07 suites (full run below).

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
PASS  task08-mcp-interface.test.mts                 38/38
────────────────────────────────────────────────────────────
all suites passed                                  303 tests
exit=0
```

| Command | Exit | Result |
|---|---|---|
| `npx tsc --noEmit` | 0 | no type errors |
| `npm run verify -- --token-id 1004` | 0 | `TRUSTED` |
| `task02-verify.mjs` | 0 | `VERIFIED` |
| `task04-conformance.mts` | 0 | OK |
| `task06-verify-trails.mts docs/evidence/task05` | 0 | `ALL TRAILS VERIFIED` |
| `node dist/cli/commerce.js --token-id 1004` | 0 | `access_granted`, 8 audit events |
| `node scripts/task08-demo.mjs` | 0 | all nine steps, clean shutdown (§1.5) |

---

## 11. REMAINING LIMITATIONS (see also §2, §3)

1. **Settlement is simulated.** Nothing here demonstrates a live x402 payment; no CCD
   facilitator exists for Testnet.
2. **No operator authorization channel** (§8). Prerequisite for any real payment authority.
3. **stdio only** — no HTTP/SSE, therefore no remote or multi-tenant deployment.
4. **Unauthenticated by design.** Any local process that can spawn the server can call the
   tools. Acceptable only because the tools cannot spend or mutate chain state.
5. **`badge_valid` is `NOT_TESTED`** in the default flow (hosted checker not consulted).
6. **Third-party cards vary wildly.** Dead URLs, `localhost` URLs, and re-published cards
   whose hash no longer matches all exist in the live registry. The demo tries candidates in
   order and records `fixture_used: true` when nothing live works.
7. **No request-level concurrency testing.** `AuditTrail` locking is proven for two
   concurrent writers (TASK 06.1), not for parallel tool calls.

---

## 12. ON-CHAIN STATUS

**Zero transactions.** `accountNonce 4`, `pendingNonce 4`, balance `19943.619923 CCD` —
unchanged since TASK 02. No CCD or PLT moved, no key used, no `/settle` invoked. There is no
code path in `src/mcp/*` capable of reaching a facilitator.

---

## 13. NEXT TASK (bounded)

**TASK 09 — operator authorization channel with real authentication.** Implement the
out-of-process issuance described in §8: a signed authorization over the exact terms,
verified in-gateway against a pinned operator public key, with TTL, single use, and a
non-MCP transport. Acceptance: an authorization forged in JSON is rejected; one signed by
the configured operator public key is accepted; an expired or replayed one is rejected.
