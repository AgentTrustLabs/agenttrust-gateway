# TASK 06 — Audit Trail Integrity & Concurrency Hardening

Date: 2026-11-05 · Scope: `src/audit/trail.ts` only, plus tests and evidence.
**No on-chain transactions. No changes to TASK 02 registration or TASK 03 verification.**

---

## 1. What was added

Three mechanisms, all inside the existing `AuditTrail` API (`record`, `all`, `toJsonl`, `verify`):

1. **SHA-256 hash chain** — every event commits to its own content and to the previous line's hash.
2. **Out-of-band checkpoint** — a separate file anchoring the log head, so a truncated tail or a
   rollback to an earlier valid prefix is detectable.
3. **Exclusive file lock** — `O_CREAT|O_EXCL` lock file around `append + checkpoint`, with timeout,
   stale-lock breaking, and **no unsafe fallback**.

### Canonical serialization (exact definition)

The hash input is `canonicalize(event)` where `canonicalize` is:

- objects: keys sorted by code unit, no whitespace, `{"a":1,"b":2}`
- arrays: order preserved
- `undefined`-valued members omitted entirely (never serialized as `null`)
- `null`, booleans, numbers, strings: `JSON.stringify` semantics
- input is UTF-8; digest is lowercase hex SHA-256

**Included in the digest:** `seq`, `event_id`, `timestamp`, `session_id`, `type`, `outcome`, `reason`,
`agent`, `payment`, `evidence_ref`, **`prev_hash`**.

**Excluded:** `hash` itself (it is the output), and the `\n` line terminator.

`prev_hash` of the first line in a file is 64 zeros (`GENESIS_HASH`). The chain spans sessions: a file is
one chain even when several sessions append to it, which is what makes deletion and reordering of whole
lines detectable.

### Checkpoint format and update behaviour

`<trail>.checkpoint.json`:

```json
{ "version": 1, "count": 8, "head_hash": "6f7120ed…", "updated_at": "2026-11-05T01:38:32.876Z", "session_id": "cs_…" }
```

- Written **after** each append, inside the same lock, via write-temp-then-`rename` (atomic on the same
  filesystem).
- Contains only a count, a hash, a timestamp and a session id — **no event content, no secrets**.

### Lock behaviour

| Concern | Behaviour |
|---|---|
| Acquisition | `openSync(lockPath, 'wx')` — atomic create-or-fail |
| Contention | retry every `retryMs` (default 25 ms) |
| Timeout | `timeoutMs` (default 5 s) → throws `AuditLockTimeoutError`; **no unlocked write** |
| Stale lock | lock file older than `staleMs` (default 10 s) is unlinked and retried |
| Release | `unlink` in a `finally` block |
| Crash mid-write | a torn line is detected by the verifier as invalid JSON |

Stale detection uses **file age only**, never another process's pid — a recycled pid must not be able to
make a live lock look abandoned.

---

## 2. Verification — what `verify()` now checks

`AuditTrail.verify(file, { checkpointPath?, requireCheckpoint? })` returns
`{ ok, events, problems, warnings, checkpoint }`.

**Problems (hard failures)**
- invalid JSON line (torn/corrupted write)
- missing `event_id | session_id | type | outcome | prev_hash | hash`
- timestamp not UTC ISO-8601
- `prev_hash` mismatch → deleted / inserted / reordered / rewritten
- recomputed `hash` ≠ stored `hash` → content modified after signing
- `seq` not continuous **per session**
- `log truncated` — fewer events than the checkpoint vouches for
- head hash ≠ checkpoint head hash
- checkpoint missing (when `requireCheckpoint: true`), corrupted, or malformed
- checkpoint does not match the log at the anchored position

**Warnings (recoverable)**
- checkpoint lag — log has more events than the checkpoint covers (interrupted update);
  `refreshCheckpoint()` repairs it
- checkpoint absent in non-strict mode — chain intact but truncation is undetectable

`refreshCheckpoint()` **refuses** when the chain is broken or the log is shorter than the checkpoint. It
must never be possible to launder tampering into a valid-looking state by re-anchoring.

---

## 3. Threat model — stated honestly

### Detected

| Attack | Detected by |
|---|---|
| Change a field in an event | `hash` recomputation |
| Change an event's stored hash | `hash` recomputation + next `prev_hash` |
| Forge a `prev_hash` link | `prev_hash` comparison |
| Delete a middle event | `prev_hash` break + `seq` gap + checkpoint count |
| Insert an event | `prev_hash` break at the insertion point |
| Reorder events | `prev_hash` break + `seq` order |
| Truncate the tail | checkpoint `count` > events present |
| Replace the log with an older valid prefix | checkpoint `count` > events present |
| Corrupt / delete the checkpoint | explicit problem (strict mode) |
| Interrupted write | invalid JSON, or checkpoint-lag warning |

### NOT detected — documented, not glossed over

**An attacker who rewrites the log *and* the checkpoint consistently.** The checkpoint lives beside the
log (`<trail>.checkpoint.json`). Both are ordinary files owned by the same user on the same filesystem.
A writer with that access can truncate the log, relink the chain, and rewrite the checkpoint to match —
and `verify()` will accept the result. Test `forgery of the whole log plus checkpoint is NOT detected —
documented limit` asserts exactly this so the limitation cannot silently regress into a false claim.

Closing this gap requires an **external trusted anchor** the writer cannot rewrite:

- publish the head hash (or a hash of the checkpoint) to an append-only system — a Concordium transaction,
  a transparency log, an S3 object with versioning + object-lock, or a second host the writer has no
  write access to; or
- sign the checkpoint with a key held outside this process (HSM/KMS), so a rewritten checkpoint fails
  signature verification.

None of that is implemented here. **`verify()` therefore proves internal consistency and detects
accidental or unsophisticated tampering; it does not prove the log was never rolled back by someone with
write access to both files.**

Other limits: no per-line signatures (integrity is relative to the chain root, and the root is the
checkpoint); `seq`/`event_id` are self-declared fields inside the record they describe; locking is
advisory within one filesystem — NFS and some network filesystems do not guarantee `O_EXCL` semantics.

---

## 4. Concurrency

The append path holds the lock while it: reads the tail hash, computes the new event, appends the line,
and atomically replaces the checkpoint. A second writer therefore either waits or fails loudly.

Verified with **two real OS processes** appending 8 events each to the same file simultaneously
(`Promise.all` over spawned `tsx` workers):

```
all 16 events present · chain valid · checkpoint.count = 16
session cs_w1 seqs 1..8 · session cs_w2 seqs 1..8 · no duplicates · no lock left behind
```

Failure modes proven: lock timeout throws a typed error and leaves the log **and** checkpoint byte-identical;
a stale lock is broken rather than blocking forever.

---

## 5. Test results

`test/task06-audit-integrity.test.mts` — **25 tests**, temp directories, deterministic clock and id source,
no network.

| # | Required case | Test |
|---|---|---|
| 1 | Modified event content | `1. modified event content is detected` |
| 2 | Modified event hash | `2. modified event hash is detected` |
| 3 | Broken previous-hash link | `3. broken previous-hash link is detected` |
| 4 | Deleted middle event | `4. deleted middle event is detected` |
| 5 | Inserted event | `5. inserted event is detected` |
| 6 | Reordered events | `6. reordered events are detected` |
| 7 | Truncated log | `7. truncated log is detected via the checkpoint` |
| 8 | Older valid prefix | `8. log replaced with an older valid prefix is detected` |
| 9 | Missing / corrupted checkpoint | `9a`, `9b`, `9c` |
| 10 | Interrupted append/checkpoint | `10.`, `10b.`, `10c.` (incl. refresh refusal) |
| 11 | Two concurrent writers | `11.` — two OS processes, 16 events, chain intact |
| 12 | Lock timeout / acquisition failure | `12.`, `12b.`, `12c.` |
| 13 | Secret redaction still effective | `13.`, `13b.` |
| 14 | TASK 05 compatibility | `14.` — full `runCommerce()` run, same 8 events, chain valid |

Plus: canonicalization determinism, hash determinism, and the documented-limitation test.

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
────────────────────────────────────────────────────────────
all suites passed                                  221 tests
exit=0

$ npx tsc --noEmit                                   exit=0
$ npm run verify -- --token-id 1004                  exit=0   TRUST DECISION: TRUSTED
$ npx tsx scripts/task02-verify.mjs 1004 5abc7f8b…   exit=0   RESULT: VERIFIED
$ npx tsx scripts/task04-conformance.mts             exit=0
$ npx tsx scripts/task06-verify-trails.mts docs/evidence/task05   exit=0   ALL TRAILS VERIFIED
$ npx tsx scripts/task06-tamper-demo.mts docs/evidence/task05 docs/evidence/task06
                                                     exit=0   11 tamper cases, 0 unexpected
```

### Exact commands and results (final run)

| Command | Exit | Result |
|---|---|---|
| `npm test` | 0 | 221 tests across 11 suites, all passing |
| `npx tsc --noEmit` | 0 | no type errors |
| `npm run verify -- --token-id 1004` | 0 | `TRUST DECISION: TRUSTED` |
| `npx tsx scripts/task02-verify.mjs 1004 5abc7f8b…` | 0 | `RESULT: VERIFIED` |
| `npx tsx scripts/task04-conformance.mts` | 0 | SDK constants agree, scheme registered |
| `npx tsx scripts/task06-verify-trails.mts docs/evidence/task05` | 0 | `ALL TRAILS VERIFIED` (8 / 7 / 4 events, checkpoints matched) |
| `npx tsx scripts/task06-tamper-demo.mts docs/evidence/task05 docs/evidence/task06` | 0 | 11 tamper cases detected, 0 unexpected, 1 documented-accept |

---

## 6. Live tamper demonstration

`npx tsx scripts/task06-tamper-demo.mts docs/evidence/task05` copies the real 8-event trail into 12 case
directories, applies one modification per case, and reports the verifier's verdict:

```
tamper case                        verdict  expected
01-content-modified                REJECT   hash mismatch
02-hash-modified                   REJECT   hash mismatch
03-link-broken                     REJECT   prev_hash mismatch
04-middle-deleted                  REJECT   prev_hash mismatch + truncated
05-event-inserted                  REJECT   prev_hash mismatch
06-reordered                       REJECT   prev_hash mismatch + seq
07-tail-truncated                  REJECT   log truncated
08-rolled-back-to-valid-prefix     REJECT   log truncated
09-checkpoint-deleted              REJECT   checkpoint missing (strict mode)
10-checkpoint-corrupted            REJECT   checkpoint is not valid JSON
11-torn-tail                       REJECT   not valid JSON
12-full-rewrite-with-checkpoint    ACCEPT   undetectable by design
```

Artifacts: `docs/evidence/task06/tamper/` (one directory per case + `tamper-results.json`) and
`docs/evidence/task05/audit-verification.json` (pristine trails: all OK, checkpoint matched).

Tamper cases live under `docs/evidence/task06/` deliberately: a deliberately-broken trail must not sit
beside the pristine ones, or a directory-wide verification pass would flag the evidence itself.

Sample rejection text (real output, case 04):

```
line 3: prev_hash mismatch — links to 21cebd45f6bf…, expected 86a209c2acf5… (deleted, inserted, reordered or rewritten)
line 3: seq 4, expected 3 for session cs_20261105013832876_mkgmkd
log truncated: 4 event(s) present, checkpoint vouches for 8 (tail deleted or log rolled back)
```

---

## 7. Compatibility

- `record()`, `all()`, `toJsonl()`, `verify()` keep their signatures; `verify()` gained two optional
  arguments and two extra result fields (`warnings`, `checkpoint`).
- Existing call sites (`src/commerce/orchestrator.ts`, `src/cli/commerce.ts`) needed **no changes**.
- Events gain two fields (`prev_hash`, `hash`); TASK 05's schema test was updated to allow them, and its
  size sanity bound was relaxed to account for 128 extra hex chars per line.
- The commerce pipeline's 8-event order is unchanged (asserted by test 14).
- Secret refusal is unchanged and still runs before hashing, so a refused event never reaches the chain
  or the log.

## 8. Files changed

**Modified**
- `src/audit/trail.ts` — hash chain, checkpoint, locking, extended `verify`, `refreshCheckpoint`,
  `canonicalize`, `eventHash`, `GENESIS_HASH`, `withFileLock`, `AuditLockTimeoutError`
- `test/task05-commerce.test.mts` — schema whitelist + size bound now account for the chain fields

**New**
- `test/task06-audit-integrity.test.mts` — 25 tests
- `scripts/task06-verify-trails.mts` — read-only trail verification + JSON report
- `scripts/task06-tamper-demo.mts` — 12-case tamper demonstration
- `docs/evidence/task05/audit-verification.json` — pristine-trail verification report
- `docs/evidence/task06/tamper/` — 12 case directories + `tamper-results.json`
- `docs/TASK06-result.md` — this report

**Untouched:** TASK 02 registration, TASK 03 verification, TASK 04 payment module and settlement gate.

## 9. On-chain confirmation

**Zero on-chain transactions occurred during TASK 06.** TASK 06 touched only `src/audit/`, `test/`,
`scripts/` and `docs/`; no transaction was built, signed, sponsored or submitted, and no facilitator was
contacted.

Measured after the task:

```
accountNonce : 4          ← unchanged since TASK 02's third update
pendingNonce : 4          ← nothing staged or pending
balance      : 19943.619923 CCD   ← unchanged since TASK 02
```

The account still holds only its credential deployment plus the three TASK 02 updates.

## 10. Blocked / not implemented

- **External anchoring** of the checkpoint head (Concordium transaction, transparency log, KMS signature)
  is not implemented — it is the one thing that would extend detection to a writer with full filesystem
  control. Documented as the explicit next step, not silently omitted.
- **NFS / network filesystem** locking semantics untested; `O_EXCL` is not guaranteed by all of them.
- **Per-line signatures** are not used; integrity is chain-relative to the checkpoint root.
