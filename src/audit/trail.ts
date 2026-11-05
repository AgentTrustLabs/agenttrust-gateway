/**
 * Append-only JSONL audit trail with a SHA-256 hash chain, an out-of-band
 * checkpoint for truncation/rollback detection, and exclusive locking for
 * concurrent writers.
 *
 * ── What is cryptographically committed ─────────────────────────────────
 *
 * Every event carries two extra fields:
 *
 *   prev_hash  hex SHA-256 of the previous event in the FILE (or 64 zeros for
 *              the first event in the file). This makes the log a single chain
 *              across sessions, which is what lets us detect deletion,
 *              insertion and reordering of whole lines.
 *   hash       hex SHA-256 over `canonicalize(event without the "hash" field)`.
 *
 * Canonical serialization (deterministic, documented):
 *   - recursive JSON with object keys sorted by code unit, no whitespace
 *   - arrays keep their order
 *   - `null`, booleans, numbers and strings serialized with JSON.stringify
 *   - absent optional fields are omitted entirely (never serialized as null)
 *
 * INCLUDED in the digest: every field of the event except `hash` — that is
 * seq, event_id, timestamp, session_id, type, outcome, reason, agent, payment,
 * evidence_ref and prev_hash.
 * EXCLUDED: `hash` itself (it is the output), and the line terminator.
 *
 * ── What this can and cannot prove ──────────────────────────────────────
 *
 * CAN detect: modified content, modified hash, broken link, deleted middle
 * event, inserted event, reordered events, truncated tail (when the checkpoint
 * is newer than the log), corrupted checkpoint, torn/interrupted appends.
 *
 * CANNOT detect, by design: an attacker who rewrites the log AND the checkpoint
 * together to a shorter but internally valid state. The checkpoint is stored
 * beside the log, so it is only as trustworthy as the storage. Detecting that
 * requires an external anchor (see docs/TASK06-result.md). This limitation is
 * real and must not be papered over.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withFileLock, type LockOptions } from './lock.js';
import { assertEventType, validateRecordFields, AuditEventValidationError } from './validate.js';

export { assertEventType, validateRecordFields, AuditEventValidationError };

export type AuditEventType =
  | 'agent.discovered'
  | 'agent.card.retrieved'
  | 'agent.trust.verified'
  | 'agent.trust.rejected'
  | 'payment.requirement.created'
  | 'payment.payload.received'
  | 'payment.verified'
  | 'payment.rejected'
  | 'payment.settlement.simulated'
  | 'commerce.access.granted'
  | 'commerce.access.denied';

export type AuditOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT_TESTED' | 'INFO';

export interface AuditEvent {
  /** Monotonic within a session, starting at 1. */
  seq: number;
  /** UUIDv4 per event. */
  event_id: string;
  /** ISO-8601 UTC, millisecond precision. */
  timestamp: string;
  session_id: string;
  type: AuditEventType;
  agent?: {
    token_id?: number;
    token_address?: string;
    owner_account?: string;
    agent_uri?: string;
    metadata_sha256?: string;
  };
  payment?: {
    requirement_id?: string;
    amount?: string;
    asset?: string;
    network?: string;
    pay_to?: string;
    payer?: string;
    transaction?: string;
  };
  outcome: AuditOutcome;
  reason?: string;
  evidence_ref?: string;
  /** Hash of the previous line in the file; 64 zeros for the first line. */
  prev_hash: string;
  /** SHA-256 over the canonical form of this event minus `hash`. */
  hash: string;
}

/** Chain root: the `prev_hash` of the first line in a file. */
export const GENESIS_HASH = '0'.repeat(64);

export interface Checkpoint {
  version: 1;
  /** Number of events the checkpoint vouches for. */
  count: number;
  /** `hash` of event number `count` (the last one it covers). */
  head_hash: string;
  /** ISO-8601 UTC. */
  updated_at: string;
  /** Session that wrote the checkpointed event. */
  session_id: string;
}

// ─── canonical serialization ─────────────────────────────────────────────

/**
 * Deterministic JSON: sorted keys, no whitespace, arrays in order.
 * This exact function defines the hash input; changing it invalidates every
 * existing trail, so it is versioned by the checkpoint `version` field.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** Hash of an event, computed over everything except the `hash` field. */
export function eventHash(event: Omit<AuditEvent, 'hash'> & { hash?: string }): string {
  const { hash: _ignored, ...rest } = event as AuditEvent;
  return createHash('sha256').update(canonicalize(rest), 'utf8').digest('hex');
}

// ─── secret refusal (unchanged semantics) ────────────────────────────────

const FORBIDDEN_KEY = /(private|secret|seed|mnemonic|passphrase|password|signerkey|apikey)/i;
const FORBIDDEN_VALUE = /^(0x)?[0-9a-fA-F]{64}$/;
const PUBLIC_HASH_FIELDS = /(\.transaction|\.metadata_sha256|\.sha256|_sha256|_hash|\.hash)$/;

export function assertNoSecrets(value: unknown, path = 'event'): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.test(value) && !PUBLIC_HASH_FIELDS.test(path)) {
      throw new Error(`audit refused: ${path} looks like raw key material`);
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) throw new Error(`audit refused: ${path}.${k} is a secret-bearing field`);
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

// ─── locking ─────────────────────────────────────────────────────────────
// Implementation lives in ./lock.ts (TASK 06.1). Re-exported here so existing
// imports from the trail module keep working.

export {
  withFileLock,
  ownerStatus,
  AuditLockTimeoutError,
  AuditLockUnrecoverableError,
  AuditLockOwnershipError,
  type LockOptions,
  type LockRecord,
} from './lock.js';

// ─── trail ───────────────────────────────────────────────────────────────

export interface AuditTrailOptions {
  filePath?: string;
  sessionId?: string;
  now?: () => Date;
  newId?: () => string;
  lock?: LockOptions;
  /** Override the checkpoint path (defaults to `<filePath>.checkpoint.json`). */
  checkpointPath?: string;
}

export function checkpointPathFor(filePath: string): string {
  return `${filePath}.checkpoint.json`;
}

interface TailInfo {
  count: number;
  lastHash: string;
}

/** Read the tail hash and line count of a JSONL file. Callers must hold the lock. */
function readTail(filePath: string): TailInfo {
  if (!existsSync(filePath)) return { count: 0, lastHash: GENESIS_HASH };
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return { count: 0, lastHash: GENESIS_HASH };
  const last = JSON.parse(lines[lines.length - 1]!) as AuditEvent;
  return { count: lines.length, lastHash: last.hash };
}

export class AuditTrail {
  readonly sessionId: string;
  readonly filePath?: string;
  readonly checkpointPath?: string;
  private seq = 0;
  private readonly events: AuditEvent[] = [];
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly lockOpts: LockOptions;

  constructor(opts: AuditTrailOptions = {}) {
    this.sessionId = opts.sessionId ?? `cs_${randomUUID()}`;
    this.filePath = opts.filePath;
    this.checkpointPath = this.filePath
      ? (opts.checkpointPath ?? checkpointPathFor(this.filePath))
      : undefined;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
    this.lockOpts = opts.lock ?? {};
    if (this.filePath) mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /**
   * Append one event. Returns the persisted record (hash included).
   *
   * Input is validated fail-closed before anything is hashed or written:
   * an unknown top-level or nested field, a wrong type, or an unknown outcome
   * throws `AuditEventValidationError` and appends nothing. Previously unknown
   * keys were silently dropped before `assertNoSecrets()` could inspect them,
   * so a caller could believe a field was recorded when it never was (TASK 14).
   */
  record(
    type: AuditEventType,
    fields: {
      outcome: AuditOutcome;
      reason?: string;
      agent?: AuditEvent['agent'];
      payment?: AuditEvent['payment'];
      evidence_ref?: string;
    },
  ): AuditEvent {
    assertEventType(type);
    validateRecordFields(fields);

    const body: Omit<AuditEvent, 'prev_hash' | 'hash'> = {
      seq: this.seq + 1,
      event_id: this.newId(),
      timestamp: this.now().toISOString(),
      session_id: this.sessionId,
      type,
      outcome: fields.outcome,
      ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
      ...(fields.agent ? { agent: fields.agent } : {}),
      ...(fields.payment ? { payment: fields.payment } : {}),
      ...(fields.evidence_ref ? { evidence_ref: fields.evidence_ref } : {}),
    };

    assertNoSecrets(body);

    let persisted: AuditEvent;

    if (this.filePath && this.checkpointPath) {
      const filePath = this.filePath;
      const cpPath = this.checkpointPath;
      persisted = withFileLock(filePath, this.lockOpts, () => {
        // Read the tail under the lock: a second writer may have appended since
        // our last record, and chaining to the in-memory value would fork.
        const tail = readTail(filePath);
        const event: AuditEvent = {
          ...body,
          prev_hash: tail.lastHash,
          hash: '',
        };
        event.hash = eventHash(event);

        appendFileSync(filePath, JSON.stringify(event) + '\n', { encoding: 'utf8' });
        writeCheckpointAtomic(cpPath, {
          version: 1,
          count: tail.count + 1,
          head_hash: event.hash,
          updated_at: event.timestamp,
          session_id: event.session_id,
        });
        return event;
      });
    } else {
      // In-memory trail: still chain, so `toJsonl()` is a verifiable trail too.
      const prev = this.events.length > 0 ? this.events[this.events.length - 1]!.hash : GENESIS_HASH;
      const event: AuditEvent = { ...body, prev_hash: prev, hash: '' };
      event.hash = eventHash(event);
      persisted = event;
    }

    this.seq = body.seq;
    this.events.push(persisted);
    return persisted;
  }

  all(): readonly AuditEvent[] {
    return this.events;
  }

  toJsonl(): string {
    return this.events.map(e => JSON.stringify(e)).join('\n') + '\n';
  }

  /**
   * Verify a trail file, its hash chain, and its checkpoint.
   *
   * Returns actionable problems (hard failures) and warnings (recoverable or
   * informational states such as a lagging checkpoint after an interrupted
   * update).
   */
  static verify(
    filePath: string,
    opts: { checkpointPath?: string; requireCheckpoint?: boolean } = {},
  ): {
    ok: boolean;
    events: AuditEvent[];
    problems: string[];
    warnings: string[];
    checkpoint: { present: boolean; count?: number; head_hash?: string; matches?: boolean };
  } {
    const warnings: string[] = [];
    const problems: string[] = [];
    const cpPath = opts.checkpointPath ?? checkpointPathFor(filePath);

    if (!existsSync(filePath)) {
      return {
        ok: false,
        events: [],
        problems: ['file not found'],
        warnings,
        checkpoint: { present: false },
      };
    }

    const lines = readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim().length > 0);
    const events: AuditEvent[] = [];

    // ── chain + schema ───────────────────────────────────────────────────
    let expectedPrev = GENESIS_HASH;
    const nextSeq = new Map<string, number>();

    for (const [i, line] of lines.entries()) {
      const at = `line ${i + 1}`;
      let e: AuditEvent;
      try {
        e = JSON.parse(line) as AuditEvent;
      } catch {
        problems.push(`${at}: not valid JSON (torn or corrupted write)`);
        return { ok: false, events, problems, warnings, checkpoint: { present: existsSync(cpPath) } };
      }

      for (const field of ['event_id', 'session_id', 'type', 'outcome', 'prev_hash', 'hash'] as const) {
        if (!(field in e)) problems.push(`${at}: missing ${field}`);
      }
      if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(e.timestamp ?? '')) {
        problems.push(`${at}: timestamp not UTC ISO-8601`);
      }

      if (e.prev_hash !== expectedPrev) {
        problems.push(
          `${at}: prev_hash mismatch — links to ${String(e.prev_hash).slice(0, 12)}…, ` +
          `expected ${expectedPrev.slice(0, 12)}… (deleted, inserted, reordered or rewritten)`,
        );
      } else {
        const recomputed = eventHash(e);
        if (recomputed !== e.hash) {
          problems.push(`${at}: hash mismatch — content was modified after signing`);
        }
      }

      const expected = nextSeq.get(e.session_id) ?? 1;
      if (e.seq !== expected) {
        problems.push(`${at}: seq ${e.seq}, expected ${expected} for session ${e.session_id}`);
      }
      nextSeq.set(e.session_id, e.seq + 1);

      expectedPrev = e.hash;
      events.push(e);
    }

    // ── checkpoint ───────────────────────────────────────────────────────
    const checkpointInfo: { present: boolean; count?: number; head_hash?: string; matches?: boolean } = {
      present: existsSync(cpPath),
    };

    if (!checkpointInfo.present) {
      if (opts.requireCheckpoint) {
        problems.push('checkpoint missing — truncation and rollback cannot be detected');
      } else if (events.length > 0) {
        warnings.push('checkpoint missing — chain is intact but truncation is undetectable');
      }
      return { ok: problems.length === 0, events, problems, warnings, checkpoint: checkpointInfo };
    }

    let cp: Checkpoint;
    try {
      cp = JSON.parse(readFileSync(cpPath, 'utf8')) as Checkpoint;
    } catch {
      return {
        ok: false,
        events,
        problems: [...problems, 'checkpoint is not valid JSON (corrupted)'],
        warnings,
        checkpoint: checkpointInfo,
      };
    }

    if (cp.version !== 1 || typeof cp.count !== 'number' || typeof cp.head_hash !== 'string') {
      return {
        ok: false,
        events,
        problems: [...problems, 'checkpoint is malformed (bad version/count/head_hash)'],
        warnings,
        checkpoint: checkpointInfo,
      };
    }
    checkpointInfo.count = cp.count;
    checkpointInfo.head_hash = cp.head_hash;
    checkpointInfo.matches = false;

    if (events.length < cp.count) {
      problems.push(
        `log truncated: ${events.length} event(s) present, checkpoint vouches for ${cp.count} ` +
        `(tail deleted or log rolled back)`,
      );
    } else if (events.length === cp.count) {
      if (events.length > 0 && events[events.length - 1]!.hash !== cp.head_hash) {
        problems.push('head hash mismatch — last event does not match the checkpoint (log rewritten)');
      } else {
        checkpointInfo.matches = true;
      }
    } else {
      // Log is longer than the checkpoint: interrupted checkpoint update, or the
      // checkpoint was rolled back. Distinguish by looking for the anchored hash.
      const anchored = cp.count === 0 ? GENESIS_HASH : events[cp.count - 1]!.hash;
      if (anchored === cp.head_hash) {
        warnings.push(
          `checkpoint lag: log has ${events.length} event(s), checkpoint covers ${cp.count} ` +
          `(interrupted update — run refreshCheckpoint to repair)`,
        );
        checkpointInfo.matches = true;
      } else {
        problems.push(
          `checkpoint does not match the log at position ${cp.count} — log diverged or was rewritten`,
        );
      }
    }

    return { ok: problems.length === 0, events, problems, warnings, checkpoint: checkpointInfo };
  }

  /**
   * Re-anchor the checkpoint to the current log head.
   *
   * Only permitted when the chain itself is intact: repairing a checkpoint over
   * a broken chain would launder tampering into a valid-looking state.
   */
  static refreshCheckpoint(filePath: string, opts: LockOptions = {}): Checkpoint {
    const cpPath = checkpointPathFor(filePath);
    return withFileLock(filePath, opts, () => {
      const check = AuditTrail.verify(filePath, { checkpointPath: cpPath });
      const chainProblems = check.problems.filter(p => !p.startsWith('log truncated') && !p.startsWith('head hash') && !p.startsWith('checkpoint'));
      if (chainProblems.length > 0) {
        throw new Error(`refusing to re-anchor: chain is broken (${chainProblems[0]})`);
      }
      if (check.events.length < (check.checkpoint.count ?? 0)) {
        throw new Error('refusing to re-anchor: log is shorter than the checkpoint (truncation)');
      }
      const tail = readTail(filePath);
      const cp: Checkpoint = {
        version: 1,
        count: tail.count,
        head_hash: tail.lastHash,
        updated_at: new Date().toISOString(),
        session_id: check.events.length > 0 ? check.events[check.events.length - 1]!.session_id : 'none',
      };
      writeCheckpointAtomic(cpPath, cp);
      return cp;
    });
  }
}

/** Write the checkpoint atomically: temp file in the same dir, then rename. */
export function writeCheckpointAtomic(path: string, cp: Checkpoint): void {
  assertNoSecrets(cp, 'checkpoint');
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(cp) + '\n', { encoding: 'utf8' });
  renameSync(tmp, path);
}
