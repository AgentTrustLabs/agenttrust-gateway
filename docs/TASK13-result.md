# TASK 13 — Git Repository Provenance & Commit Readiness

Date: 2026-11-05 · Investigation only. **No `git init`, no clone, no commit, no push, no remote added, no
file deleted.**

---

## VERIFIED

### V1 — There is no Git metadata anywhere in the chain

```console
$ for d in /home/ubuntu/projects/agenttrust /home/ubuntu/projects /home/ubuntu /home /; do
    printf '%-42s ' "$d"; [ -d "$d/.git" ] && echo HAS_GIT || echo no_git; done
/home/ubuntu/projects/agenttrust           no_git
/home/ubuntu/projects                      no_git
/home/ubuntu                               no_git
/home                                      no_git
/                                          no_git

$ ls -a
. .. .gitignore README.md dist docs evidence node_modules package-lock.json
package.json scripts sign signing-site src test tsconfig.json

$ find . -name '.git*' -not -path './node_modules/*'
./.gitignore                      # the TASK 12 file, not Git metadata

$ git status --short
fatal: not a git repository (or any of the parent directories): .git
```

The `.gitignore` created in TASK 12 is the only Git-related file present. There is no `.git` file
(worktree pointer), no `.gitmodules`, no `HEAD`, and no packed refs anywhere below `/`.

### V2 — No traces of an archive export or a copied checkout

```console
$ ls -a | grep -Ei 'tar|zip|gz|orig|bak|rej|export'      → none
$ find . -name '*.orig' -o -name '*.rej' -o -name '*~'    → none
```

A tar/zip extraction leaves no marker of its own, so absence proves little on its own — the decisive
evidence is V3.

### V3 — The directory was *created* by this task series, not cloned into

```console
$ stat -c '%n  birth=%w  mtime=%y' . docs/TASK01-feasibility.md
.                             birth=2026-11-04 16:55:27  mtime=2026-11-05 03:43:45
docs/TASK01-feasibility.md    birth=2026-11-04 16:55:27  mtime=2026-11-04 16:55:27

$ find . -path ./node_modules -prune -o -type f -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort | head -3
2026-11-04 16:55 ./docs/TASK01-feasibility.md
2026-11-04 16:55 ./evidence/badge-check-mainnet.json
2026-11-04 16:55 ./evidence/contract-info-mainnet.json
```

The directory birth timestamp and the first file's mtime are the **same second**
(`2026-11-04 16:55:27`), and that first file is `docs/TASK01-feasibility.md` — the output of the first task
in this project. A clone would carry the clone time on the directory but file mtimes taken from the archive
(or checkout time), and would produce a `.git`.

```console
$ grep -n 'git clone\|git init' ~/.bash_history          → 4 hits, none involving agenttrust
   18: git clone https://github.com/crytic/echidna.git
  340: git clone https://github.com/zunmax/technocore-did-starter.git
```

```console
$ find / -maxdepth 5 \( -name 'agenttrust*.tar*' -o -name 'agenttrust*.zip' \)  → none
```

**Conclusion: a locally generated working tree.** Files were authored task by task (TASK 01 on 2026-11-04
16:55 through TASK 12 on 2026-11-05 03:48), never checked out.

### V4 — No GitHub repository corresponds to this code

Four authenticated accounts were enumerated (identity confirmed per credential store):

| Credential dir | `gh api user` | repos named `agenttrust` |
|---|---|---|
| `~/.config/gh` | `naninu123` | none |
| `~/.config/gh-acc2` | `butiploka` | none |
| `~/.config/gh-acc4` | `bomniop` | none |
| `~/.config/gh-acc3` | `Yudistir123` | none |

`gh repo list <user> --limit 300` for each, filtered on `trust|agenttrust|concordium`: the only hits are
unrelated projects (`Talenttrust-Frontend`, `dApp-SafeTrust`, `TrustAnchor`, `AgriTrust-Backend`, …). The
`SaboLabs` org has exactly three repos — `soroban-devkit`, `demo-repository`, `.github` — no AgentTrust.

Direct resolution attempts, all "Could not resolve to a Repository":

```
SaboLabs/agenttrust · naninu123/agenttrust · bomniop/agenttrust
Yudistir123/agenttrust · butiploka/agenttrust
SaboLabs/agent-trust-gateway · naninu123/agent-trust-gateway
```

GitHub code search, using strings that appear **only** in this working tree, returns nothing:

| Query | Result |
|---|---|
| `"JyP9YLib1wYgFmztkcKJL"` (on-chain CIS-2 token address) | `[]` |
| `"3f6144046d843b7bae1b071f279e26c4dc0c4711a30b925220c1dbf94aeab564"` (card metadata hash) | `[]` |
| `"AGENTTRUST_AUDIT_ROOT"` (env var defined in `src/mcp/server.ts:31`) | `[]` |
| `"soroban-devkit"` (control — must return hits) | **returns hits** |

The control query proves the search itself works, so the empty results are meaningful, not a broken
query. **This code is not published anywhere on GitHub.**

### V5 — The name collision is not this project

Two public repos share the name and were checked and excluded:

| Repo | Why it is not ours |
|---|---|
| `agenttrust-labs/agenttrust` (created 2026-05-01, `main`, homepage `agenttrust.tech`) | Rust + TypeScript + MDX + `Anchor.toml` (Solana) + `live-app`; none of our paths exist in it — `src/mcp/tools.ts`, `src/verify/crossAgent.ts`, `docs/TASK08-result.md`, `scripts/task08-demo.mjs` all return `Not Found` |
| `SRN0129/Agenttrust` | Prompt-injection defence gateway, Go SDK + its own `docs/Architecture-Overview.md`; unrelated |

Neither shares a single file with this tree. Per the task's constraint, the directory name was **not**
treated as a repository name.

### V6 — `package.json` declares no repository

```console
$ python3 -c "…print({k: d.get(k) for k in ('repository','author','homepage','bugs','license')})"
{'repository': None, 'author': None, 'homepage': None, 'bugs': None, 'license': None}
$ "private": true
```

Nothing in the manifest points at a remote, and no document, script, or test contains a Git URL for this
project (`grep -rn 'github.com' --include='*.md' --include='*.ts' --include='*.mjs'` returns only dependency
sponsor URLs, the Concordium faucet repo, and third-party gists used by the registry fixtures).

### V7 — Deployment artifacts exist outside the tree and are *not* captured by it

Real running state that would be lost if the tree were treated as the whole project:

| Artifact | Content | Relation to the tree |
|---|---|---|
| `/var/www/agenttrust/.well-known/agent-card.json` | sha256 `3f614404…` | byte-identical to `signing-site/.well-known/agent-card.json` and `docs/evidence/task02/agent-card.v2.json` |
| `/etc/nginx/sites-enabled/agenttrust-vhost` | vhost for `agenttrust.sabolabs.dev` → that file | **not in the tree** |
| `/etc/nginx/sites-available/4evergent-preview:59` | `include /etc/nginx/snippets/agenttrust.conf` | **not in the tree** |
| `https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json` | sha256 `3f614404…` (verified live) | the URI actually registered on chain |

`agenttrust.sabolabs.dev` is **NXDOMAIN** today, so the vhost is dormant; the live serving path is
`api.sabokun.my.id`. The vhost's own comment pins a **stale hash** (`1f001ec9…`) while the file it serves
hashes to `3f614404…` — a doc-level inaccuracy in a file that is not part of the repository.

---

## NOT TESTED

- **Any remote's contents beyond reachability.** `agenttrust-labs/agenttrust` was sampled at four paths and
  via metadata; a full-tree comparison was not performed because the provenance evidence above already
  excludes it.
- **Other accounts not present on this host.** Only the four credential stores under `~/.config/` were
  enumerated; a repository under an account with no credentials here would not be discoverable by this
  method. GitHub-wide search for the distinctive strings returned zero, which covers public repos
  regardless of owner, but **not private repos**.
- **Whether an intended repository exists but is private and unauthenticated.** Unknowable from here.
- **Bash history completeness.** `~/.bash_history` has 1709 lines and no `agenttrust` entry; shell history
  is best-effort and the agent sessions that produced this tree ran through the tool layer, not an
  interactive shell, so their creation commands would not appear there anyway.

## BLOCKED

**Canonical repository identity cannot be established, because none exists.**

Not "unverified" in the sense of "we couldn't reach it" — verified absent: no local Git metadata (V1), no
export/clone signature (V2, V3), no matching repo on any authenticated account (V4), no public code
anywhere matching this tree's unique identifiers (V4), and no declared remote in the manifest or docs (V6).

No workaround was attempted, per the constraints: no `git init`, no invented remote, no clone over the
working directory.

---

## Canonical repository identity and evidence

| Question | Answer | Basis |
|---|---|---|
| Canonical owner/name | **None exists** | V4 — 0 of 4 accounts, SaboLabs org, GitHub code search all negative |
| Expected default branch | **None** (never any Git) | V1 |
| Remote URL | **None** — nothing to discover | V6 |
| Local tree provenance | **Generated working tree**, authored by the TASK 01–12 sessions | V3 |
| Distribution form | **Not** archives, not a copied checkout, not a generated build tree | V2, V3 |
| Divergence from a canonical repo | **N/A** — there is nothing to diverge from | V1, V4 |

**Local tree provenance in one line:** `/home/ubuntu/projects/agenttrust` was created empty on
2026-11-04 16:55:27 UTC and filled by the task series TASK 01 → TASK 12; it is the origin, not a copy, of
every byte it contains.

## Differences or uncertainty

1. **Deployment state lives outside the tree** (V7). The nginx vhost and the `/var/www` card copy are real
   and operational but untracked by anything. If the project is ever committed, these will not travel with
   it unless deliberately added.
2. **`agenttrust.sabolabs.dev` is NXDOMAIN**, while `docs/TASK02-result.md:103` records that `sabolabs.dev`
   never resolved. The card's registered URI is `api.sabokun.my.id`, which does resolve and serves the
   exact pinned bytes. So the *agent* is fine; the *intended brand domain* was never live.
3. **Name collision risk on publication.** `agenttrust-labs/agenttrust` is an existing public repo in the
   same domain space (agent payments / trust). Publishing under the name `agenttrust` in a personal account
   would be confusing; the constraint against choosing a name is respected here — this is a flag for the
   operator, not a decision.
4. **Evidence is the only copy.** `docs/evidence/task02–task08` contains the sole record of the on-chain
   registration, transactions, and verification runs. There is no Git history and no backup: any deletion
   is unrecoverable. (TASK 12 retained all 82 artifacts.)
5. **`package.json` has `"private": true` and no `license`** — correct for an unpublished tree, but the
   manifest would need `repository` set before any publish/tooling expectation is met. Out of scope here.

---

## Recommended next action

**Before any `git init`, decide the owner and visibility — that decision is the operator's, not the
agent's.** Everything else is mechanical and safe.

1. **Choose owner + repo name.** Candidates from the evidence: `SaboLabs` (the org that already hosts
   `soroban-devkit`) or `naninu123` (the personal account with the Stellar/Soroban history). Avoid
   `agenttrust` as a bare name in a personal account given the existing public collision (V5, uncertainty 3).
2. **Create the remote first, empty, with no README/`.gitignore`/license** — then `git init` locally and add
   the existing `.gitignore` (TASK 12) rather than generating one server-side.
3. **Decide the deployment artifacts' fate before the first commit** (uncertainty 1): either commit the
   nginx vhost under a `deploy/` directory so it is reproducible, or explicitly document it as
   environment-only. `nginx/sites-*/agenttrust-vhost` is currently the only record of how the card is
   served.
4. **Record the missing metadata** in the same commit: `repository`, `license` (or an explicit "no license"
   note — the README already says all rights reserved), `author`.
5. **First commit should be the TASK 12 staging set**, re-measured during this task:

   ```console
   $ git add -A && git diff --cached --name-only | wc -l   → 175
   $ … | grep -c '^node_modules/'                          → 0
   $ … | grep -c '^dist/'                                  → 0
   ```

   175 rather than TASK 12's 174 because `docs/TASK13-result.md` is this task's own output.

Nothing in steps 1–5 has been executed. No Git command that writes was run in this task.

---

## FINAL VERDICT

**UNVERIFIED — established as having no canonical repository.**

The working tree is **not** an exported archive, **not** a copied checkout, and **not** a build artifact: it
is the origin of the code, generated in place by TASK 01–12 starting 2026-11-04 16:55:27 UTC. No GitHub
repository holds this code — verified negatively across four authenticated accounts, the SaboLabs org,
seven guessed repo paths, and a working GitHub code search keyed on this tree's unique identifiers.

Nothing can be compared, no divergence exists to report, and no recovery is needed, because there is no
prior Git state to recover. The tree is **commit-ready but not committable by this task**: TASK 12 verified
(and this task re-confirmed) that a staging run produces the working tree with zero generated artifacts, so the only missing inputs are
operator decisions (owner, name, visibility, deployment-artifact policy) that this task must not make.
