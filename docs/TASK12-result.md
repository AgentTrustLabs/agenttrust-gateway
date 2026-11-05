# TASK 12 — Repository Hygiene & Evidence Integrity

Date: 2026-11-05 · Repository maintenance. No application logic, CLI, MCP, signing, or payment code was
touched. No transaction, no key.

**Important premise correction:** `/home/ubuntu/projects/agenttrust` is **not a git repository** — there is
no `.git` directory and no parent repository. `git status --short` prints
`fatal: not a git repository (or any of the parent directories): .git`. So there is no
tracked/untracked split to clean up, and nothing is currently "in Git tracking".

Rather than fabricate a status, every Git-dependent check below was executed against a **scratch
repository populated from the real tree**, which is what a commit of this tree would actually stage. That
is stated explicitly wherever it is used, and the equivalent of "before/after `git status --short`" is given
as a staging dry run.

---

## VERIFIED

### V1 — Repository inventory (pre-change)

```console
$ find . -path ./node_modules -prune -o -path ./dist -prune -o -type f -print | wc -l
172
$ du -sh node_modules dist
275M    node_modules
500K    dist
```

Composition of the 172 non-generated files: 87 under `docs/` (15 reports + 72 evidence artifacts,
27 tests + fixtures, 20 sources, 16 scripts, **10 files in the root `evidence/` directory**, 6 in
`signing-site/`, 1 in `sign/`, plus manifests and README. `node_modules/` and `dist/` are present locally
and are pure generated output.

### V2 — `.gitignore` created and behaviour verified with real `git check-ignore`

New file `/.gitignore` (34 lines, four categories: dependencies, build output, local runtime output, local
secrets, plus editor/OS noise).

Checked in a scratch repo containing the real `.gitignore` and one file per path:

| Path | `git check-ignore` |
|---|---|
| `node_modules/pkg/index.js` | **IGNORED** |
| `dist/mcp/server.js`, `dist/cli/verify.js` | **IGNORED** |
| `.env`, `.env.local`, `.env.production` | **IGNORED** |
| `a.pem`, `a.key` | **IGNORED** |
| `npm-debug.log`, `server.log` | **IGNORED** |
| `.env.example` | tracked (must stay committable) |
| `src/a.ts`, `test/t.test.mts` | tracked |
| `docs/evidence/task02/x.json` | tracked |
| `evidence/healthz.json` | tracked |
| `sign/tx-manifest.json` | tracked |
| `signing-site/repin.json` | tracked |
| `package-lock.json` | tracked |
| `README.md` | tracked |

No blanket rule: the only extension-wide entry is `*.log`. Nothing matches `*.json`, `*.md`, `*.ts`,
`docs/`, or `evidence/`.

### V3 — Staging dry run on the real tree (the before/after status equivalent)

```console
$ tar --exclude=node_modules --exclude=dist -cf - . | (cd /tmp/gi-full && tar -xf -)
$ git init -q && git add -A
=== staged file count: 172
=== node_modules staged: 0
=== dist staged: 0
=== top-level dirs staged:
     87 docs   27 test   20 src   16 scripts   10 evidence
      6 signing-site   1 sign   1 tsconfig.json   1 package.json
      1 package-lock.json   1 README.md   1 .gitignore
```

Before: no repository. After (if committed): 172 files staged, zero generated artifacts, zero evidence
lost. Diff of the file list before vs. after staging: **empty** —
`comm -23 before after` and `comm -13 before after` both produce no output, so nothing disappeared and
nothing new crept in except the intended `.gitignore`.

After adding `test/task12-repo-hygiene.test.mts` and `docs/TASK12-result.md` the count is 174.

### V4 — Clean-clone reproducibility

```console
$ git ls-files | wc -l                          → 173
$ git ls-files | grep -c '^node_modules/'       → 0
$ git ls-files | grep -c '^dist/'               → 0
$ rm -rf .git && npm ci                          → exit 0
$ npm run build                                  → exit 0   (dist/mcp/server.js, dist/cli/verify.js present)
$ npm test                                       → exit 0, all suites passed
$ npm run typecheck                              → exit 0
```

A clone of exactly the tracked set installs, builds, tests and type-checks with no manual step. The
lockfile is intact (unchanged; never edited in this task).

### V5 — Full suite and application behaviour unchanged

```console
$ npm test    → exit 0   17 suites, 342 tests, all passed
```

Previously 16 suites / 331 tests; the delta is exactly the new `task12-repo-hygiene` suite (11).

| Command | Exit |
|---|---|
| `node dist/cli/verify.js --token-id 1004` | **0** (`TRUSTED`) |
| `node dist/cli/commerce.js --token-id 1004 --out …` | **0** (`access_granted`) |
| `node dist/cli/index.js` (no `--owner`) | **1** (usage) |
| `node scripts/task08-demo.mjs --out …` | **0** (9 steps) |

### V6 — Evidence inventory intact

82 evidence artifacts, all still on disk and non-empty: 72 under `docs/evidence/` (task02 ×12, task03 ×13,
task04 ×8, task05 ×8, task06 ×25, task07 ×4, task08 ×2) and 10 under `evidence/`. Every `.json` parses
**except** `docs/evidence/task06/tamper/10-checkpoint-corrupted/audit-trail.jsonl.checkpoint.json`, which
is corrupt **on purpose** — it is the TASK 06 fixture proving corrupt-checkpoint detection. The regression
test exempts that one path by name rather than weakening the check for everything.

---

## FINDINGS

### F9 — No `.gitignore` (from TASK 09) · **RESOLVED**

`node_modules/` (275 MB) and `dist/` sat in the tree with nothing excluding them, so any `git add -A`
would have committed both. Fixed with the minimal file above, verified by `git check-ignore` rather than
by reading the patterns back.

No tracked-file cleanup was required: the project has no `.git`, so nothing generated is currently tracked.
The staging dry run confirms that a first commit stages zero files from `node_modules/` or `dist/`.

### F12a — Root `evidence/` directory (10 files) · **RETAINED as historical evidence**

Files: `badge-check-mainnet.json`, `contract-info-mainnet.json`, `contract-info-testnet.json`,
`healthz.json`, `indexer-status.json`, `indexer-testnet-agents.json`, `mcp-openapi.json`,
`mcp-tools-list.json`, `network-status-mainnet.json`, `network-status-testnet.json`.

Reference search across `docs/`, `src/`, `scripts/`, `test/` (`grep -rl <name>` excluding the directory
itself): **zero** of the ten filenames appears in any report, script, or test. Only the string `healthz`
appears, and that is the MCP endpoint path in `src/registry/mcpClient.ts:84` and
`src/core/types.ts:8,25` — unrelated to the file.

Disposition: these are **TASK 01 reconnaissance dumps** (registry `contract_info`, indexer status, network
status, the MCP `tools/list` and `openapi.json` captured before the schema was pinned). They are the raw
inputs behind `docs/TASK01-feasibility.md` §1, which cites those very endpoints at
`docs/TASK01-feasibility.md:18,245`. Unreferenced ≠ orphaned: they are the only record of what the
registry advertised at TASK 01 time, and `network-status-*.json` carries a block height that cannot be
re-derived. Per the task's own rule — do not delete files based only on location, do not delete historical
evidence because it is old — they stay. `.gitignore` does not touch `evidence/` (verified above).

Recorded limitation: they are *not currently discoverable*, because no document points at them. Left as-is
rather than editing historical reports; noted here so the next reader can find them.

### F12b — `sign/tx-manifest.json` placeholder · **RETAINED, now labelled**

Content: an unfilled TASK 02 template whose `parameterHex`, `metadataHashHex`, `agentUri` and `cardJson`
are literal `*_REPLACE` markers.

Dependency search:

- **Writers:** none. `grep -rn "tx-manifest" scripts/ src/ test/` → no hits outside this report.
- **Readers:** none. The signing page loads `./registration.json`
  (`signing-site/index.html:72`), not this file; no script and no page references it.
- **Live equivalent:** `signing-site/registration.json`, written by
  `scripts/build-signing-manifest.mjs:52`.

So it is an **unused placeholder in no active workflow**, and TASK 09 quoted it verbatim
(`docs/TASK09-READINESS-REVIEW.md:328`). Deleting it would destroy an artifact that a historical report
discusses; the task allows removal only after confirming no active dependency, and prefers labelling if
retained.

Disposition: **retained and labelled**, with two additive keys only:
`_status: "PLACEHOLDER — UNUSED"`, `_note` (explains every remaining value is an unreplaced marker and that
the file must not be fed to a wallet), `_superseded_by: "signing-site/registration.json"`. **No transaction
data was inserted, and no `*_REPLACE` marker was replaced with a fabricated value** — the original four
markers are byte-identical and a test asserts that.

### Related observations (recorded, not acted on)

- **No `.git` anywhere.** The tree is a working directory, not a checkout. Any statement about
  "tracked files" would have been fiction, hence this report's scratch-repo method. Creating a repository
  is out of scope.
- `signing-site/` (6 files, incl. `captured-tx.json` from the TASK 02 signing run) is **active**: the pages
  are served by `scripts/signing-server.mjs` and the JSON files are written by the TASK 02 scripts. Kept.
- `dist/` and `node_modules/` remain on disk locally (needed to run anything) and are now ignored.

---

## Changes

| File | Change |
|---|---|
| `/.gitignore` | **new** — 34 lines, four categories, no blanket rules |
| `sign/tx-manifest.json` | added `_status`, `_note`, `_superseded_by`; all original values and all four `*_REPLACE` markers untouched |
| `test/task12-repo-hygiene.test.mts` | **new** — 11 tests (ignore behaviour via real `git check-ignore`, staging dry run, evidence inventory, placeholder labelling, no active reference) |
| `docs/TASK12-result.md` | **new** — this report |

No source, test expectation, lockfile, script, or historical report was modified. `git status`-equivalent
before/after is V3.

---

## NOT TESTED

- **Actual `git status --short` on this repository** — impossible, there is no `.git`. Executed against a
  scratch repository instead and labelled as such throughout.
- **Removal of historically tracked generated files** (`git rm --cached`) — not applicable, nothing is
  tracked.
- **A real remote clone** (`git clone <url>`). Simulated by staging the tree, deleting `.git`, and running
  `npm ci && npm run build && npm test` from the same filesystem.
- **`.gitignore` interaction with a global `core.excludesFile`.** The checks ran with the host's global
  config, which contains no exclude file; a machine with one could behave differently.

## BLOCKED

Nothing. No on-chain activity: `nonce 4`, `pending 4`, `19943.619923 CCD`, unchanged. No key used, no
signing.

---

## FINAL VERDICT

**PASS — repository hygiene and evidence integrity are accounted for.**

- Generated artifacts are excluded by a verified `.gitignore`; a staging dry run of the whole tree stages
  **0** files from `node_modules/` or `dist/` and loses **0** files overall (before/after list diff is
  empty).
- No tracked-file surgery was needed, because the project is not a git repository — stated plainly instead
  of inventing a status.
- All 82 evidence artifacts are retained; the one unparseable file is a deliberate TASK 06 tamper fixture
  and is exempted by name, not by weakening the rule.
- The root `evidence/` set is unreferenced but is genuine TASK 01 reconnaissance output with
  non-reproducible data (block heights, advertised schemas); retaining it follows the task's own rule
  against deleting by location or age.
- The `sign/tx-manifest.json` placeholder is confirmed unused by any writer, reader, script, test, or page,
  and is now labelled with its status and its live replacement — with its original markers intact and no
  fabricated data.
- `npm ci` → `npm run build` → `npm test` (342 tests) → `npm run typecheck` all pass from the tracked set
  alone, and CLI/MCP/demo behaviour is unchanged.
