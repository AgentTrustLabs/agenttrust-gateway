/**
 * TASK 06.1 — safe lock acquisition for the audit trail.
 *
 * The TASK 06 implementation broke a lock purely on file age. Three failures
 * followed from that:
 *
 *   1. a writer alive for longer than `staleMs` had its live lock deleted;
 *   2. two contenders racing to delete a stale lock could both proceed;
 *   3. a contender could delete a *newly acquired* lock after observing the
 *      older one, so two processes wrote at once.
 *
 * The fix is to never treat age alone as evidence of abandonment:
 *
 *   - Liveness decides. A lock is reclaimable only when its recorded owner is
 *     provably gone (same host + pid no longer exists). Different host, missing
 *     owner information, unreadable content, or an alive pid ⇒ NEVER break.
 *   - Reclaim is guarded: the contender atomically renames the candidate lock
 *     out of the way, re-reads the token, and only deletes it when the token is
 *     the one it observed. If a new owner slipped in, the file is restored with
 *     `link()` (which fails with EEXIST rather than clobbering) and the
 *     contender backs off.
 *   - Ownership is re-checked immediately before and after the protected
 *     section. Losing the lock aborts the write with an explicit error; there is
 *     no path that continues writing while unlocked.
 */

import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface LockOptions {
  /** Total time to keep trying before failing. */
  timeoutMs?: number;
  /**
   * A lock older than this *may* be abandoned. Age alone is never sufficient:
   * the owner must also be provably gone.
   */
  staleMs?: number;
  /** Delay between attempts. */
  retryMs?: number;
}

const LOCK_DEFAULTS: Required<LockOptions> = { timeoutMs: 5_000, staleMs: 10_000, retryMs: 25 };

export interface LockRecord {
  v: 1;
  /** Unique per acquisition. The only proof of ownership. */
  token: string;
  pid: number;
  host: string;
  /** ISO-8601 UTC. */
  acquired_at: string;
}

export class AuditLockTimeoutError extends Error {
  constructor(lockPath: string, waitedMs: number) {
    super(`audit lock timeout after ${waitedMs}ms: ${lockPath}`);
    this.name = 'AuditLockTimeoutError';
  }
}

/** The lock exists but cannot be safely reclaimed. Fails closed, by design. */
export class AuditLockUnrecoverableError extends Error {
  constructor(lockPath: string, reason: string) {
    super(
      `audit lock cannot be reclaimed safely: ${reason} (${lockPath}). ` +
      `Refusing to delete it — verify the owning process is gone, then remove the file manually.`,
    );
    this.name = 'AuditLockUnrecoverableError';
  }
}

/** The protected section ran after the lock was taken by someone else. */
export class AuditLockOwnershipError extends Error {
  constructor(lockPath: string) {
    super(
      `audit lock ownership lost during the protected section: ${lockPath}. ` +
      `The write may be unsafe; it is not retried automatically.`,
    );
    this.name = 'AuditLockOwnershipError';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLock(lockPath: string): LockRecord | null {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as LockRecord;
    if (parsed && parsed.v === 1 && typeof parsed.token === 'string' && typeof parsed.pid === 'number') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Is the recorded owner still running?
 *
 * 'alive'      — pid exists (signal 0 succeeded) or exists but is not ours (EPERM)
 * 'dead'       — ESRCH: no such process
 * 'unknown'    — different host, or the pid cannot be probed at all
 */
export function ownerStatus(rec: LockRecord, selfHost = hostname()): 'alive' | 'dead' | 'unknown' {
  if (rec.host !== selfHost) return 'unknown';
  if (rec.pid === process.pid) return 'alive'; // we are the owner (re-entrancy / same-process contention)
  try {
    process.kill(rec.pid, 0);
    return 'alive';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive'; // exists, owned by another user
    return 'unknown';
  }
}

/**
 * Guarded reclaim of a lock whose owner is provably dead.
 *
 * Returns true when this caller removed the abandoned lock and may retry
 * acquisition. Returns false when it backed off (someone else moved first, or a
 * new owner appeared). Throws when safety cannot be established.
 */
function tryReclaim(lockPath: string, observed: LockRecord): boolean {
  const quarantine = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    // Atomic: exactly one contender can move a given file.
    renameSync(lockPath, quarantine);
  } catch {
    return false; // someone else reclaimed or released it first
  }

  const moved = readLock(quarantine);
  if (!moved || moved.token !== observed.token) {
    // A different owner's lock was at that path. Put it back without clobbering:
    // link() fails with EEXIST if the path is occupied again.
    try {
      linkSync(quarantine, lockPath);
      unlinkSync(quarantine);
    } catch {
      // The slot is occupied again — the displaced owner will detect the loss
      // through its own ownership check. Leave the quarantined file for the
      // operator rather than deleting evidence.
      throw new AuditLockUnrecoverableError(
        lockPath,
        'a different lock was displaced during reclaim and the slot was re-taken',
      );
    }
    return false;
  }

  // Token matches what we observed: the owner is dead, the lock is ours to drop.
  try {
    unlinkSync(quarantine);
  } catch {
    /* already gone */
  }
  return true;
}

/**
 * Exclusive lock. There is no unlocked fallback: every failure path either waits,
 * reclaims safely, or throws.
 */
export function withFileLock<T>(target: string, opts: LockOptions, fn: () => T): T {
  const cfg = { ...LOCK_DEFAULTS, ...opts };
  const lockPath = `${target}.lock`;
  const started = Date.now();
  const me: LockRecord = {
    v: 1,
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    acquired_at: new Date().toISOString(),
  };

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx'); // O_CREAT | O_EXCL
      try {
        writeFileSync(fd, JSON.stringify(me));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;

      let rec: LockRecord | null;
      try {
        statSync(lockPath);
        rec = readLock(lockPath);
      } catch {
        continue; // vanished between open and stat — retry immediately
      }

      if (rec) {
        const status = ownerStatus(rec);
        if (status === 'alive') {
          // Live owner: age is irrelevant. Wait, then fail closed.
          if (Date.now() - started > cfg.timeoutMs) {
            throw new AuditLockTimeoutError(lockPath, Date.now() - started);
          }
          sleepSync(cfg.retryMs);
          continue;
        }
        if (status === 'unknown') {
          // Cannot prove the owner is gone ⇒ never break.
          throw new AuditLockUnrecoverableError(
            lockPath,
            `owner status unknown (pid ${rec.pid} on ${rec.host})`,
          );
        }
        // status === 'dead'
        let ageMs = 0;
        try {
          ageMs = Date.now() - statSync(lockPath).mtimeMs;
        } catch {
          continue;
        }
        if (ageMs < cfg.staleMs) {
          // Owner gone but the file is fresh: a reclaim may be mid-flight.
          if (Date.now() - started > cfg.timeoutMs) {
            throw new AuditLockTimeoutError(lockPath, Date.now() - started);
          }
          sleepSync(cfg.retryMs);
          continue;
        }
        if (tryReclaim(lockPath, rec)) continue; // reclaimed; retry acquisition
        // Backed off: another contender moved first.
        if (Date.now() - started > cfg.timeoutMs) {
          throw new AuditLockTimeoutError(lockPath, Date.now() - started);
        }
        sleepSync(cfg.retryMs);
        continue;
      }

      // Unreadable / malformed lock: ownership cannot be established.
      throw new AuditLockUnrecoverableError(lockPath, 'lock content is unreadable or malformed');
    }
  }

  /** Throws unless the file at lockPath still carries our token. */
  const assertOwned = () => {
    const cur = readLock(lockPath);
    if (!cur || cur.token !== me.token) throw new AuditLockOwnershipError(lockPath);
  };

  try {
    assertOwned();
    const out = fn();
    // Detect a mid-flight steal: the append may have raced, so surface it.
    try {
      assertOwned();
    } catch (e) {
      throw new AuditLockOwnershipError(lockPath);
    }
    return out;
  } finally {
    // Release only our own lock.
    try {
      const cur = readLock(lockPath);
      if (cur && cur.token === me.token) unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}
