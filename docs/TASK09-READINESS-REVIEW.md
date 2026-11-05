# TASK 09 — Final Repository Readiness Review

Date: 2026-11-05 · **Review and validation only. No features added, no code fixed, no tests altered.**

Method: every claim below was produced by running the documented command in a **clean copy of the
tree without `node_modules/` or `dist/`**, mirroring what an external evaluator gets. Where the
repository's own docs make a claim, it is compared against observed behaviour and the discrepancy is
reported rather than patched.

Clean-copy path used throughout: `/tmp/t09`, `/tmp/t09clean` (`tar --exclude=node_modules
--exclude=dist`, then `npm ci`). Host: Linux, Node **v26.7.0** / npm **11.19.0**; secondary Node
**v22.23.3** at `/usr/bin/node`.

---

## VERIFIED

### V1 — Clean dependency installation

```
$ npm ci
…
npm warn install-scripts 2 packages have install scripts not yet covered by allowScripts:
npm warn install-scripts   esbuild@0.23.1 (postinstall: node install.js)
npm warn install-scripts   protobufjs@7.6.6 (postinstall: node scripts/postinstall)
exit 0

$ npm ls --depth=0
agenttrust@0.1.0
├── @concordium/web-sdk@12.0.2
├── @x402/concordium@2.29.0
├── @x402/core@2.29.0
├── tsx@4.19.0
└── typescript@5.7.3
```

`package-lock.json` is `lockfileVersion 3`, 93 package entries, and pins exactly the five deps above.
Install is reproducible with `npm ci`. No dependency was upgraded or replaced during this review.

### V2 — Type checking

```
$ npx tsc --noEmit      → exit 0   (no diagnostics, clean copy)
$ npx tsc               → exit 0   (emits dist/, 3 CLI + 6 mcp + audit/commerce/payments modules)
```

### V3 — Full test suite

```
$ npm test              → exit 0
PASS finding-1-faucet.test.mjs                  6/6
PASS finding-2-account-derivation.test.mjs      7/7
PASS finding-3-agent-card.test.mjs             11/11
PASS finding-4-wallet-serialization.test.mjs   10/10
PASS regression-bytes.test.mjs                  9/9
PASS task03-cli-contract.test.mts              11/11
PASS task03-discovery-and-trust.test.mts       47/47
PASS task04-sdk-conformance.test.mts           15/15
PASS task04-x402-exact.test.mts                44/44
PASS task05-commerce.test.mts                  36/36
PASS task06-audit-integrity.test.mts           25/25
PASS task06.1-lock-hardening.test.mts          14/14
PASS task07-facilitator-readiness.test.mts     30/30
PASS task08-mcp-interface.test.mts             38/38
all suites passed   — 303 tests
```

Re-run under the system Node: `/usr/bin/node test/run.mjs` (v22.23.3) → **exit 0, 303 tests**. The
`engines: node >=20` floor is therefore plausible across two majors, though 20 itself was not available
(see NOT TESTED).

### V4 — CLI entry points and exit codes

Run from the clean copy with the compiled inputs present:

| Command | Exit | Observed |
|---|---|---|
| `node dist/cli/verify.js --token-id 1004` | **0** | `TRUST DECISION  TRUSTED`; local sha256 `3f614404…` == on-chain sha256; `transactions 0 (read-only)` |
| `node dist/cli/verify.js --token-id 1004 --expect-owner 3whdie…CvajR8` | **1** | owner mismatch → rejected |
| `node dist/cli/verify.js --bogus-flag` | **3** | `unknown flag: --bogus-flag` + usage |
| `node dist/cli/verify.js` | **3** | `one of --token-id or --q is required` + usage |
| `node dist/cli/verify.js --token-id abc` | **3** | `--token-id must be an integer, got NaN` |
| `node dist/cli/verify.js --help` | **0** | usage only |
| `node dist/cli/commerce.js --token-id 1004` | **0** | `stage access_granted`, `settlement SIMULATED — not on chain`, 8 audit events |
| `node dist/cli/commerce.js --token-id 1004 --expect-owner 3whdie…` | **1** | `trust_rejected` |
| `node dist/cli/commerce.js --token-id 1004 --facilitator reject` | **2** | `payment_rejected` |
| `node dist/cli/commerce.js --nope` | **3** | usage |

Exit-code contract (0 granted / 1 trust rejected / 2 payment rejected / 3 usage) holds exactly as
documented in `src/cli/commerce.ts` and `src/cli/verify.ts` headers. No registration, signing, or
transaction was attempted.

### V5 — MCP server: init, protocol version, tools/list, stream hygiene, shutdown

```
$ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
                '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | AGENTTRUST_AUDIT_ROOT=/tmp/t09audit node dist/mcp/server.js
exit=0   stdout lines=2   stderr bytes=0

protocolVersion: 2024-11-05
serverInfo: {'name': 'agenttrust-gateway', 'version': '1.0.0'}
tools: ['registry.search', 'registry.card', 'trust.verify',
        'trust.policy', 'commerce.simulate', 'audit.verify']
```

Every stdout line parsed as JSON; **stderr empty**; the process exited 0 on stdin close. Boundary
listening sockets: none — the server only reads stdin (`src/mcp/server.ts`), so it was not and cannot be
exposed over a network by this code.

Representative read-only tools, same transport:

```
id 2 registry.search  → {'tool': 'search_agents', 'returned': 1}   token 1004
id 3 trust.verify     → TRUSTED, reasons []
id 4 commerce.simulate→ access_granted, settled=False,
                        calls ['verify','settle'], audit events 8
id 5 audit.verify     → ok=True, events=8, problems=[], checkpoint count=8 matches=True
```

### V6 — Demo reproducibility (TASK 08)

In the clean copy, after emitting with `npx tsc`:

```
$ npx tsc && node scripts/task08-demo.mjs --out /tmp/t09evidence
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
EXIT 0
```

Evidence cross-check on the produced `demo-results.json`:

- `on_chain_transactions: 0`, `real_settlement: false`, `settlement_kind: "MOCK"`
- `commerce.settled: false`, `commerce.facilitator: "mock"`
- `simulated_transaction` carries the note *"Derived locally from payTo:amount:asset. NOT a chain hash,
  never submitted."*
- grep for `confirmed on chain`, `block explorer`, `ccdscan`, `txhash confirmed` → **none present**
- all three audit verifications `ok: true`, checkpoints `matches: true`

No simulated settlement is represented anywhere as an on-chain transaction.

### V7 — Documentation matches behaviour (where it does)

| Claim | Where | Verified |
|---|---|---|
| Six MCP tools, named as listed | `docs/MCP-GUIDE.md` §4, `docs/TASK08-result.md` §5 | exact match with `tools/list` |
| TRUSTED / REJECTED / INCONCLUSIVE semantics; `NOT_TESTED` is not consent | `docs/MCP-GUIDE.md` §6 | matches `src/verify/crossAgent.ts` `decideTrust` + `src/commerce/trustPolicy.ts` |
| Settlement is mock; `settled: false`; disclaimer text | `docs/MCP-GUIDE.md` §7 | string is byte-identical to `SIMULATION_DISCLAIMER` in `src/commerce/simulation.ts` |
| No CCD facilitator; `NO_CCD_NETWORK` | `docs/TASK07-result.md` §4 | re-probed today: `outcome reachable | usable False | code NO_CCD_NETWORK`, 9 networks, 0 `ccd:` |
| No operator authorization over MCP | `docs/MCP-GUIDE.md` §8 | matches `REJECTED_FIELDS` in `src/mcp/tools.ts:81-117` |
| `AGENTTRUST_REGISTRY_MCP` / `AGENTTRUST_AUDIT_ROOT` are the only env vars | `docs/MCP-GUIDE.md` §3 table | matches `src/mcp/server.ts` (two `process.env` reads) |
| Test count | `docs/TASK08-result.md` §10 | 303 observed |

---

## NOT TESTED

- **Node 20 exactly.** Only 22.23.3 and 26.7.0 are installed. `engines: ">=20"` is plausible — no
  `toSorted` / `toReversed` / `Object.groupBy` / `import.meta.dirname` / `findLast` / `withResolvers`
  usage was found in `src test scripts` — but the floor itself was not executed.
- **Offline test run.** The suite needs no network by inspection (all `fetch` calls are injected mocks;
  no test imports a live host), but it was not executed with networking disabled.
- **A third-party MCP host UI** (Claude Desktop, Cursor, Continue). Only a written JSON-RPC client and
  the in-repo demo client were used.
- **HTTP/SSE transport.** Not implemented; out of scope by design.
- **npm 7/8/9.** Only npm 11.19.0 was used against the v3 lockfile.

---

## BLOCKED

Nothing in scope required unavailable credentials or infrastructure. One item is inherently
unverifiable here and is recorded as a limitation rather than worked around: **real x402 settlement**
(no CCD facilitator exists; TASK 07 §1). No workaround was invented.

---

## FINDINGS

Ordered by impact on an external evaluator. **None of these were fixed** — this is a review task.
Line references are to the current tree.

### F1 — HIGH · `npm run build` produces no output, breaking the documented setup path

`package.json:20` → `"build": "tsc --noEmit"`. `--noEmit` writes nothing.

```console
$ npm ci && npm run build      # exactly what docs/MCP-GUIDE.md:29 prescribes
$ npm run build                → exit 0
$ ls dist                      → "ls: cannot access 'dist': No such file or directory"
$ node dist/mcp/server.js      → Error: Cannot find module '…/dist/mcp/server.js'
```

`docs/MCP-GUIDE.md:29` states *"This repository built: `npm install && npm run build`"*, and
`:40-41` then instructs `npm run build` followed immediately by `node dist/mcp/server.js`. On a clean
clone that sequence fails. `docs/MCP-GUIDE.md:286` (`npx tsc`) is correct, so the demo section works
while the setup section does not — the inconsistency is internal to one document.

Blast radius: `npm run verify` / `commerce` / `mcp` all use `tsc && …` and therefore *do* emit; only
`build` and the `setup` instructions are affected.

### F2 — HIGH · `npm test` fails on a clean clone until something emits `dist/`

```console
$ npm ci && npm test           → exit 1
FAIL task08-mcp-interface.test.mts  task08-mcp-interface: 33/38 passed
   FAIL 27/28/29/30/31 — "no output; stderr: node:internal/modules/cjs/loader:1573"
$ npx tsc && npm test          → exit 0, 38/38, all suites passed
```

Five MCP transport tests (`test/task08-mcp-interface.test.mts:675,691` and the graceful/stream tests)
spawn `node dist/mcp/server.js`, so the suite has an **undeclared build prerequisite**. The runner
header (`test/run.mjs:7`) says *"No network, no chain, no MCP"*, which is no longer accurate — the
suite now depends on the compiled MCP server. No docs state that `npx tsc` must run before `npm test`.

### F3 — HIGH · Demo exits 0 silently when `dist/` is missing (false success)

`scripts/task08-demo.mjs:37` spawns the server with **no `error` handler**, and `request()`
(`:62-68`) awaits a promise with **no timeout**. If the child dies, the promise never settles, Node's
event loop empties, and the process exits 0 having printed nothing.

```console
$ rm -rf dist && timeout 20 node scripts/task08-demo.mjs --out /tmp/x5
EXIT=0          # not 124: it exited on its own
stdout bytes: 0   stderr bytes: 0   evidence files: 0
```

An evaluator following a stale instruction sees a green exit code and no evidence, which is the exact
failure mode that makes a demo look broken-but-passing. The in-repo demo works when `dist/` exists
(V6); this is purely the missing-input path.

### F4 — MEDIUM · Dead npm script: `sign`

`package.json:28` → `"sign": "node dist/sign/sign-from-json.js"`. There is no `src/sign/`, so the
target cannot exist.

```console
$ npm run sign → Error: Cannot find module '…/dist/sign/sign-from-json.js'
```

### F5 — MEDIUM · `package.json` `exports` points at a file that does not exist

`package.json:7-10` declares `"."` → `./dist/index.js` / `./dist/index.d.ts`. There is no
`src/index.ts`.

```console
$ node -e "import('agenttrust')"        → ERR_MODULE_NOT_FOUND
$ node -e "…existsSync('dist/index.js')" → false
```

Any programmatic consumer hits this first. The README-less tree gives no hint that the package is
CLI/MCP-only.

### F6 — MEDIUM · `bin` entries are not linked, and the main CLI is name-gated into silence

`npm ci` on the root project does **not** create self-links: `node_modules/.bin` contains only
`esbuild proto-loader-gen-types tsc tsserver tsx uuid` — no `agenttrust*`. The four declared bins are
reachable only after `npm link` or a global install, neither of which is documented.

Compounding it, `src/cli/index.ts:180` executes only when `process.argv[1]?.includes('agenttrust')`:

```console
$ node dist/cli/index.js                       → exit 0, no output
$ node dist/cli/index.js --owner 4dWn8mi…      → exit 0, no output
$ node /tmp/agenttrust-x/dist/cli/index.js     → ERR_MODULE_NOT_FOUND (needs the package root)
$ ln -s …/dist/cli/index.js /tmp/bin/agenttrust && node /tmp/bin/agenttrust
  → Usage: agenttrust --name "Name" …            (only this form works)
```

So the entry point an evaluator is most likely to try is a silent no-op that exits 0.

### F7 — MEDIUM · No README at the repository root

`ls` shows no `README.md` / `README`. `docs/MCP-GUIDE.md` is the de-facto entry point but nothing at
the root points to it, and `docs/TASK09-READINESS-REVIEW.md` is not discoverable from the tree either.
An external evaluator's first action — open the repo, read the README — has no landing page.

### F8 — MEDIUM · No LICENSE, and `private: true` is undocumented

No `LICENSE` / `COPYING` file; `package.json` has no `license` field and sets `"private": true`
(`package.json:4`). The code is therefore "all rights reserved" by default and cannot be `npm
publish`ed. Acceptable for a hackathon submission, but §2 of `docs/MCP-GUIDE.md` (Requirements) never
says so.

### F9 — MEDIUM · No `.gitignore`; `node_modules/` and `dist/` are present in the tree

```
$ du -sh node_modules dist
275M    node_modules
500K    dist
```

Nothing excludes them, so a `git add -A` would commit 275 MB of dependencies and a stale build. This is
also why the repository cannot be evaluated as a clean checkout without a manual exclusion — this
review had to `tar --exclude=node_modules --exclude=dist` to approximate a clone.

### F10 — MEDIUM · `docs/MCP-GUIDE.md:6` claims the guide is offline-safe; its own §2 contradicts it

`:6` — *"**Everything in this guide is offline-safe.**"*
`:30-31` — *"Outbound HTTPS for the live registry + agent card fetch … the demo needs the network for
steps 1–4."*

The second statement is correct (V6 required live network for steps 1–4); the first overstates it.

### F11 — MEDIUM · `docs/MCP-GUIDE.md` omits the audit trail's actual trust-model limitation

The guide describes the trail as *"hash-chained, checkpointed, lock-protected"* (`:213`) and lists
seven limitations (`:262-282`) — none of which is the audit limitation. `docs/TASK06-result.md` §6-§7
is explicit: the checkpoint sits beside the log on the same filesystem, so **a consistent rewrite of
log + checkpoint is undetectable**; there is no external anchor. A reader of the guide alone would come
away with a materially stronger impression than the implementation supports. This is the one
"misleading claim" in the documentation set, and it is an omission rather than a false statement.

### F12 — LOW · Orphan artifacts at the repository root

- `evidence/` (9 files, TASK 01 registry/network probings) sits beside `docs/evidence/` and is
  referenced by **no** document (`grep -rn 'evidence/' docs/*.md` → no hits).
- `sign/tx-manifest.json` contains literal unfilled placeholders: `"PARAM_HEX_REPLACE"`,
  `"METADATA_HASH_REPLACE"`, `"AGENT_URI_REPLACE"`, `"CARD_JSON_REPLACE"`.
- `signing-site/` retains a one-shot wallet-signing page plus `captured-tx.json` from TASK 02. It is
  inert (no key, wallet does the signing) but it is a page that asks a browser wallet to sign, left in
  a repository whose stated posture is "the gateway cannot sign".

These are not defects in behaviour; they invite the wrong questions during review.

### F13 — LOW · `scripts/probe-agent-account.mjs:45` prints a private key to stdout

```js
  privateKeyHex: privRaw.toString('hex'),
```

The key is ephemeral (generated at `:27`, never persisted, never funded) and the script is a TASK 02
investigation artifact, so the risk is nil. It still reads badly in a repo whose security story is "no
key material anywhere", and it would be the first file a reviewer greps for.

### F14 — LOW · Setup prerequisites are incomplete

`docs/MCP-GUIDE.md` §2 lists Node ≥ 20 and "built". Not documented: `npm ci` versus `npm install`
(only a lockfile-backed `npm ci` is reproducible), the fact that the working tree currently requires
`npx tsc` before `npm test` (F2), or that the four `bin` names require `npm link` (F6). No `.nvmrc`
and no `packageManager` field, so the npm major is unspecified even though the lockfile format is v3.

### F15 — LOW · Audit root is shared by default

`AGENTTRUST_AUDIT_ROOT` defaults to `/tmp/agenttrust-audit` (`src/mcp/tools.ts:66`, `LIMITS.auditRoot`). On a multi-user host, any local user who can run the server can `audit.verify` any other
run's trail in that directory. Documented as a default but not stated as a multi-tenant hazard;
`docs/MCP-GUIDE.md` §8 says "unauthenticated" without naming this consequence.

### Non-findings (checked, correct)

- Test count 303 matches `docs/TASK08-result.md` §10 exactly.
- No secrets, credentials, or 64-hex key material in any file outside `docs/evidence/` and test
  fixtures, where every occurrence is a public card SHA-256 or transaction hash (spot-checked: the 64-hex
  hits in `scripts/task02*.mjs`, `scripts/task03-verify.mts`, `signing-site/repin.json` are all public
  hashes).
- `DENY_ALL_FACILITATOR` is intact; `src/mcp/*` still imports no Concordium SDK and names no
  `AccountSigner` (`npm test` test 34 green).
- Zero on-chain transactions during this review: `nonce 4`, `pending 4`, balance `19943.619923 CCD`,
  unchanged from TASK 02.

---

## FINAL VERDICT

**READY WITH LIMITATIONS.**

Reproducible core: `npm ci` → `npx tsc` → `npm test` (303/303) → CLIs with the documented exit codes →
MCP server speaking the documented protocol with clean streams → demo reproducing all nine steps with
simulated settlement correctly labelled. The architecture is coherent, the business logic is genuinely
shared (no MCP-local copies), and the security boundaries are enforced by tests rather than asserted by
prose.

What keeps it from plain **READY** — all four are documentation/packaging defects, not behaviour:

1. **F1** — the documented `npm run build` emits nothing, so the documented setup sequence dead-ends.
2. **F2** — `npm test` fails on a clean clone until `npx tsc` has run; the prerequisite is stated
   nowhere, and `test/run.mjs:7` denies it.
3. **F3** — the demo returns exit 0 with no output and no evidence when `dist/` is missing.
4. **F7/F8/F9** — no root README, no LICENSE, no `.gitignore`; 275 MB of `node_modules` in the tree.

None of these require a code redesign, which is why the verdict is not **NOT READY**. The single most
valuable pre-submission change is F1+F3 together: make `build` emit and make the demo fail loudly, then
the entire documented path works end-to-end from a clean checkout. F7 (a root README pointing at
`docs/MCP-GUIDE.md` and `docs/TASK08-result.md`) is the cheapest possible improvement for an external
evaluator.

Blocked items remain blocked and are unchanged by this review: real x402 CCD settlement (no facilitator)
and the operator authorization channel.
