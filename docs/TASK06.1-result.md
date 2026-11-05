# TASK 06.1 — Stale Lock Race & Ownership Hardening

Date: 2026-11-05 · Scope: `src/audit/lock.ts` (new), `src/audit/trail.ts` (lock block extracted and
re-exported). No change to the hash chain, checkpoint, or verification logic.
**No on-chain transactions.**

---

## 1. The defect reviewed

TASK 06's `withFileLock` broke a lock on **file age alone**:

```ts
if (ageMs > cfg.staleMs) unlinkSync(lockPath);   // ← age was the only evidence
```

Three concrete failures follow, all reproduced as failing behaviour before the fix:

| (#) | Failure |
|---|---|
| 1 | A writer legitimately holding the lock longer than `staleMs` (10 s default) had its **live** lock deleted by the next process. |
| 2 | Two contenders both decided the same lock was stale and both unlinked / both proceeded — mutual exclusion lost. |
| 3 | A contender that observed the *old* lock could unlink it **after** another process had already replaced it with a fresh one, deleting a brand-new lock. |

Root cause: age is not ownership. A lock can be old and alive, and a lock path can change owner between the
`stat` and the `unlink`.

---

## 2. Design

### Liveness, not age, decides

A lock is reclaimable only when its recorded owner is **provably gone**:

```ts
ownerStatus(rec) →
  'alive'   pid exists (signal 0 ok, or EPERM = exists but not ours), or it is our own pid
  'dead'    ESRCH — no such process
  'unknown' different host, or the probe fails for any other reason
```

Reclaim requires `dead` **and** an mtime older than `staleMs` (a fresh file with a dead pid may be a reclaim
already in flight). `alive` and `unknown` are never broken.

### Guarded reclaim — token-checked, atomic

1. `rename(lockPath → lockPath.stale.<pid>.<uuid>)` — atomic, so exactly one contender wins.
2. Re-read the moved file. If its `token` is **not** the token observed before the move, a new owner had
   already replaced it: restore with `link()` (fails `EEXIST` rather than clobbering) and back off.
3. Only when the token matches is the quarantined file unlinked.

If the restore itself collides (the slot was re-taken), the contender throws `AuditLockUnrecoverableError`
rather than deleting evidence.

### Ownership enforcement

- Every lock file carries `{ v, token, pid, host, acquired_at }`. `token` is a fresh UUID per acquisition
  and is the **only** proof of ownership.
- The token is re-checked **immediately before** and **immediately after** the protected section.
  A steal surfaces as `AuditLockOwnershipError`; the write is not silently accepted.
- Release deletes the lock only if the on-disk token is still ours.

### Behaviour when ownership cannot be established

| Situation | Behaviour |
|---|---|
| Owner alive | wait, then `AuditLockTimeoutError` |
| Owner on another host | `AuditLockUnrecoverableError` — never broken |
| Lock content unreadable / malformed | `AuditLockUnrecoverableError` — never broken |
| Owner dead, file fresh | wait, then timeout (no steal) |
| Owner dead, file stale | guarded token-checked reclaim |
| Ownership lost mid-section | `AuditLockOwnershipError` |

Every one of these **fails closed**. There is no code path that performs an append without holding the lock.

---

## 3. Files changed

**New**
- `src/audit/lock.ts` — the hardened lock: `withFileLock`, `ownerStatus`,
  `AuditLockTimeoutError`, `AuditLockUnrecoverableError`, `AuditLockOwnershipError`, `LockRecord`, `LockOptions`
- `test/task06.1-lock-hardening.test.mts` — 14 tests, real subprocesses
- `docs/TASK06.1-result.md` — this report

**Modified**
- `src/audit/trail.ts` — the inline lock block was removed and replaced by a re-export of `./lock.js`;
  the now-unused `fs` imports were dropped. Hash chain, canonicalization, checkpoint, and `verify()` are
  byte-for-byte unchanged.
- `test/task06-audit-integrity.test.mts` — tests 12 / 12b / 12c updated: they previously wrote lock files
  in the old `{pid, at}` shape, which the new code correctly refuses as "unreadable". They now write
  well-formed `LockRecord`s with a live pid, a dead pid, and malformed content respectively — the same
  three behaviours, expressed against the current contract.

**Untouched:** TASK 02 registration, TASK 03 verification, TASK 04 x402 + settlement gate, TASK 05 policy
and commerce authorization.

---

## 4. Tests — `task06.1-lock-hardening.test.mts` (14/14)

Real `node`/`tsx` subprocesses for every liveness or contention case; only lock-file content and mtime are
manipulated in-process.

| Test | Proves |
|---|---|
| **A1.** active writer protected beyond stale threshold | a holder alive for 1.2 s with `staleMs=300` is **not** displaced; contender fails with `AuditLockTimeoutError` |
| **A2.** `ownerStatus` classification | alive / dead / unknown for self, impossible pid, pid 1 (EPERM), foreign host |
| **A3.** foreign-host lock never broken | `AuditLockUnrecoverableError`, file preserved |
| **A4.** malformed lock never deleted | `AuditLockUnrecoverableError`, file preserved |
| **A5.** owner-exited lock reclaimed | real pid from an exited helper, dead-verified, then reclaimed and released |
| **A6.** dead owner + fresh file | waits instead of stealing; `AuditLockTimeoutError`; orphan preserved |
| **B1.** concurrent contenders | two processes race for the same stale lock; both critical sections complete and **do not overlap** (enter/exit timestamps compared); no lock or quarantine file leaked |
| **B2.** stale lock replaced by a new one during cleanup | the new owner's lock is not deleted; contender gets a timeout |
| **B3.** token changed under the reclaimer | helper refuses; live lock untouched |
| **C1.** ownership lost mid-section | `AuditLockOwnershipError` raised; the thief's lock is preserved on release |
| **C2.** release never deletes a foreign lock | foreign token survives acquisition attempts |
| **D1.** timeout fail-closed | trail log byte-identical after a refused append |
| **D2.** unrecoverable fail-closed | same, for the unreadable-lock path |
| **E1.** end-to-end concurrency | two processes × 10 events → 20 events, one valid chain, `checkpoint.count=20`, per-session seq 1..10 unique, no leaked lock, no quarantine files |

---

## 5. Test results (exact)

```
$ npx tsx test/task06.1-lock-hardening.test.mts
  ok   A1. an active writer is protected beyond the stale threshold
  ok   A2. ownerStatus classifies alive / dead / unknown correctly
  ok   A3. a foreign-host lock is never broken
  ok   A4. a malformed lock is never deleted
  ok   A5. a lock whose owner exited is reclaimed
  ok   A6. a dead owner with a FRESH lock file is not reclaimed immediately
  ok   B1. concurrent contenders never hold the lock at the same time
  ok   B2. a stale lock replaced by a newly acquired lock during cleanup is restored, not deleted
  ok   B3. reclaim never deletes a lock whose token changed under it
  ok   C1. losing ownership mid-section raises a hard error
  ok   C2. release never deletes a lock we do not own
  ok   D1. lock timeout remains fail-closed — no unlocked append
  ok   D2. unrecoverable lock also blocks the append
  ok   E1. two processes appending concurrently keep one chain and unique sequences

task06.1-lock-hardening: 14/14 passed
exit=0
```

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
────────────────────────────────────────────────────────────
all suites passed                                  235 tests
exit=0
```

| Command | Exit | Result |
|---|---|---|
| `npx tsc --noEmit` | 0 | no type errors |
| `npm run verify -- --token-id 1004` | 0 | `TRUST DECISION: TRUSTED` |
| `npx tsx scripts/task02-verify.mjs 1004 5abc7f8b…` | 0 | `RESULT: VERIFIED` |
| `npx tsx scripts/task04-conformance.mts` | 0 | SDK constants agree, exact scheme registered |
| `node dist/cli/commerce.js --token-id 1004 …` | 0 | `access_granted`, 8 audit events, mock settlement |
| `npx tsx scripts/task06-verify-trails.mts docs/evidence/task05` | 0 | `ALL TRAILS VERIFIED` |

---

## 6. Remaining filesystem limitations

These are real and are **not** mitigated by this change:

1. **PID reuse.** A lock whose recorded pid was recycled by an unrelated process is treated as `alive` and
   will never be reclaimed — the trail wedges until an operator removes the file. This is deliberate
   (fail-closed); the fix is manual, not automatic.
2. **`O_EXCL` semantics are filesystem-dependent.** On local `ext4`/`xfs`/APFS it is atomic. On NFS,
   some SMB/CIFS mounts and older network filesystems it is **not** guaranteed, and mutual exclusion may
   be lost. Not tested here; unsupported.
3. **`hostname()` is advisory.** Two hosts sharing a hostname (containers, cloned VMs) will be treated as
   the same host, so a "dead pid" determination on one could apply to the other. Isolated by a shared
   filesystem only, so it is an edge case — but not defended.
4. **Clock skew.** `staleMs` compares `Date.now()` with the file's mtime. On a shared filesystem between
   hosts with skewed clocks, "fresh" and "stale" are judgements made with a possibly wrong clock.
5. **Rename/link atomicity** is per-filesystem. The guarded reclaim relies on `rename` and `link` being
   atomic within one directory; across mount points it is not guaranteed.
6. **No fencing token.** A process that stalls (SIGSTOP, long GC pause, paused container) past its own
   ownership check but before its write can still write while another process holds the lock. The
   post-section ownership check detects and *reports* this (`AuditLockOwnershipError`) but cannot undo the
   append. True prevention needs a fencing token enforced by the storage layer, which a plain file cannot
   provide.
7. **Quarantine files are left for an operator** when a displaced lock cannot be restored — by design, so
   evidence is not destroyed.

---

## 7. On-chain status

**Zero transactions.** `accountNonce 4`, `pendingNonce 4`, balance `19943.619923 CCD` — unchanged since
TASK 02. TASK 06.1 touched only `src/audit/`, `test/` and `docs/`.
