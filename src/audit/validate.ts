/**
 * Strict input validation for audit events (TASK 14).
 *
 * Before this module existed, `AuditTrail.record()` built the event from a fixed
 * field set by spread. An unknown top-level key — `{ outcome, privateKey: 'x' }` —
 * was dropped *before* `assertNoSecrets()` ever saw it. Nothing leaked, but the
 * caller got a success return and no indication that the field was never recorded,
 * and the secret guard was silently bypassed for that input shape.
 *
 * Policy here is fail-closed: an event that is not exactly the documented shape is
 * rejected with a named reason. Validation runs BEFORE `assertNoSecrets()`, so a
 * rejected event is never hashed, never appended, and never written to a checkpoint.
 *
 * Two things this deliberately does NOT do:
 *   - change the canonical serialization or any hash (TASK 06 contract is frozen)
 *   - accept a field "for convenience" — adding a field to the schema is a change
 *     that must be made here, visibly, with a test.
 */

import type { AuditEventType, AuditOutcome } from './trail.js';

// ─── the accepted shape ──────────────────────────────────────────────────

const EVENT_TYPES: readonly string[] = [
  'agent.discovered',
  'agent.card.retrieved',
  'agent.trust.verified',
  'agent.trust.rejected',
  'payment.requirement.created',
  'payment.payload.received',
  'payment.verified',
  'payment.rejected',
  'payment.settlement.simulated',
  'commerce.access.granted',
  'commerce.access.denied',
];

const OUTCOMES: readonly string[] = ['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_TESTED', 'INFO'];

/** Caller-supplied fields of `record()`. Everything else is generated. */
export const RECORD_FIELDS = ['outcome', 'reason', 'agent', 'payment', 'evidence_ref'] as const;

export const AGENT_FIELDS = ['token_id', 'token_address', 'owner_account', 'agent_uri', 'metadata_sha256'] as const;

export const PAYMENT_FIELDS = [
  'requirement_id',
  'amount',
  'asset',
  'network',
  'pay_to',
  'payer',
  'transaction',
] as const;

/** Field → expected primitive type. `undefined` values are treated as absent. */
const AGENT_TYPES: Record<string, 'string' | 'number'> = {
  token_id: 'number',
  token_address: 'string',
  owner_account: 'string',
  agent_uri: 'string',
  metadata_sha256: 'string',
};

const PAYMENT_TYPES: Record<string, 'string'> = {
  requirement_id: 'string',
  amount: 'string',
  asset: 'string',
  network: 'string',
  pay_to: 'string',
  payer: 'string',
  transaction: 'string',
};

// ─── error type ──────────────────────────────────────────────────────────

/** Raised when an event does not match the documented contract. Never a secret leak. */
export class AuditEventValidationError extends Error {
  constructor(
    readonly code:
      | 'INVALID_TYPE'
      | 'INVALID_FIELDS'
      | 'INVALID_AGENT_FIELDS'
      | 'INVALID_PAYMENT_FIELDS'
      | 'INVALID_OUTCOME'
      | 'INVALID_FIELD_TYPE'
      | 'INVALID_RECORD',
    message: string,
  ) {
    super(message);
    this.name = 'AuditEventValidationError';
  }
}

// ─── validators ──────────────────────────────────────────────────────────

function isPresent(v: unknown): boolean {
  return v !== undefined;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuditEventValidationError('INVALID_FIELD_TYPE', `${label} must be a plain object`);
  }
}

/**
 * Keys that are never acceptable anywhere, whatever the schema says. Kept in sync
 * with `assertNoSecrets()` in trail.ts: a secret-named key in a *rejected* position
 * still has to be reported as a secret-bearing field, not as a mere schema slip.
 */
const SECRET_KEY = /(private|secret|seed|mnemonic|passphrase|password|signerkey|apikey)/i;

/** Reject keys that are not in the allowlist. Reports every offender, not just the first. */
function assertKnownKeys(obj: Record<string, unknown>, allowed: readonly string[], label: string, code: AuditEventValidationError['code']): void {
  const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
  if (unknown.length === 0) return;

  // A secret-named key is a security event, not a typo: say so explicitly so the
  // error cannot be mistaken for a harmless field-name slip.
  const secret = unknown.find(k => SECRET_KEY.test(k));
  if (secret) {
    throw new AuditEventValidationError(
      code,
      `audit refused: ${label}.${secret} is a secret-bearing field (not an accepted field: ${allowed.join(', ')})`,
    );
  }

  throw new AuditEventValidationError(
    code,
    `${label} has unknown field(s): ${unknown.join(', ')}. ` +
      `Accepted: ${allowed.join(', ')}`,
  );
}

function assertNestedTypes(
  obj: Record<string, unknown>,
  types: Record<string, 'string' | 'number'>,
  label: string,
): void {
  for (const [k, v] of Object.entries(obj)) {
    if (!isPresent(v)) continue; // absent optional field
    const expected = types[k]!;
    if (typeof v !== expected) {
      throw new AuditEventValidationError(
        'INVALID_FIELD_TYPE',
        `${label}.${k} must be a ${expected}, got ${Array.isArray(v) ? 'array' : typeof v}`,
      );
    }
  }
}

/**
 * Validate an event type. Accepts the union plus any string, and rejects anything
 * not in the enumerated set — a typo must not create an unqueryable event class.
 */
export function assertEventType(type: unknown): asserts type is AuditEventType {
  if (typeof type !== 'string') {
    throw new AuditEventValidationError('INVALID_TYPE', `event type must be a string, got ${typeof type}`);
  }
  if (!EVENT_TYPES.includes(type)) {
    throw new AuditEventValidationError(
      'INVALID_TYPE',
      `unknown event type '${type}'. Accepted: ${EVENT_TYPES.join(', ')}`,
    );
  }
}

/**
 * Validate the `fields` argument of `record()`.
 *
 * Fails closed on: unknown top-level keys, unknown nested keys, wrong primitive
 * types, wrong outcome, and a non-object input. `undefined` optional values are
 * accepted and treated as absent, matching the pre-existing behaviour for callers
 * that pass `{ reason: cond ? 'x' : undefined }`.
 */
export function validateRecordFields(fields: unknown): void {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new AuditEventValidationError(
      'INVALID_RECORD',
      `record() fields must be a plain object, got ${Array.isArray(fields) ? 'array' : typeof fields}`,
    );
  }
  const f = fields as Record<string, unknown>;

  assertKnownKeys(f, RECORD_FIELDS, 'record() fields', 'INVALID_FIELDS');

  // outcome is required.
  if (!isPresent(f['outcome'])) {
    throw new AuditEventValidationError(
      'INVALID_FIELD_TYPE',
      `record() fields.outcome is required (one of ${OUTCOMES.join(', ')})`,
    );
  }
  if (typeof f['outcome'] !== 'string' || !OUTCOMES.includes(f['outcome'])) {
    throw new AuditEventValidationError(
      'INVALID_OUTCOME',
      `record() fields.outcome must be one of ${OUTCOMES.join(', ')}, got ${String(f['outcome'])}`,
    );
  }

  // reason / evidence_ref: optional strings.
  for (const k of ['reason', 'evidence_ref'] as const) {
    if (isPresent(f[k]) && typeof f[k] !== 'string') {
      throw new AuditEventValidationError(
        'INVALID_FIELD_TYPE',
        `record() fields.${k} must be a string, got ${Array.isArray(f[k]) ? 'array' : typeof f[k]}`,
      );
    }
  }

  // agent: optional object, allowlisted keys, typed values.
  if (isPresent(f['agent'])) {
    assertPlainObject(f['agent'], 'record() fields.agent');
    const agent = f['agent'] as Record<string, unknown>;
    assertKnownKeys(agent, AGENT_FIELDS, 'record() fields.agent', 'INVALID_AGENT_FIELDS');
    assertNestedTypes(agent, AGENT_TYPES, 'record() fields.agent');
  }

  // payment: optional object, allowlisted keys, typed values.
  if (isPresent(f['payment'])) {
    assertPlainObject(f['payment'], 'record() fields.payment');
    const payment = f['payment'] as Record<string, unknown>;
    assertKnownKeys(payment, PAYMENT_FIELDS, 'record() fields.payment', 'INVALID_PAYMENT_FIELDS');
    assertNestedTypes(payment, PAYMENT_TYPES, 'record() fields.payment');
  }
}

export { EVENT_TYPES, OUTCOMES };
