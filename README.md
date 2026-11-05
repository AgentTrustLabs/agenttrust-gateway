# AgentTrust Gateway

Trust and commerce gateway for independently operated AI agents on the **Concordium** blockchain.

AgentTrust lets one agent answer a question about another agent with evidence instead of trust: *is
this agent really who it claims to be, on chain, right now — and should I pay it?*

It registers an agent in the CIS-8004 Agent Registry, verifies other agents **independently** (its own
`fetch`, its own SHA-256, its own comparison against the on-chain metadata hash), applies an explicit
trust policy, runs x402 exact-CCD payment logic behind a hard settlement gate, records everything in a
hash-chained audit trail, and exposes all of it over the Model Context Protocol so any AI agent can use
it as a tool.

> **Simulated ≠ real.** Every commerce path in this repository settles with a **mock facilitator**.
> Results carry `settled: false` and a disclaimer. No transaction is signed, submitted, or recorded on
> chain. See [Simulated settlement](#simulated-settlement--read-this-before-the-demo).

---

## What works today

| Capability | Status |
|---|---|
| CIS-8004 registration on Concordium Testnet | **Real** — token `1004`, `JyP9YLib1wYgFmztkcKJL` |
| Agent Card publication + on-chain metadata hash | **Real** — 2 777 bytes, SHA-256 `3f614404…` |
| Registry discovery, card retrieval, local SHA-256 | **Real** — live registry |
| Independent trust verification (owner, badge, status, contract refs) | **Real** — `TRUSTED` on token 1004 |
| Trust-gated commerce orchestration + audit trail | **Real logic, simulated payment** |
| x402 exact-CCD payment requirements, verification, settlement gate | **Real code, no live settlement** |
| MCP server (6 tools, stdio) | **Real** |
| Live CCD settlement | **Not available** — no public CCD facilitator exists |

---

## Prerequisites

- **Node.js ≥ 22** — `engines` declares `>=20`; verified on 22.23.3 and 26.7.0. Node 20 itself was not
  executed during the readiness review.
- npm (lockfile is `lockfileVersion 3`; verified with npm 11).
- Outbound HTTPS for the live registry and Agent Card fetch. The **test suite needs no network** — every
  fetch is an injected mock.
- No API keys, no wallet, no credentials. Nothing in this repository asks for a private key or seed
  phrase, and there is no code path that could use one.

---

## Clean checkout

```bash
npm ci                 # reproducible install from package-lock.json
npm run build          # tsc — emits dist/  (type-check only: npm run typecheck)
npm test               # compiles via pretest, then runs all 12 suites
```

That is the whole setup. `npm test` builds first (`pretest`), so `npm ci && npm test` also works from a
clean checkout.

Verify the toolchain:

```bash
npm run typecheck                       # tsc --noEmit, no emit
node dist/cli/verify.js --token-id 1004 # read-only, exit 0 = TRUSTED
```

---

## Commands

| Command | What it does | Exit codes |
|---|---|---|
| `node dist/cli/verify.js --token-id 1004` | Read-only cross-agent trust verification against the **live** registry | `0` trusted · `1` rejected · `3` usage/transport |
| `node dist/cli/commerce.js --token-id 1004 --out <dir>` | Full trust-gated commerce run with a **mock** facilitator | `0` granted · `1` trust rejected · `2` payment rejected · `3` usage |
| `node dist/mcp/server.js` | MCP server over stdio (JSON-RPC 2.0) | `0` on clean shutdown |
| `node scripts/task08-demo.mjs` | End-to-end hackathon demo (9 steps) | `0` all steps pass · `3` demo/transport failure |
| `node dist/cli/index.js --owner <base58>` | Registration flow (**writes to chain** — operator wallet required) | `1` usage/error |

The four `bin` names (`agenttrust`, `agenttrust-verify`, `agenttrust-commerce`, `agenttrust-mcp`) require
`npm link` or a global install; the commands above work directly and need neither.

> There is **no signing script**. Registration signing happens in the Concordium Wallet browser
> extension, never in this process — the gateway has no `AccountSigner` and no key. A `sign` script
> existed until TASK 15 and pointed at a target that never existed; it was removed rather than faked.

---

## MCP

Full setup, tool schemas, and invocation examples: **[`docs/MCP-GUIDE.md`](docs/MCP-GUIDE.md)**.

```json
{
  "mcpServers": {
    "agenttrust": {
      "command": "node",
      "args": ["/absolute/path/to/agenttrust/dist/mcp/server.js"],
      "env": { "AGENTTRUST_AUDIT_ROOT": "/tmp/agenttrust-audit" }
    }
  }
}
```

Six tools: `registry.search`, `registry.card`, `trust.verify`, `trust.policy`, `commerce.simulate`,
`audit.verify`. Two environment variables exist and both are operator-side:
`AGENTTRUST_REGISTRY_MCP` and `AGENTTRUST_AUDIT_ROOT`. No MCP input can override either.

---

## Simulated settlement — read this before the demo

`commerce.simulate` and the commerce CLI run a **deterministic local mock** in place of a facilitator:

- `simulation.settled: false`, `simulation.facilitator: "mock"`
- `receipt.simulated_transaction` is derived locally from `payTo:amount:asset`. **It is not a chain
  hash, not a block-explorer reference, and was never submitted.**
- Every result carries: *"SIMULATED settlement: no transaction was signed, submitted, or recorded on
  chain."*

`access_granted` therefore means **"the trust gate and the payment gate both passed in a simulation"** —
nothing more.

### Why settlement is not real

There is **no publicly reachable CCD x402 facilitator** for `ccd:4221332d34e1694168c2a0c0b3fd0f27`.
Every plausible Concordium facilitator hostname resolves to NXDOMAIN, and the public
`x402.org/facilitator` advertises nine networks — none of them `ccd:`. This was verified directly, twice,
in [TASK 07](docs/TASK07-result.md). Real settlement needs a facilitator that the gateway does not have
and will not fabricate.

### Why the gateway cannot sign

The gateway holds no key and never imports `AccountSigner`. TASK 07 designed a four-stage signing
boundary (authorization → signing request → out-of-process signing → settlement gate) of which only the
first and last live here. MCP clients **cannot** supply an `OperatorAuthorization`: any request carrying
authorization-shaped fields is rejected with `AUTHORIZATION_NOT_ACCEPTED`. A registered, `TRUSTED`,
badge-carrying agent identity grants no signing authority over this gateway.

---

## Trust results

| Decision | Meaning | Commerce |
|---|---|---|
| `TRUSTED` | every required check PASS | allowed |
| `REJECTED` | at least one hard check FAIL | **denied** |
| `INCONCLUSIVE` | information missing, nothing failed outright | **denied** |

Per-check verdicts are `PASS` / `FAIL` / `INCONCLUSIVE` / `NOT_TESTED`. `NOT_TESTED` is **not** consent —
`badge_valid` reports it when the hosted badge checker was not consulted, because that checker is
corroboration rather than proof.

---

## Repository layout

```
src/
  core/       network + contract constants
  registry/   Concordium Agent Registry MCP client, transaction builder
  verify/     TASK 03 independent verification (no imports from the registration path)
  payments/   TASK 04 x402 exact-CCD, TASK 07 facilitator probe + signing boundary
  commerce/   TASK 05 trust policy + orchestrator, shared mock simulation
  audit/      TASK 06 hash-chained JSONL trail, TASK 06.1 lock hardening
  mcp/        TASK 08 tool surface + stdio server
  cli/        verify / commerce / registration entry points
test/         12 suites, 300+ assertions, offline
scripts/      per-task verification + demo scripts
docs/         per-task reports, evidence, and MCP guide
```

## Documentation

| Document | Contents |
|---|---|
| [`docs/MCP-GUIDE.md`](docs/MCP-GUIDE.md) | Setup, tool schemas, invocation examples, security boundaries, demo script |
| [`docs/TASK08-result.md`](docs/TASK08-result.md) | MCP interface, security boundaries, end-to-end demonstration |
| [`docs/TASK09-READINESS-REVIEW.md`](docs/TASK09-READINESS-REVIEW.md) | Independent readiness review, findings, verdict |
| [`docs/TASK10-result.md`](docs/TASK10-result.md) | Packaging and clean-checkout fixes |
| [`docs/TASK06-result.md`](docs/TASK06-result.md) | Audit trail guarantees **and** its threat-model limits |
| [`docs/TASK07-result.md`](docs/TASK07-result.md) | Facilitator discovery, signing boundary |
| [`docs/CONCORDIUM-INTEGRATION-LESSONS.md`](docs/CONCORDIUM-INTEGRATION-LESSONS.md) | Verified vs undocumented Concordium behaviour |

## Known limitations

1. **No real settlement.** No CCD facilitator exists; nothing here proves a live x402 payment works.
2. **No operator authorization channel.** Authorization is refused at the MCP boundary by design.
3. **stdio only** — no HTTP/SSE transport, so no remote or multi-tenant deployment.
4. **Unauthenticated.** Any local process that can spawn the server can call the tools. Acceptable only
   because the tools cannot spend or mutate chain state.
5. **Audit trail is not immutable.** The hash chain detects modification, insertion, deletion, reordering
   and tail truncation — but a consistent rewrite of **both** the log and its checkpoint is undetectable,
   because the checkpoint lives beside the log with no external anchor. See
   [`docs/TASK06-result.md`](docs/TASK06-result.md) §6–§7.
6. **`AGENTTRUST_AUDIT_ROOT` defaults to `/tmp/agenttrust-audit`**, shared by all runs on the host.
7. **Third-party agent cards vary** — dead URLs, `localhost` URLs, and re-published cards whose hash no
   longer matches are all present in the live registry.

## License

No license file is included. The package is `"private": true` and is not published to npm. All rights
reserved by default — add a license before any external redistribution.

## Distribution model

This project is a **source repository with local CLI and MCP distribution**, not a public npm package:

- `"private": true` — set so an accidental `npm publish` is refused; npm treats it as non-publishable
  (the guard itself was not observable here because this host has no registry credentials — see
  `docs/TASK15-result.md` §NOT TESTED).
- No `license`, `repository`, `author`, `homepage`, or `publishConfig` is declared, so nothing implies a
  registry target that does not exist.
- No library entry point (`exports`/`main`) — the surfaces are the four `bin` commands and the stdio MCP
  server. There is no module for a consumer to `import`.
- Consumers run it from a checkout: `npm ci && npm run build`, then `node dist/…`.

`npm pack --dry-run` describes what a tarball *would* contain if publication were ever authorized:
99 files, ~173 kB packed / ~707 kB unpacked — `dist/`, `src/`, `scripts/`, `README.md`, `package.json`
only. Documentation, tests, evidence, signing sites and audit checkpoints are excluded by the `files`
allowlist in `package.json`.

Making this a public npm package would require explicit maintainer authorization plus, at minimum, a
chosen license, a `repository` URL, and a decision on whether `src/` and `scripts/` belong in the tarball.
