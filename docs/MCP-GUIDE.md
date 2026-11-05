# AgentTrust Gateway — MCP Setup & Hackathon Demonstration Guide

This is the operator/host-facing guide. Implementation detail and the full evidence
trail live in `docs/TASK08-result.md`.

**No key is used and no Concordium transaction is submitted by anything in this guide.**
Settlement is simulated. The gateway cannot sign. Two things do require network access:
the live registry reads in the demo (§10), and the one-time facilitator probe in §7.

---

## 1. What this is

AgentTrust Gateway exposes Concordium CIS-8004 agent trust to any MCP-capable AI agent:

- discover agents in the live Concordium Agent Registry,
- fetch and hash their Agent Cards,
- verify identity **independently** (local SHA-256 against the on-chain metadata hash),
- evaluate a trust policy,
- run trust-gated commerce with a **mock** payment path,
- verify the hash-chained audit trail the run produced.

It is a **local stdio MCP server**. No dashboard, no hosted service, no API key.

---

## 2. Requirements

- Node.js ≥ 22 (declared `>=20`; verified on 22.23.3 and 26.7.0)
- Dependencies installed and the project **compiled**: `npm ci && npm run build`.
  `npm run build` emits `dist/`; `npm run typecheck` is the no-emit check.
- Outbound HTTPS for the live registry + agent card fetch. The test suite needs no
  network (every fetch is an injected mock); the demo needs it for steps 1–4.

---

## 3. Setup

```bash
cd /home/ubuntu/projects/agenttrust
npm ci
npm run build            # tsc — emits dist/ (type-check only: npm run typecheck)
node dist/mcp/server.js  # speaks JSON-RPC on stdin/stdout
```

Environment (all optional, all operator-controlled — **never client-supplied**):

| Variable | Default | Meaning |
|---|---|---|
| `AGENTTRUST_REGISTRY_MCP` | `https://agent-registry-mcp.concordium.com` | Registry MCP base URL |
| `AGENTTRUST_AUDIT_ROOT` | `/tmp/agenttrust-audit` | Directory the server writes audit trails to, and the only place `audit.verify` will read |

### Registering with an MCP host

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agenttrust": {
      "command": "node",
      "args": ["/home/ubuntu/projects/agenttrust/dist/mcp/server.js"],
      "env": { "AGENTTRUST_AUDIT_ROOT": "/tmp/agenttrust-audit" }
    }
  }
}
```

**Cursor / Continue / any MCP client** — same shape: `command: node`,
`args: ["<abs path>/dist/mcp/server.js"]`. stdio transport, newline-delimited JSON-RPC 2.0.

> Verified: the protocol is implemented and driven by a real subprocess client.
> **Not verified:** a specific third-party host UI. If a host requires HTTP/SSE instead of
> stdio, it is unsupported (see §8).

### Manual smoke test

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
              '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | AGENTTRUST_AUDIT_ROOT=/tmp/agenttrust-audit node dist/mcp/server.js
```

Two JSON-RPC lines come back. Nothing else is ever written to stdout.

---

## 4. Tools

Six tools. Every one delegates to an existing module — no business logic lives in the
MCP layer.

### `registry.search`

Search the registry.

```json
{ "query": "AgentTrust", "network": "testnet", "limit": 5 }
```

`query` required (≤512 chars) · `network` ∈ `testnet|mainnet|devnet` (default `testnet`) ·
`limit` 1–25 (default 10).

Returns `{ query, network, registry: { tool, returned }, agents: [...] }`.

### `registry.card`

```json
{ "token_id": 1004 }
```

Returns the registry record, plus `card: { url, http_status, content_type, byte_length, sha256, body }`.
`sha256` is over the **exact bytes served**, no normalisation — compare it with the
registry's `metadata_hash_hex`.

### `trust.verify`

```json
{ "token_id": 1004, "expect_owner": "4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d" }
```

`expect_owner` is optional but **authoritative when supplied** — a registry record naming a
different owner is a hard FAIL.

Returns:

```json
{
  "trust_decision": "TRUSTED | REJECTED | INCONCLUSIVE",
  "checks": {
    "agent_discovered": "PASS", "card_retrieved": "PASS", "card_valid": "PASS",
    "badge_valid": "NOT_TESTED", "hash_matches_on_chain": "PASS",
    "owner_matches": "PASS", "status_active": "PASS",
    "contract_references_match": "PASS"
  },
  "evidence": { "hash": {...}, "identity": {...}, "card": {...} },
  "reasons": []
}
```

### `trust.policy`

```json
{ "trust_decision": "TRUSTED", "intent": "paid_resource", "policy": "strict" }
```

Explains the gate. `policy` ∈ `strict|paranoid` (default `strict`), `intent` ∈
`discovery_only|paid_resource`. The result is tagged
`verdict_source: "client_supplied"` — this tool does **not** authorize anything;
`commerce.simulate` recomputes the verdict itself.

### `commerce.simulate`

```json
{ "token_id": 1004, "amount_micro_ccd": "250000", "mode": "ok" }
```

`mode` ∈ `ok|reject|settle-fail|settle-nohash` — all four are **mock** behaviours.
`amount_micro_ccd` ≤ 1 000 000 000 (demo ceiling).

Returns `stage` (`discovery_failed|trust_rejected|requirement_created|payment_rejected|access_granted`),
`granted`, `simulation: { settled: false, facilitator: "mock", calls: [...] }`,
`receipt: { settled: false, simulated_transaction: "…" }`, and the audit summary.

### `audit.verify`

```json
{ "name": "mcp-1793…-fa3y3d.jsonl" }
```

Bare filename only — no `/`, `\`, `..`, no absolute paths. Re-resolved and prefix-checked
inside `AGENTTRUST_AUDIT_ROOT`. Returns `ok`, `events`, `problems`, `warnings`,
`checkpoint: { count, head_hash, matches }`, and a per-event `summary`.

---

## 5. Example sequence

```jsonc
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"registry.search","arguments":{"query":"AgentTrust","limit":5}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"registry.card","arguments":{"token_id":1004}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"trust.verify","arguments":{"token_id":1004}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"commerce.simulate","arguments":{"token_id":1004,"amount_micro_ccd":"250000"}}}
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"audit.verify","arguments":{"name":"<file from step 6>"}}}
```

---

## 6. Interpreting a trust result

| Decision | Meaning | Commerce |
|---|---|---|
| `TRUSTED` | Every required check PASS | allowed |
| `REJECTED` | At least one hard check FAIL | **denied** |
| `INCONCLUSIVE` | Information missing; nothing failed outright | **denied** |

Per-check vocabulary: `PASS`, `FAIL`, `INCONCLUSIVE`, `NOT_TESTED`.

- `NOT_TESTED` is **not** consent — it appears for `badge_valid` when the hosted badge
  checker was not consulted (it is corroboration only, by design).
- `hash_matches_on_chain: PASS` means the card bytes **you fetched** hash to the value the
  registry recorded. The registry is the authority; the card is the claim.
- An unknown token id is `INCONCLUSIVE` (`agent_discovered=INCONCLUSIVE`), never `TRUSTED`.
- A real third-party agent can legitimately be `REJECTED` — the demo shows this: token 19
  has a byte-exact matching on-chain hash but its card does not carry a Concordium badge
  extension, so `card_valid`, `owner_matches` and `contract_references_match` all FAIL.

---

## 7. Simulated commerce — what is and is not real

**Real:** registry discovery, card bytes, SHA-256, on-chain metadata hash comparison,
owner/status/contract checks, the trust policy decision, the audit trail (hash-chained,
checkpointed, lock-protected).

**Simulated:**
- the facilitator (a deterministic local mock),
- payment verification,
- settlement,
- the transaction identifier.

`receipt.simulated_transaction` is derived locally from `payTo:amount:asset`. It is
**not** a chain hash, **not** a block explorer reference, and it was never submitted.
Every commerce result carries `simulation.settled: false` and the disclaimer:

> SIMULATED settlement: no transaction was signed, submitted, or recorded on chain.

Why: no publicly reachable CCD Testnet x402 facilitator exists (TASK 07), and the gateway
holds no key and cannot obtain one. Treat `access_granted` as **"the trust and payment
gates both passed in a simulation"**, nothing more.

---

## 8. Security boundaries

MCP is untrusted input. Enforced before any module runs:

1. 8 KiB input cap.
2. Recursive key scan — `authorization`, `operator_authorization`, `authorization_id`,
   `issued_by`, `max_amount_micro_ccd`, `privatekey`, `seed`, `mnemonic`, `password`,
   `token`, `path`, `file`, `url`, `endpoint`, `command`, `settle`, `allow_settlement`
   are **rejected**, not ignored.
3. Closed schema per tool (`additionalProperties: false`) plus typed validators.

| Attack | Result |
|---|---|
| Forge `OperatorAuthorization` | `AUTHORIZATION_NOT_ACCEPTED` — no tool accepts or creates one |
| Redirect to another registry | `FORBIDDEN_FIELD` (endpoint/url/mcp_base) |
| Read `/etc/passwd` | `AUDIT_READ_DENIED` |
| `../` traversal | `AUDIT_READ_DENIED` |
| Force settlement | no such tool, no flag, `DENY_ALL_FACILITATOR` unchanged |
| Get an `AccountSigner` | not referenced anywhere in `src/mcp` |
| See a stack trace | errors reduced to `{code, message}`, one line |

**Possessing an agent identity, or being a trusted agent, grants no operator signing
authority.** Trust in the registry is not authority over the gateway's operator. There is
no code path by which an MCP client — trusted, verified, or otherwise — can authorize a
payment or obtain signing material.

---

## 9. Known limitations

1. **No real settlement.** No CCD facilitator exists for Testnet; nothing here proves a
   live x402 payment works.
2. **No operator authorization channel.** TASK 07's `OperatorAuthorization` has no
   cryptographic binding, so it is refused at the MCP boundary. A signed, TTL'd,
   single-use authorization over a non-MCP transport is required before settlement can be
   authorized at all.
3. **stdio only.** No HTTP/SSE transport, and therefore no remote/multi-tenant deployment.
4. **Unauthenticated.** Any local process that can spawn the server can call the tools.
   That is acceptable because the tools cannot spend money or touch chain state.
5. **`badge_valid` is `NOT_TESTED`** in the default flow — the hosted checker is
   corroboration, not proof.
6. **Third-party agents vary.** Their cards are outside our control; some are malformed,
   some point at dead URLs. The demo falls back to a controlled fixture and says so.
7. **No load testing.** `AuditTrail` locking is proven for two concurrent writers
   (TASK 06.1), not for request storms.
8. **The audit trail is not immutable.** The hash chain detects modified content, changed
   hashes, broken links, deleted/inserted/reordered events, and truncation — but the
   checkpoint lives *beside* the log on the same filesystem with no external anchor, so a
   consistent rewrite of **both** log and checkpoint is undetectable. `audit.verify`
   proves internal consistency and catches unsophisticated tampering; it is not proof the
   log was never rolled back by someone with write access. Details:
   `docs/TASK06-result.md` §6–§7.
9. **The default audit root is shared** (`/tmp/agenttrust-audit`). On a multi-user host any
   local user who can run the server can verify any other run's trail there. Set
   `AGENTTRUST_AUDIT_ROOT` per user if that matters.

---

## 10. Hackathon demonstration (≈3 minutes)

```bash
cd /home/ubuntu/projects/agenttrust
npm run build            # the demo drives dist/mcp/server.js
node scripts/task08-demo.mjs --out docs/evidence/task08
```

Exit `0` means all nine steps passed, both evidence artifacts were written and re-read,
`settled` is `false`, and the server shut down cleanly. Any failure — missing `dist/`,
server crash, malformed JSON-RPC, request timeout, missing evidence — exits `3` with a
`DEMO FAILED:` line on stderr and writes no success artifact.

Drives the real server over stdio and prints:

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
```

Narrative, in order:

1. **Discovery** — `registry.search` finds AgentTrust (token 1004) in the live registry.
2. **Card** — 2 777 bytes, SHA-256 `3f614404…` — the same value the chain records.
3. **Verification** — every required check PASS → `TRUSTED`.
4. **A second, independent agent** — token 19 from the live registry, `REJECTED` because
   its card lacks the Concordium badge extension. Real third party, real rejection.
5. **Commerce** — trust gate passes, mock payment verifies, mock settlement, access granted.
   Read the disclaimer aloud: simulated.
6. **Trust rejection** — an owner pin mismatch stops the flow *before* a payment
   requirement exists: `facilitator calls = 0`.
7. **Payment rejection** — `mode: "reject"` → `payment_rejected`, no receipt, nothing settled.
8. **Audit** — all three trails verify: 8 events for the grant, 4 for the trust rejection,
   7 for the payment rejection, each with a matching checkpoint.
9. **Boundary** — a forged authorization is refused by name.

Evidence written to `docs/evidence/task08/demo-results.json` and `demo-transcript.jsonl`.

---

## 11. Troubleshooting

| Symptom | Cause |
|---|---|
| `AUDIT_READ_DENIED` on a filename you just saw | `AGENTTRUST_AUDIT_ROOT` differs between runs |
| `UPSTREAM_ERROR: registry agent_of` | registry unreachable, or the token does not exist |
| `card_retrieved: FAIL` | the agent's `agent_uri` is dead (common for third-party agents) |
| Host sees nothing | the host is talking HTTP, not stdio |
| `TIMEOUT` | a tool exceeded 30 s (slow registry) |
