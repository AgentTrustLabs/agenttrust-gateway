/**
 * TASK 07 — operator signing boundary.
 *
 * The gateway never holds a key. This module defines the *only* sanctioned way a
 * real x402 payment may become signable, and it is deliberately incapable of
 * signing anything itself:
 *
 *   1. `requestSigning` validates the requirement against the facilitator and the
 *      operator's declared intent, then emits a **signing request** (a description
 *      of what must be signed).
 *   2. An out-of-process signer — the Concordium Wallet, or an operator-run
 *      process — produces the partially-signed V1 transaction.
 *   3. `acceptSignature` validates the returned payload's *structure* (never a
 *      signature validity claim) and hands it to the payment gate.
 *
 * Authorization is a distinct object from signing on purpose: holding an
 * authorization does not give the gateway a key, and a signed payload without a
 * matching authorization is rejected.
 */

import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import {
  CCD_ASSET,
  CCD_TESTNET_CAIP2,
  X402_VERSION,
  isConcordiumAccount,
  type ConsumerFacilitator,
} from './x402.js';
import type { Compatibility } from './facilitator.js';

// ─── authorization ───────────────────────────────────────────────────────

export interface OperatorAuthorization {
  /** Opaque id for correlating logs and audit events. Never a secret. */
  authorization_id: string;
  /** Who asserted the authorization (operator label, not a credential). */
  issued_by: string;
  /** ISO-8601 UTC. */
  issued_at: string;
  /** The exact terms the operator approved. Any drift invalidates it. */
  terms: {
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    /** Sponsor named in the payload header; must equal the facilitator's feePayer. */
    feePayer: string;
    /** Resource the payment buys. */
    resourceUrl: string;
  };
  /**
   * Hard ceiling in atomic units. An authorization can never approve more than
   * this, even if the requirement says so.
   */
  maxAmountMicroCcd: string;
}

export interface AuthorizationViolation {
  code:
    | 'NO_AUTHORIZATION'
    | 'AUTHORIZATION_EXPIRED'
    | 'AMOUNT_EXCEEDS_AUTHORIZATION'
    | 'TERMS_MISMATCH'
    | 'AUTHORIZATION_MALFORMED';
  reason: string;
}

/**
 * Check an authorization against a requirement.
 *
 * Fails closed on any ambiguity: a missing authorization, a malformed one, an
 * amount above the ceiling, or any term that does not match exactly.
 */
export function checkAuthorization(
  authorization: OperatorAuthorization | null | undefined,
  requirements: PaymentRequirements,
  opts: { nowSeconds?: number; maxAgeSeconds?: number; resourceUrl?: string } = {},
): { ok: true } | { ok: false; violation: AuthorizationViolation } {
  if (!authorization) {
    return { ok: false, violation: { code: 'NO_AUTHORIZATION', reason: 'no operator authorization supplied' } };
  }

  const a = authorization;
  if (
    typeof a.authorization_id !== 'string' ||
    typeof a.issued_by !== 'string' ||
    typeof a.issued_at !== 'string' ||
    !a.terms ||
    typeof a.maxAmountMicroCcd !== 'string' ||
    !/^\d+$/.test(a.maxAmountMicroCcd)
  ) {
    return {
      ok: false,
      violation: { code: 'AUTHORIZATION_MALFORMED', reason: 'authorization is missing required fields' },
    };
  }

  const now = opts.nowSeconds ?? Date.now() / 1000;
  const maxAge = opts.maxAgeSeconds ?? 900; // 15 minutes
  const issued = Date.parse(a.issued_at);
  if (!Number.isFinite(issued)) {
    return { ok: false, violation: { code: 'AUTHORIZATION_MALFORMED', reason: 'issued_at is not a valid timestamp' } };
  }
  if (now - issued / 1000 > maxAge) {
    return {
      ok: false,
      violation: { code: 'AUTHORIZATION_EXPIRED', reason: `authorization is older than ${maxAge}s` },
    };
  }

  if (BigInt(requirements.amount) > BigInt(a.maxAmountMicroCcd)) {
    return {
      ok: false,
      violation: {
        code: 'AMOUNT_EXCEEDS_AUTHORIZATION',
        reason: `amount ${requirements.amount} exceeds authorized ceiling ${a.maxAmountMicroCcd}`,
      },
    };
  }

  const expected: [string, string][] = [
    ['network', requirements.network],
    ['asset', requirements.asset],
    ['amount', requirements.amount],
    ['payTo', requirements.payTo],
    ['feePayer', String((requirements.extra ?? {}).feePayer ?? '')],
  ];
  for (const [field, actual] of expected) {
    const approved = a.terms[field as keyof OperatorAuthorization['terms']];
    if (approved !== actual) {
      return {
        ok: false,
        violation: {
          code: 'TERMS_MISMATCH',
          reason: `authorization term ${field} is ${String(approved)}, requirement has ${actual}`,
        },
      };
    }
  }
  if (opts.resourceUrl !== undefined && a.terms.resourceUrl !== opts.resourceUrl) {
    return {
      ok: false,
      violation: {
        code: 'TERMS_MISMATCH',
        reason: `authorization resourceUrl is ${a.terms.resourceUrl}, request is ${opts.resourceUrl}`,
      },
    };
  }

  return { ok: true };
}

// ─── signing request ─────────────────────────────────────────────────────

export interface SigningRequest {
  /** What must be signed, in the shape the wallet/SDK expects. */
  x402Version: number;
  requirements: PaymentRequirements;
  /** Exactly what the signer must produce. */
  produce: {
    transaction_version: 1;
    sender: string;
    sponsor_in_header: string;
    /** Energy / expiry guidance only; the signer decides. */
    max_expiry_seconds: number;
    /** Fields that MUST be present in the returned payload. */
    required_fields: string[];
  };
  /** Human-readable statement of what is being signed. */
  statement: string;
}

/**
 * Build a signing request. Refuses when the facilitator is unusable, the
 * requirement is incompatible, or no authorization is present.
 */
export function requestSigning(input: {
  requirements: PaymentRequirements;
  facilitator: Compatibility;
  authorization: OperatorAuthorization | null | undefined;
  resourceUrl: string;
  sender: string;
  nowSeconds?: number;
}): { ok: true; request: SigningRequest } | { ok: false; code: string; reason: string } {
  const { requirements, facilitator, authorization, resourceUrl, sender } = input;

  if (!facilitator.usable || !facilitator.feePayer) {
    return { ok: false, code: 'FACILITATOR_UNUSABLE', reason: `facilitator unusable: ${facilitator.code}` };
  }
  if (!isConcordiumAccount(sender)) {
    return { ok: false, code: 'INVALID_SENDER', reason: `sender is not a Concordium account: ${String(sender)}` };
  }
  if (requirements.asset !== CCD_ASSET) {
    return { ok: false, code: 'UNSUPPORTED_ASSET', reason: `asset ${requirements.asset} is not CCD` };
  }
  if (requirements.network !== CCD_TESTNET_CAIP2 && requirements.network !== facilitator.kind?.network) {
    return { ok: false, code: 'UNSUPPORTED_NETWORK', reason: `network ${requirements.network} not supported` };
  }
  const rpFee = String((requirements.extra ?? {}).feePayer ?? '');
  if (rpFee !== facilitator.feePayer) {
    return {
      ok: false,
      code: 'FEE_PAYER_MISMATCH',
      reason: `requirements feePayer ${rpFee || '(none)'} != facilitator sponsor ${facilitator.feePayer}`,
    };
  }

  const auth = checkAuthorization(authorization, requirements, {
    ...(input.nowSeconds !== undefined ? { nowSeconds: input.nowSeconds } : {}),
    resourceUrl,
  });
  if (!auth.ok) {
    return { ok: false, code: auth.violation.code, reason: auth.violation.reason };
  }

  return {
    ok: true,
    request: {
      x402Version: X402_VERSION,
      requirements,
      produce: {
        transaction_version: 1,
        sender,
        sponsor_in_header: facilitator.feePayer,
        max_expiry_seconds: requirements.maxTimeoutSeconds,
        required_fields: [
          'version',
          'header.sender',
          'header.nonce',
          'header.expiry',
          'header.numSignatures',
          'header.sponsor.address',
          'payload.type',
          'payload.toAddress',
          'payload.amount',
          'signatures.sender',
          'signatures.sponsor',
        ],
      },
      statement:
        `Pay ${requirements.amount} microCCD (${requirements.asset}) to ${requirements.payTo} ` +
        `on ${requirements.network}, sponsored by ${facilitator.feePayer}, ` +
        `authorization ${authorization!.authorization_id} issued by ${authorization!.issued_by}.`,
    },
  };
}

// ─── payload acceptance (structure only) ─────────────────────────────────

export interface StructuralCheck {
  ok: boolean;
  problems: string[];
  /** Extracted facts, for the audit trail. Never includes signature bytes. */
  facts: {
    sender?: string;
    sponsor?: string;
    nonce?: number;
    expiry?: number;
    transferTo?: string;
    transferAmount?: string;
  };
}

/**
 * Validate the *structure* of a returned payload and cross-check it against the
 * requirement. Signature validity is deliberately NOT evaluated here: only a
 * facilitator may make that claim (rule 8), and pretending otherwise would be
 * unverified security theatre.
 *
 * Signature bytes are never copied into `facts`, so they cannot leak into logs.
 */
export function inspectSignedPayload(
  payload: unknown,
  requirements: PaymentRequirements,
  expectedSponsor: string,
  nowSeconds = Date.now() / 1000,
): StructuralCheck {
  const problems: string[] = [];
  const facts: StructuralCheck['facts'] = {};

  const p = payload as Partial<PaymentPayload> | null;
  if (!p || typeof p !== 'object') return { ok: false, problems: ['payload is not an object'], facts };
  if (p.x402Version !== X402_VERSION) problems.push(`x402Version ${String(p.x402Version)} != ${X402_VERSION}`);

  const accepted = p.accepted as PaymentRequirements | undefined;
  if (!accepted) problems.push('payload.accepted is missing');
  else {
    if (accepted.network !== requirements.network) problems.push(`accepted.network ${accepted.network} != requirement`);
    if (accepted.asset !== requirements.asset) problems.push(`accepted.asset ${accepted.asset} != requirement`);
    if (String(accepted.amount) !== String(requirements.amount)) problems.push('accepted.amount != requirement');
    if (accepted.payTo !== requirements.payTo) problems.push('accepted.payTo != requirement');
    if (accepted.scheme !== requirements.scheme) problems.push('accepted.scheme != requirement');
  }

  const signed = (p.payload as { signedTransaction?: Record<string, any> } | undefined)?.signedTransaction;
  if (!signed) return { ok: false, problems: [...problems, 'payload.signedTransaction is missing'], facts };

  if (signed.version !== 1) problems.push(`signedTransaction.version ${String(signed.version)} != 1`);
  const header = signed.header ?? {};
  if (!isConcordiumAccount(header.sender)) problems.push('header.sender is not a Concordium account');
  else facts.sender = header.sender;

  if (!Number.isInteger(header.nonce)) problems.push('header.nonce is not an integer');
  else facts.nonce = header.nonce;

  if (!Number.isFinite(header.expiry)) problems.push('header.expiry is not a number');
  else {
    facts.expiry = header.expiry;
    if (header.expiry <= nowSeconds) problems.push('header.expiry is in the past (expired)');
    else if (header.expiry > nowSeconds + requirements.maxTimeoutSeconds) {
      problems.push(`header.expiry exceeds now + maxTimeoutSeconds (${requirements.maxTimeoutSeconds})`);
    }
  }

  const sponsorAddr = header.sponsor?.address ?? header.sponsor?.account;
  if (!sponsorAddr) problems.push('header.sponsor.address is missing');
  else {
    facts.sponsor = sponsorAddr;
    if (sponsorAddr !== expectedSponsor) problems.push(`header.sponsor ${sponsorAddr} != facilitator ${expectedSponsor}`);
  }

  const txPayload = signed.payload ?? {};
  if (txPayload.type !== 'transfer' && txPayload.type !== 'transferWithMemo') {
    problems.push(`payload.type ${String(txPayload.type)} is not a CCD simple transfer`);
  } else {
    facts.transferTo = txPayload.toAddress;
    facts.transferAmount = String(txPayload.amount);
    if (txPayload.toAddress !== requirements.payTo) problems.push('transfer.toAddress != requirement.payTo');
    if (String(txPayload.amount) !== String(requirements.amount)) problems.push('transfer.amount != requirement.amount');
  }

  const sigs = signed.signatures ?? {};
  const senderSigs = sigs.sender ?? {};
  if (!senderSigs || Object.keys(senderSigs).length === 0) problems.push('signatures.sender is empty');
  const sponsorSigs = sigs.sponsor ?? {};
  if (Object.keys(sponsorSigs).length > 0) {
    problems.push('signatures.sponsor must be empty (only the facilitator may sponsor)');
  }

  return { ok: problems.length === 0, problems, facts };
}

// ─── settlement gate wrapper ─────────────────────────────────────────────

/**
 * The sanctioned path to settlement. Every precondition is re-checked here so a
 * caller cannot reach `facilitator.settle` by holding a valid-looking payload.
 *
 * This function performs NO settlement itself — it delegates to the caller's
 * `settle` callback, which is expected to be `authorizePayment({settle:true})`.
 * In non-settling mode (`allowSettlement:false`) it refuses before the callback.
 */
export function guardSettlement(input: {
  allowSettlement: boolean;
  payload: unknown;
  requirements: PaymentRequirements;
  expectedSponsor: string;
  authorization: OperatorAuthorization | null | undefined;
  nowSeconds?: number;
}): { ok: true } | { ok: false; code: string; reason: string } {
  if (!input.allowSettlement) {
    return {
      ok: false,
      code: 'SETTLEMENT_DISABLED',
      reason: 'settlement is disabled: TASK 07 never settles, and the flag must be enabled explicitly',
    };
  }
  const auth = checkAuthorization(input.authorization, input.requirements, {
    ...(input.nowSeconds !== undefined ? { nowSeconds: input.nowSeconds } : {}),
  });
  if (!auth.ok) return { ok: false, code: auth.violation.code, reason: auth.violation.reason };

  const check = inspectSignedPayload(
    input.payload,
    input.requirements,
    input.expectedSponsor,
    input.nowSeconds ?? Date.now() / 1000,
  );
  if (!check.ok) return { ok: false, code: 'PAYLOAD_INVALID', reason: check.problems.join('; ') };

  return { ok: true };
}

/** A facilitator that refuses everything — the project default. Re-exported for clarity. */
export type { ConsumerFacilitator };
