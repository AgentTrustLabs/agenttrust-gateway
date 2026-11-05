# TASK 03 — Read-Only Discovery & Independent Cross-Agent Verification

Date: 2026-11-05 · Network: **Concordium Testnet** (`ccd:4221332d34e1694168c2a0c0b3fd0f27`)
**Transactions performed: 0.** Every call in this task is a read.

---

## 1. Objective and methodology

Prove that a **third-party agent**, with no access to AgentTrust's registration code, can:

1. discover token 1004 through the Concordium Agent Registry,
2. retrieve and validate its Agent Card,
3. independently verify its identity, ownership and metadata against the chain,
4. reach a defensible trust decision.

### Method

The verifier (`src/verify/crossAgent.ts`) is written for the **consumer** side and imports nothing from
the registration path. It takes its truth from three places, in this order of authority:

| Rank | Source | Why |
|---|---|---|
| 1 | **Bytes fetched by this process + SHA-256 computed here** | only thing that cannot be spoofed by a hosted service |
| 2 | **Registry record** (`search_agents`, `agent_of`, `agent_by_token_address`) | the on-chain-derived index |
| 3 | **Hosted badge checker** | recorded as corroboration; never sufficient alone |

The hosted checker is deliberately **demoted**: two tests (§6) prove a TRUSTED verdict can be reached
with the checker unavailable, and that a `badge_valid: false` from the checker does not override
locally-derived evidence. The reverse is also true — the checker can never manufacture a TRUSTED verdict.

---

## 2. Registry discovery — exact procedure

### 2.1 Schema inspected at runtime, not assumed

```
POST https://agent-registry-mcp.concordium.com/mcp
{"jsonrpc":"2.0","method":"tools/list"}
```

`search_agents` schema as returned **now**:

```json
{
  "required": ["q"],
  "properties": {
    "q": { "type": "string", "minLength": 1 },
    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
    "network": { "enum": ["devnet","testnet","mainnet"] }
  }
}
```

The verifier calls `readToolSchema(toolsList, 'search_agents')` and then
`assertToolAccepts(schema, 'q')`. If the parameter were renamed, the run would **fail loudly with
`schema drift`** instead of silently returning zero results. `query` is asserted to be absent.

Saved: `docs/evidence/task03/01-tools-list.raw.json`, `02-search-agents-schema.json`.

### 2.2 Discovery calls (four independent routes)

| # | Call | Result |
|---|---|---|
| 1 | `search_agents {q:"AgentTrust", limit:10}` | `count: 1, total: 1` → token 1004 |
| 2 | `agent_by_token_address {token_address:"JyP9YLib1wYgFmztkcKJL"}` | resolves to token 1004 |
| 3 | `agent_of {token_id:1004}` | `token_id_u64: 1004`, full record |
| 4 | `is_active {token_id:1004}` | `{exists:true, status:"Active", active:true}` |

Also `get_agent_wallet {token_id:1004}` → `4dWn8miA…Zg4d`, and `contract_info` →
`cis8004 {index:12802, subindex:0}`, module `142462ff638f53b7…`.

A search for `q:"1004"` also returns the agent — token-id-as-text is a valid search key.

### 2.3 Recorded identity fields

```json
{
  "network": "testnet",
  "token_id": 1004,
  "owner_account": "4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d",
  "agent_uri": "https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json",
  "metadata_hash_hex": "3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564",
  "agent_wallet": "4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d",
  "status": "Active",
  "registered_at": "2026-11-04T23:40:17.188+00:00",
  "last_event_block": 50390177
}
```

Every field matches the TASK 02 registration. `last_event_block 50390177` is the badge re-anchor
transaction (`cb0c2ef7…`), i.e. the registry index is current to the latest update, not stale at
registration time.

---

## 3. Agent Card retrieval and validation

```
GET https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json
→ 200, content-type application/json, 2777 bytes
```

The body was written to disk **verbatim** (`08-agent-card.raw.json`) before any parsing, and the
verifier hashes the in-memory `Uint8Array` — never a re-serialised object.

Validation performed:

| Check | Result |
|---|---|
| valid UTF-8 (fatal decoder) | PASS |
| valid JSON | PASS |
| JSON is an object, not array/scalar | PASS |
| A2A v1.0 required fields (`name, description, url, version, skills`) | PASS |
| `skills` array non-empty | PASS (3 skills) |
| badge extension present by exact URI | PASS (`…/a2a-extensions/concordium-badge/v1`) |
| extension `params.tokenAddress` present & non-null | PASS |
| extension `params.owner.account` present | PASS |
| extension `params.contracts.cis8004` present | PASS |
| `registrations` array well-formed | PASS |

Card summary: A2A v1.0 agent card carrying three declared skills (identity verification, capability
discovery, payment settlement), `authentication.schemes: []`, and a Concordium badge extension whose
`params` use CAIP identifiers for every on-chain reference.

---

## 4. Independent verification results

Each value below was derived by this process. The hosted checker's answer is listed separately.

| Check | Verdict | Basis |
|---|---|---|
| `agent_discovered` | **PASS** | token 1004 present in `search_agents`, confirmed independently by `agent_of` and `agent_by_token_address` |
| `card_retrieved` | **PASS** | HTTP 200, 2777 bytes, `application/json` |
| `card_valid` | **PASS** | structure, A2A fields, badge extension all present |
| `badge_valid` | **PASS** | hosted `/v1/check-badge` → `badge_valid:true`, `issues: []` (corroboration only) |
| `hash_matches_on_chain` | **PASS** | local SHA-256 = registry `metadata_hash_hex` |
| `owner_matches` | **PASS** | card `params.owner.account` CAIP-10 == registry `owner_account` |
| `status_active` | **PASS** | registry status `Active`; `is_active` tool agrees |
| `contract_references_match` | **PASS** | `cis8004` and `cis8` CAIP-10 refs, ERC-8004 `registrations.agentRegistry`, and CAIP-19 `tokenAddress` all consistent |

### Identity comparison detail

```
badge_owner             ccd:4221332d…:4dWn8miA…Zg4d
record_owner            4dWn8miA…Zg4d
expected_owner_caip     ccd:4221332d…:4dWn8miA…Zg4d    → PASS

cis8004                 ccd:4221332d…:12802.0
expected_cis8004        ccd:4221332d…:12802.0          → PASS
cis8                    ccd:4221332d…:12801.0
expected_cis8           ccd:4221332d…:12801.0          → PASS

token_address           ccd:4221332d…/cis-2:JyP9YLib1wYgFmztkcKJL
registration_entry      {agentId:1004, agentRegistry:"ccd:4221332d…:12802.0"}   → PASS
```

### Hosted checker cross-check (corroboration)

`GET /v1/verify-agent-card/JyP9YLib1wYgFmztkcKJL` → `match: true`,
`fetched.sha256_hex: 3f614404…` (independent fetch by the service, same digest).
`GET /v1/check-badge/JyP9YLib1wYgFmztkcKJL` → `badge_valid: true`, `issues: []`, all 15 internal
checks green.

Both agree with the local result. This agreement is recorded, not relied upon.

---

## 5. Local cryptographic verification — exact procedure

```
algorithm        SHA-256
input            the exact byte sequence of the HTTP response body at agent_uri
input length     2777 bytes
normalisation    NONE — no JSON.parse, no re-serialisation, no whitespace trim,
                 no Unicode normalisation, no key sorting, no trailing-newline handling
local digest     3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
on-chain digest  3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564
verdict          MATCH
```

### Canonicalisation assumptions — stated explicitly

The CIS-8004 `metadata_hash` is defined as the SHA-256 of the **card bytes as published**. There is no
canonical JSON form (no JCS/RFC 8785, no sorted keys, no compact form). Consequences, each proven by a
test:

- Re-serialising the parsed object to compact JSON produces a **different** digest → `FAIL`.
- Appending a single `\n` produces a **different** digest → `FAIL`.
- Therefore any hosting layer that reformats the file (CDN JSON minification, editor auto-format on
  save, CRLF conversion) silently breaks the anchor.

This is why the card is stored and served as an opaque byte file, and why the test suite pins both
`byteLength === 2777` and the digest itself.

Stored artefacts: `08-agent-card.raw.json` (the bytes), `10-local-sha256.json` (the procedure + result).

---

## 6. Trust decision

```json
{
  "agent_discovered": "PASS",
  "card_retrieved": "PASS",
  "card_valid": "PASS",
  "badge_valid": "PASS",
  "hash_matches_on_chain": "PASS",
  "owner_matches": "PASS",
  "status_active": "PASS",
  "contract_references_match": "PASS",
  "trust_decision": "TRUSTED"
}
```

Full JSON with evidence: `docs/evidence/task03/13-trust-decision.json`

### Reasoning

The decision is built bottom-up from bytes this process fetched itself:

1. The agent exists in the registry at token 1004 (three independent lookups agree).
2. The registry says its card lives at `…/agenttrust/.well-known/agent-card.json` with digest `3f614404…`.
3. Fetching that URL returns 2777 bytes whose SHA-256 is exactly `3f614404…` — so the served card is
   provably the one that was anchored on chain. This is the load-bearing step: it does not depend on
   the host, the MCP service, or AgentTrust's tooling.
4. The card's own claims (owner, contracts, token address) are then checked **against** the registry.
   They agree, so the card is not merely self-consistent — it is consistent with the chain.
5. Status is `Active`, so the owner has not revoked it.
6. The hosted checker independently reaches the same conclusions. Agreement raises confidence but is
   not required for the verdict.

**TRUSTED is correct here** because no required check is INCONCLUSIVE or FAIL.

### What TRUSTED means, and what it does not

It means: *this agent identity is live, owned by the stated Concordium account, and the description it
publishes is the one anchored on chain.* It says **nothing** about whether the agent actually performs
its declared skills well, behaves honestly in a transaction, or is worth paying.

---

## 7. Automated tests

`test/task03-discovery-and-trust.test.mts` — **47 tests, offline, 0 network calls.**

Coverage map:

| Area | Tests | Includes |
|---|---|---|
| Schema introspection | 4 | `q` required; `query` rejected; unknown tool; malformed `tools/list` |
| Discovery | 3 | positive; token absent; `null` / no-array / non-array payloads distinguished from not-found |
| Card retrieval | 4 | raw bytes preserved; HTTP 503; `ECONNREFUSED`; empty body |
| Card validation | 6 | valid card; non-JSON; truncated; invalid UTF-8; non-object JSON; missing A2A fields; missing badge extension; `tokenAddress: null` |
| Identity comparison | 8 | owner match; owner mismatch; missing owner; wrong contract index; wrong chain; missing `registrations`; wrong `agentRegistry`; bare token address |
| Hashing | 4 | digest match; compact re-serialisation → FAIL; trailing newline → FAIL; missing anchor → INCONCLUSIVE |
| Trust decision | 5 | all-PASS → TRUSTED; every required check FAIL → REJECTED; every required check INCONCLUSIVE → INCONCLUSIVE; NOT_TESTED; absent key |
| End-to-end | 13 | happy path; unavailable card; network error; **hash mismatch**; **owner mismatch**; not discovered (and asserts no fetch happened); revoked; missing `agent_uri`; non-JSON body; checker down; checker dissent |

Key negative-result guarantees, each asserted rather than described:

- `TRUSTED` is unreachable while any required check is `FAIL`, `INCONCLUSIVE`, or `NOT_TESTED`.
- A tampered card byte flips the verdict to `REJECTED`.
- A registry record with a different owner flips the verdict to `REJECTED` even with an otherwise
  perfect card.
- When discovery fails, the card URL is never fetched (asserted by a spy).

### CLI contract suite

`test/task03-cli-contract.test.mts` — **11 tests**, offline. Pins the behaviours the CLI maps to exit
codes: owner pinning is authoritative (a record disagreeing with `--expect-owner` is FAIL even when the
card agrees with the record), hash mismatch → REJECTED, not-discovered → INCONCLUSIVE, ambiguous name
search is surfaced rather than guessed, and **TRUSTED is unreachable when the hosted checker says valid
but the local bytes do not match**.

Suite totals across the project: **101 tests**, all passing (43 from TASK 02.1 + 47 discovery + 11 CLI).

---

## 8. Limitations

1. **Single implementation, single operator.** AgentTrust is currently the only agent verified. The
   verifier's generality across registry content it did not produce is argued from its construction
   (no registration imports, injected I/O) but not demonstrated against a foreign agent.
2. **`token_address` derivation is not re-derived.** The verifier checks the CAIP-19 *shape* and
   consistency, but does not independently recompute Base58Check `(contract, subindex, token_id) →
   address`. A tool exists (`parse_token_address`) but was not exercised in this task.
3. **Card `url` field vs `agent_uri`** are compared only implicitly: the fetch used the registry's
   `agent_uri`. The card's own `url` field is validated as present but not required to equal
   `agent_uri` (the spec permits them to differ; here they are identical).
4. **The registry index is trusted for `status`.** `status_active` comes from the indexer, cross-checked
   with `is_active`. A verifier wanting zero indexer trust would need to read contract state directly.
5. **Hosted checker availability is assumed, not guaranteed.** It answered correctly during this run;
   the tests prove its absence does not change a locally-derived verdict, but its internal 15-check
   logic was not audited.
6. **No x402 / payment evidence.** Out of scope for TASK 03.

## 9. Failures encountered

None that blocked the task. Two implementation defects were found and fixed while building the tooling:

1. `src/verify/crossAgent.ts` initially read the expected owner from a non-existent
   `expects.ownerAccount` path; corrected to a typed `ownerAccount` field on `ContractExpectation`.
2. The task runner only recognised `.test.mjs`; a `.mts` suite importing TypeScript from `src/` needed
   `tsx`. `test/run.mjs` now dispatches by extension and runs with a stable `cwd`.

Neither touched registration functionality.

---

## 10. Evidence index

| File | Contents |
|---|---|
| `01-tools-list.raw.json` | live MCP `tools/list` (40 tools + schemas) |
| `02-search-agents-schema.json` | extracted `search_agents` schema, `q` assertion |
| `03-discovery-search.raw.json` | `search_agents {q:"AgentTrust"}` response |
| `04-agent-by-token-address.raw.json` | independent resolution by token address |
| `05-agent-of.raw.json` | independent resolution by token id |
| `06-active-wallet.json` | `is_active` + `get_agent_wallet` |
| `07-contract-info.raw.json` | CIS-8004 / CIS-8 testnet coordinates |
| `08-agent-card.raw.json` | **exact 2777 bytes fetched from `agent_uri`** |
| `09-card-fetch-meta.json` | status, content-type, length for that fetch |
| `10-local-sha256.json` | hashing procedure + local vs on-chain digest |
| `11-verify-agent-card.raw.json` | hosted verifier response |
| `12-check-badge.raw.json` | hosted badge checker response |
| `13-trust-decision.json` | final structured trust result with evidence |

No credentials, keys or seed phrases appear in any artefact — asserted by the TASK 02.1 secret-material
tests, which still pass.

---

## 11. Reusable CLI

`agenttrust verify` ships as a second bin, sharing the same verification engine — no duplicated logic,
no new dependency, no new module outside `src/verify` and `src/cli`.

```
npm run verify -- --token-id 1004
# or
node dist/cli/verify.js --token-id 1004

  --token-id <n>        CIS-8004 token id
  --q <text>            discover by registry search term (alternative to --token-id)
  --expect-owner <addr> optional: require this base58 owner on the registry record
  --network <net>       testnet | mainnet | devnet   (default: testnet)
  --mcp <url>           registry MCP base URL
  --json                print only the trust result JSON
  --quiet               suppress progress output
  --no-badge-check      skip the hosted badge checker (local evidence only)
```

Exit codes are the machine contract: `0` TRUSTED · `1` REJECTED · `2` INCONCLUSIVE · `3` usage or
transport error.

Nothing is hardcoded. The token address, owner, contract coordinates and anchor hash are all read from
the live registry during the run — a cache or a baked-in constant cannot produce a verdict.

Observed behaviour (live):

| Invocation | Verdict | Exit |
|---|---|---|
| `--token-id 1004` | TRUSTED | 0 |
| `--q AgentTrust` (single match) | TRUSTED | 0 |
| `--token-id 1004 --expect-owner <correct>` | TRUSTED | 0 |
| `--token-id 1004 --expect-owner <other account>` | **REJECTED** | 1 |
| `--token-id 999999` | **INCONCLUSIVE** | 2 |
| `--q` matching 2+ agents without `--token-id` | refuses to guess | 3 |

### Verification commands and exit codes

```
$ npm test                 → exit 0   (101 tests, 7 suites, all passing)
$ npx tsc --noEmit         → exit 0
$ npx tsx scripts/task02-verify.mjs 1004 5abc7f8b…  → exit 0  RESULT: VERIFIED
$ node dist/cli/verify.js --token-id 1004 --quiet   → exit 0  TRUSTED
```

---

## 12. On-chain transaction count

**Zero.**

| Measurement | Before TASK 03 | After TASK 03 |
|---|---|---|
| account nonce | 4 | **4** |
| transaction count (CCDScan) | 5 | **5** |
| balance | 19943.619923 CCD | **19943.619923 CCD** |

The account still holds exactly the credential deployment plus the three TASK 02 updates. No
registration, no URI or metadata update, no transfer, no operator or wallet change, no sponsored
transaction.
