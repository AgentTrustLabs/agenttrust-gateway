# TASK 10 — Packaging & Clean-Checkout Reliability

Date: 2026-11-05 · Bounded reliability fix for the four defects found in
[`docs/TASK09-READINESS-REVIEW.md`](TASK09-READINESS-REVIEW.md). No features, no architecture change,
no new tools, no test expectations relaxed.

Every command below was run from a **clean copy** (`tar --exclude=node_modules --exclude=dist`, then
`npm ci`) at `/tmp/t10clean`, plus the working tree. Node 26.7.0 / npm 11.19.0.

---

## VERIFIED

### V1 — Clean checkout → install → build → test

```console
$ npm ci                                  → exit 0
$ npm run build                           → exit 0
$ ls dist/mcp/server.js dist/cli/{index,verify,commerce}.js
dist/cli/commerce.js  dist/cli/index.js  dist/cli/verify.js  dist/mcp/server.js
$ npm test                                → exit 0, all suites passed
```

And the target workflow, with no build step in between:

```console
$ npm ci && npm test                      → exit 0, all suites passed
```

`pretest: tsc` compiles before the runner starts, so the previously-undocumented `npx tsc` is gone from
the critical path.

### V2 — Type check

```console
$ npm run typecheck                       → exit 0   (tsc --noEmit)
```

`build` emits; `typecheck` does not. The two are now distinct and both documented.

### V3 — CLI entry points and exit-code contract (unchanged)

| Command | Exit | Result |
|---|---|---|
| `node dist/cli/verify.js --token-id 1004` | **0** | `TRUSTED` |
| `node dist/cli/verify.js --token-id 1004 --expect-owner 3whdie…CvajR8` | **1** | rejected |
| `node dist/cli/verify.js --bogus` | **3** | `unknown flag` + usage |
| `node dist/cli/commerce.js --token-id 1004` | **0** | `access_granted`, mock settlement, 8 audit events |
| `node dist/cli/commerce.js --token-id 1004 --expect-owner 3whdie…` | **1** | `trust_rejected` |
| `node dist/cli/commerce.js --token-id 1004 --facilitator reject` | **2** | `payment_rejected` |
| `node dist/cli/commerce.js --nope` | **3** | usage |
| `node dist/cli/index.js` (no `--owner`) | **1** | usage, no longer silent |

### V4 — MCP server

```console
$ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
                '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
                '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"trust.verify","arguments":{"token_id":1004}}}' \
  | AGENTTRUST_AUDIT_ROOT=/tmp/t10c-audit node dist/mcp/server.js
exit=0   stdout_lines=3   stderr_bytes=0

protocolVersion 2024-11-05 · agenttrust-gateway
tools: registry.search, registry.card, trust.verify, trust.policy, commerce.simulate, audit.verify
trust.verify → TRUSTED, reasons []
```

Every stdout line is a valid JSON-RPC message; stderr is empty; exit 0 on stdin close.

### V5 — Full demo from the clean copy

```console
$ node scripts/task08-demo.mjs --out /tmp/t10c-evidence
tools                6
1 discover          token 1004
2 card              2777 bytes  sha256 3f6144046d843b7b…
3 trust             TRUSTED
4 second agent      18  REJECTED  (live third-party)
6 success           access_granted  settled=false (SIMULATED)
7 trust reject      trust_rejected  facilitator calls=0
8 payment reject    payment_rejected  settled=false
9 audit verified    3/3
  forged auth       AUTHORIZATION_NOT_ACCEPTED
  shutdown          exit 0, stderr clean
DEMO_EXIT=0
evidence: demo-results.json  demo-transcript.jsonl
```

Evidence re-read: `on_chain_transactions: 0`, `real_settlement: false`, `commerce.settled: false`,
all three audit verifications `ok: true`, shutdown `{exit_code: 0, forced: false}`, stderr `(empty)`.

### V6 — The F3 regression: demo with `dist/` removed

```console
$ rm -rf dist && node scripts/task08-demo.mjs --out /tmp/t10c-miss
EXIT=3
stdout: (empty)
stderr:
DEMO FAILED: dist/mcp/server.js not found. Build first:
    npm run build      # or: npx tsc
then re-run: node scripts/task08-demo.mjs
evidence files: 0
```

Before this task the same command exited **0** with zero bytes on both streams and wrote nothing.

### V7 — `test/run.mjs` without `dist/`

```console
$ rm -rf dist && node test/run.mjs
exit=1
stderr: dist/mcp/server.js is missing — the test suite exercises the compiled MCP server.
        Run `npm run build` (or `npm test`, which builds first via pretest), then retry.
```

No suite is attempted, and the message names the artifact and the fix.

### V8 — Test suite totals

```console
$ npm test   → 15 suites, all passed, 634 assertions reported
```

Existing expectations untouched: `finding-1..4`, `regression-bytes`, `task03-cli-contract`,
`task03-discovery-and-trust`, `task04-sdk-conformance`, `task04-x402-exact`, `task05-commerce`,
`task06-audit-integrity`, `task06.1-lock-hardening`, `task07-facilitator-readiness`,
`task08-mcp-interface` all keep their original counts (6/7/11/10/9/11/47/15/44/36/25/14/30/38). The only
new suite is `task10-packaging` (14), which asserts the fixes.

---

## Changes, by finding

### F1 — `npm run build` did not emit · `package.json`

```diff
-    "build": "tsc --noEmit",
+    "build": "tsc",
+    "pretest": "tsc",
```

`typecheck`/`lint` keep `tsc --noEmit`, so the no-emit check survives under its own name.

### F2 — tests needed an undocumented build · `package.json`, `test/run.mjs`

- `pretest: tsc` makes `npm ci && npm test` work from a clean checkout.
- `test/run.mjs` gained a **preflight** that checks for `dist/mcp/server.js` and exits 1 with an
  actionable message, instead of letting five MCP suites fail one by one with `MODULE_NOT_FOUND`.
- The runner header was corrected. It previously claimed *"No network, no chain, no MCP"*; it now states
  that every fetch is an injected mock (still true — no live host is contacted) but that the MCP server
  **is** exercised as a local subprocess, and that compilation is required.

No test was skipped, weakened, or had an expectation changed.

### F3 — demo could fail silently · `scripts/task08-demo.mjs`

Five concrete holes, all closed:

| Hole | Fix |
|---|---|
| `spawn()` had no `error` handler | `proc.on('error')` → `DemoError`, rejects all pending |
| Child death left requests pending forever, so Node exited 0 | `proc.on('close')` rejects every in-flight request with the exit code |
| `request()` had no timeout | `REQUEST_TIMEOUT_MS = 30_000`, per-request timer, rejects on expiry |
| Malformed stdout was swallowed / `JSON.parse` threw uncaught | each line validated as JSON-RPC 2.0; anything else is a fatal `DemoError` |
| Success was declared without checking evidence | evidence is re-read from disk after writing, and `settled !== false` aborts |
| Shutdown was unbounded and unchecked | `SHUTDOWN_TIMEOUT_MS = 5_000`; forced kill or nonzero exit is now fatal |

Also: a **preflight** checks for `dist/mcp/server.js` before spawning, and `main()`'s catch prints
`DEMO FAILED: <reason>` to stderr and exits **3** — never 0, never silently. The success banner
(`NO REAL PAYMENT …`) is unreachable on a failure path.

Simulation semantics preserved exactly: same mock facilitator, same `settled: false`, same disclaimer,
same nine steps, same evidence schema.

### F6 — CLI entry point was a silent no-op · `src/cli/index.ts`

```diff
-if (process.argv[1]?.includes('agenttrust')) {
+// Always execute. This file is a bin entry point, not a library: gating on
+// `process.argv[1].includes('agenttrust')` meant `node dist/cli/index.js` exited 0
+// having done nothing, which is worse than a usage error.
   …
-}
```

A `#!/usr/bin/env node` shebang was added so the declared `bin` entry is executable as a file `npm link`
would install. Behaviour otherwise unchanged: missing `--owner` still prints usage and exits 1; a
successful invocation still runs the registration flow; existing exit codes are untouched.

### Documentation

- **`README.md` (new, root).** Introduces the gateway, documents prerequisites and the exact clean-checkout
  commands, summarises the six tools with a pointer to `docs/MCP-GUIDE.md`, states the simulated/real
  boundary twice (top banner and a dedicated section), and states plainly that no public CCD facilitator
  exists and real settlement is not demonstrated. Includes the audit-trail limitation, the shared audit
  root, the dead `sign` script, and the absence of a license.
- **`docs/MCP-GUIDE.md`.** §2 requirements corrected (`npm ci && npm run build`, `npm run typecheck`
  named, Node floor qualified). §3 setup replaced (`npm install` → `npm ci`, no more `--noEmit`).
  Opening claim narrowed: no key is used and no transaction is submitted, but the demo and the TASK 07
  probe do need network — the previous "everything is offline-safe" contradicted the same document's
  own §2. §9 gained two entries: the audit trail is **not immutable** (consistent rewrite of log +
  checkpoint is undetectable, no external anchor) and the default audit root is shared. §10 now states
  the demo's exit semantics.

---

## NOT TESTED

- **Node 20 exactly.** Only 22.23.3 and 26.7.0 available. `engines` still says `>=20`; the README now
  qualifies it as "verified on 22 and 26".
- **`npm link` / global install.** The four `bin` entries now point at existing files and
  `dist/cli/index.js` carries a shebang, but the linked-install path itself was not executed. The README
  documents direct `node dist/…` invocation as the supported route, which is what was verified.
- **Demo under a partially broken server** (e.g. a server that answers `initialize` then hangs). The
  30 s request timeout is in place; it was not forced to fire.
- **HTTP/SSE transport, MCP host UIs, npm 7–9.** Unchanged from TASK 09.

## BLOCKED

Nothing. As in TASK 09, real x402 CCD settlement remains blocked by the absence of a facilitator — not
by anything in this task, and not worked around.

---

## FINDINGS

Findings from TASK 09 that this task deliberately did **not** fix, because they are outside its stated
scope. Recorded so they are not mistaken for oversights:

| From | Finding | Status |
|---|---|---|
| F4 | `npm run sign` targets a non-existent `dist/sign/` | **still dead** — documented as dead in the README |
| F5 | `exports["."]` → `dist/index.js`, which does not exist | **unchanged** — package is CLI/MCP-only; README says so |
| F8 | No `LICENSE`; `"private": true` | **unchanged** — README states "all rights reserved by default" |
| F9 | No `.gitignore`; `node_modules/` (275 MB) and `dist/` in the tree | **unchanged** — out of scope; a `.gitignore` is not a source change |
| F12 | Orphan `evidence/` at root; placeholder-laden `sign/tx-manifest.json` | **unchanged** — historical artifacts, explicitly out of scope |
| F13 | `scripts/probe-agent-account.mjs:45` prints an ephemeral private key | **unchanged** — TASK 02 investigation artifact; the key is generated in-process and never funded |
| F15 | Default audit root shared across runs | **documented** in the guide §9 and README, not changed |

Two new observations from this task:

- **F16 (informational).** `dist/` is emitted by `tsc` but the CLI files are not marked executable by
  the compiler (`-rw-rw-r--`). `npm` sets the mode when it links a `bin`, so a real install is fine, but
  running `./dist/cli/index.js` directly from a raw `tsc` emit requires `chmod +x`. `node dist/cli/…`
  (the documented form) is unaffected.
- **F17 (informational).** The demo's third-party agent choice is registry-order dependent: this run
  selected token 18, the TASK 08 run selected token 19. Both were `REJECTED` for the same reason (no
  Concordium badge extension in the card). Expected behaviour, worth knowing when reading old evidence.

---

## FINAL VERDICT

**READY.**

All four target findings are fixed and each is covered by an automated regression in
`test/task10-packaging.test.mts` (14 assertions) rather than by a one-off manual check:

- `npm ci` → `npm run build` → `npm test` → `npm run typecheck` all succeed from a tree with neither
  `node_modules/` nor `dist/` (V1, V2).
- `npm ci && npm test` alone also succeeds — the hidden build step is gone (V1).
- CLI invocations produce their documented exit codes, and the entry point never exits 0 having done
  nothing (V3).
- MCP initializes, lists the same six tools, calls tools, keeps stdout clean, and shuts down cleanly (V4).
- The demo reproduces all nine steps from a clean checkout with simulation correctly labelled (V5).
- Removing `dist/` now fails visibly with exit 3, an actionable stderr line, and no evidence artifact —
  previously exit 0 with no output at all (V6, V7).

Remaining limitations are the honest ones: settlement is simulated, no facilitator exists, no operator
authorization channel exists, the audit trail is not immutable, and the packaging loose ends listed above
(dead `sign` script, dangling `exports`, no LICENSE/`.gitignore`) are documented rather than papered over.
None of them blocks the documented workflows.
