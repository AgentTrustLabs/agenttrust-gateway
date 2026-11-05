# TASK 15 — Package Metadata & Publication Readiness

Date: 2026-11-05 · Packaging preparation only. **No `npm publish`, no visibility change, no license
invented, no `private: true` removed, no repository created.**

---

## VERIFIED

### V1 — Intended distribution model, from evidence

The project is a **source repository with local CLI + MCP distribution**. Every signal agrees:

| Signal | Value | Where |
|---|---|---|
| `private` | `true` | `package.json:4` |
| `license` | absent | `package.json` |
| `repository` / `author` / `homepage` / `bugs` | absent | `package.json` |
| `main` / `module` / `types` | absent | `package.json` |
| Library surface | none — no `src/index.ts` exists | `src/` has 8 populated dirs, 3 empty ones |
| Distribution surfaces | 4 `bin` entries + stdio MCP server | `package.json:13-18` |
| Consumers | run from a checkout (`npm ci && npm run build`) | `README.md` |

The four TASK 13 enumerations found **no GitHub repository** for this code, and TASK 13's recommendation
explicitly deferred owner/name/license to the operator. Nothing in TASK 01–14 authorizes npm publication.
**Publication intent therefore cannot be verified, so `private: true` is preserved and no license was
chosen.**

### V2 — F4 resolved: the dead `sign` script is removed

```diff
-    "cli": "node --import tsx --experimental-vm-modules dist/cli/index.js",
-    "sign": "node dist/sign/sign-from-json.js"
+    "cli": "node --import tsx --experimental-vm-modules dist/cli/index.js"
```

Reasoning, recorded rather than assumed:

- No `src/sign/` exists, so the target could never be produced by `tsc`.
- No script, test, or page references a signing script; the live signing flow is the browser wallet page
  in `signing-site/`, which loads `registration.json` and posts the hash back — it never shells out.
- The gateway holds no `AccountSigner` and no key by design (TASK 07/08 security boundary). A working
  `sign` script would therefore be a capability the project has deliberately refused.
- **No replacement was fabricated.** Inventing a signing entry point to satisfy a leftover name would
  have contradicted the architecture and the TASK 11 work.

`README.md` was updated: the note no longer says "`npm run sign` is a dead script" (it is gone); it now
states plainly that there is no signing script and why.

### V3 — F5 resolved: no entry point points at a nonexistent file

The dangling `exports` map was removed:

```diff
-  "exports": {
-    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
-  },
```

`dist/index.js` never existed (no `src/index.ts`), so `import('agenttrust')` failed with
`ERR_MODULE_NOT_FOUND` (TASK 09 F5). Two honest options existed: add a library barrel, or delete a claim
that was never true. The second was chosen — adding a public API surface is a product decision this task
may not make, and there is no in-tree consumer of one.

`main`, `module`, `types`, `typings` are all absent, so there is exactly one entry-point mechanism left:
`bin`. All four `bin` targets exist after `npm run build` and carry a `#!/usr/bin/env node` shebang.

### V4 — `files` allowlist added, package contents now governed

Before this task, `npm pack` had to fall back to `.gitignore` and shipped **236 files / 1.72 MB
unpacked**, including `docs/` (90 files), `test/` (29), `evidence/` (10), `signing-site/` (6) and
`sign/` (1). That is an accidental-publication hazard, not a package.

```diff
+  "files": ["dist/", "scripts/", "src/", "README.md"],
```

After:

| Metric | Before | After |
|---|---|---|
| Files | 236 | **99** |
| Unpacked | 1 717 306 B | **707 020 B** |
| Tarball | 390 197 B | **172 681 B** |
| `docs/` | 90 | **0** |
| `test/` | 29 | **0** |
| `evidence/` | 10 | **0** |
| `signing-site/` | 6 | **0** |
| `sign/` | 1 | **0** |
| `node_modules/` | 0 | 0 |
| `.env*` | 0 | 0 |
| audit `*.checkpoint.json` | 0 | 0 |
| `npm pack` warnings | 1 (`gitignore-fallback`) | **0** |

`src/` and `scripts/` are deliberately retained: the scripts are the documented verification entry points
(`task08-demo.mjs`, `task06-verify-trails.mts`, …) and the sources make the shipped JavaScript auditable.
Both decisions are recorded as open questions in §Remaining decisions — reversing them is a one-line edit
to `files`.

### V5 — Every script points at something real

| Script | Command | Target exists | Runs |
|---|---|---|---|
| `build` | `tsc` | — | exit 0 |
| `pretest` | `tsc` | — | exit 0 |
| `test` | `node test/run.mjs` | yes | exit 0 |
| `verify` | `tsc && node dist/cli/verify.js` | yes | exit 0 |
| `commerce` | `tsc && node dist/cli/commerce.js` | yes | exit 0 |
| `mcp` | `tsc && node dist/mcp/server.js` | yes | verified via the demo's spawn |
| `typecheck` | `tsc --noEmit` | — | exit 0 |
| `lint` | `tsc --noEmit` | — | exit 0 (alias, intentional) |
| `cli` | `node --import tsx … dist/cli/index.js` | yes | runs (prints usage) |

Checked mechanically by test `F4.1`, which extracts every `dist|scripts|test|src` path from every script
and asserts existence — so a future script cannot rot silently.

### V6 — Package validation

```console
$ npm run build                                    → exit 0
$ npm run typecheck                                → exit 0
$ npm pack --dry-run                               → 99 files, 172.7 kB, 0 warnings
$ npm pack --dry-run --json                        → file list inspected (below)
$ npm test                                         → exit 0, 19 suites, 373 tests
```

Entry-point resolution and contents, asserted by `test/task15-packaging.test.mts` (13 tests):
every `bin` target is inside the tarball; `package.json` and `README.md` are included; no `docs/`,
`test/`, `evidence/`, `signing-site/`, `sign/`, `node_modules/`, `.env`, or checkpoint file ships; no
shipped text blob contains a PEM private key, a `privateKeyHex` field, or a 64-hex value outside a named
public-hash context.

That last scan is the one that matters for an accidental tarball: the shipped `scripts/` contain real
on-chain identifiers (`JyP9YLib1wYgFmztkcKJL`, `metadataHashHex: '1f001ec9…'`). Those are **public** —
the token address and the card metadata hash, both published on chain — and the test asserts each such
occurrence sits on a line that names the field it belongs to, so a future *unnamed* 64-hex value would
fail the suite.

### V7 — The packed tarball installs and its entry points run

```console
$ npm pack --pack-destination /tmp/t15pkg            → agenttrust-0.1.0.tgz (173 261 B)
$ cd /tmp/t15inst && npm i /tmp/t15pkg/agenttrust-0.1.0.tgz
                                                     → exit 0
$ ls node_modules/.bin/
agenttrust  agenttrust-commerce  agenttrust-mcp  agenttrust-verify  …
$ ./node_modules/.bin/agenttrust-verify --help       → usage, exit 0
$ echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
    | ./node_modules/.bin/agenttrust-mcp             → protocolVersion 2024-11-05, serverInfo agenttrust-gateway
$ node -e "import('agenttrust')"                     → ERR_MODULE_NOT_FOUND
```

Installed manifest carries `private: true`, `files`, `bin` and **no `exports`** — the four `bin` commands
resolve and run from a real install, and there is no module entry point to import (correctly absent).

### V8 — Local workflows still work with the new manifest

Deleting `exports` cannot break the local workflows (nothing imported the package by name). Confirmed by
running the three documented entry points after the change:

```console
$ node dist/cli/verify.js --token-id 1004        → exit 0  TRUSTED
$ node dist/cli/commerce.js --token-id 1004      → exit 0  access_granted, 8 audit events
$ node scripts/task08-demo.mjs                   → exit 0  9 steps, audit 3/3
```

---

## FINDINGS

### F4 — `npm run sign` referenced a missing target · **RESOLVED (removed)**

`package.json:29` (before) → `node dist/sign/sign-from-json.js`; no `src/sign/` exists. Removed with the
reasoning in V2. No fake signing workflow was created.

### F5 — `exports` pointed at a nonexistent `dist/index.js` · **RESOLVED (removed)**

`package.json:7-12` (before) → `"."` mapped to `./dist/index.js` / `./dist/index.d.ts`; no `src/index.ts`
exists, so `import('agenttrust')` threw `ERR_MODULE_NOT_FOUND` (reproduced in TASK 09). The map was
deleted rather than satisfied with a fabricated barrel.

Related, also fixed: `files` was absent, so `npm pack` shipped the entire repository (V4).

### F8 — `private: true`, no LICENSE, unclear intent · **RESOLVED (policy made explicit, not changed)**

- `private: true` **preserved**. Publication was not authorized, so it was not removed.
- **No license chosen and no LICENSE file created.** TASK 01–14 contain no explicit license
  specification — only observations that none exists (`docs/TASK09-READINESS-REVIEW.md:288`,
  `docs/TASK10-result.md:234`, `docs/TASK13-result.md:209`). Inventing one, or defaulting to MIT, would be
  an unauthorized decision with legal consequence.
- Intent made explicit instead: `README.md` gained a **Distribution model** section stating the package is
  a source repo with local CLI/MCP distribution, that `private: true` blocks accidental publication, that
  no library entry point exists, and what a tarball *would* contain.

### Non-findings (checked, correct)

- `lint` aliasing `typecheck` is intentional and documented; it is not a second broken script.
- `cli` uses `--experimental-vm-modules` with `tsx` so the CLI can run from source; it resolves and runs.
- `engines: node >= 20` unchanged; verified on 22.23.3 and 26.7.0 in earlier tasks.

---

## Remaining decisions requiring maintainer authorization

These are listed, not decided:

1. **License.** Choose one, or deliberately ship without one. Needs a `LICENSE` file, a `license` field,
   and a matching `README` statement. *Not done: no authorization, no authoritative specification.*
2. **`private: true`.** Removing it is the point of no return for `npm publish`. Needs an explicit
   publication decision and, before that, a registry target and a name that does not collide with the
   existing public `agenttrust-labs/agenttrust` (TASK 13 §uncertainty 3).
3. **`repository` / `author` / `homepage`.** Blocked on TASK 13's open question of owner and name; there is
   no remote yet, so any URL would be fabricated.
4. **Contents of `files`.** Currently `dist/`, `scripts/`, `src/`, `README.md`. A stricter package would ship
   `dist/` only; a maximal one would add `docs/`. Reversible in one line — a distribution-strategy call, not
   an error.
5. **Version number.** `0.1.0`. Any first published version, and whether to keep `0.x`, is a product
   decision.
6. **License scope for the deployed artifacts** — the Agent Card at `api.sabokun.my.id` and the nginx vhost
   live outside this tree (TASK 13 §V7) and are not covered by whatever license this repository later gets.

---

## NOT TESTED

- **`npm publish` with real credentials.** Never run, per the constraints. A probe on a scratch
  `private:true` package in `/tmp` reached `ENEEDAUTH` (this host has no registry credentials), so npm's
  `private` refusal was **not observable** — the README wording was softened to say `private: true` is set
  to prevent accidental publication rather than claiming the refusal was witnessed.
- **`npm publish` to a real registry.** Blocked by the constraints and by the absence of credentials.
- **`npm install -g`.** The tarball was installed into a scratch project (V7), not globally.

## BLOCKED

Nothing in scope. Publication itself is **not blocked but not authorized** — a distinction worth keeping:
the mechanics are prepared, the decision is not this task's to make.

No on-chain activity: `nonce 4`, `pending 4`, `19943.619923 CCD` — unchanged. No key, no signing.

---

## Package inspection results

```console
$ npm pack --dry-run
npm notice name: agenttrust
npm notice version: 0.1.0
npm notice package size: 172.7 kB
npm notice unpacked size: 707.0 kB
npm notice total files: 99
(no warnings)

$ npm pack --dry-run --json | jq -r '.[0].files[].path' | cut -d/ -f1 | sort | uniq -c
     60 dist
     21 src
     16 scripts
      1 README.md
      1 package.json
```

Entry points present in that set: `dist/cli/index.js`, `dist/cli/verify.js`, `dist/cli/commerce.js`,
`dist/mcp/server.js` — all four `bin` targets.

---

## FINAL VERDICT

**READY — for its actual distribution model (source repository + local CLI/MCP), not for npm.**

The three findings are closed without a single unauthorized decision:

- **F4**: the `sign` script is deleted, and no fake signing path was invented to replace it — the gateway
  has no key and the wallet does the signing.
- **F5**: the dangling `exports` map is deleted rather than propped up with a fabricated library barrel.
  `bin` is now the only entry-point mechanism, and every target exists after a build.
- **F8**: `private: true` stays, no license is invented, and the intent is now written down in the README
  instead of being inferred from an absence.

The material improvement beyond the three findings is the `files` allowlist: a package that would have
shipped 236 files including tests, evidence, signing pages and a placeholder manifest now ships 99 files
of `dist/` + `src/` + `scripts/` + README, with zero `npm pack` warnings, and a regression test that fails
if any of that drifts back.

Six decisions remain open and are all maintainer calls — license, `private`, repository metadata, `files`
scope, version, and license coverage of the deployed artifacts. None of them blocks using the project
today; all of them block publishing it.
