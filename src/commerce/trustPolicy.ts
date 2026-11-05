/**
 * Trust policy — decides whether an independently verified agent may transact.
 *
 * The policy consumes the TASK 03 `TrustResult` and nothing else. It never reads
 * the provider's own claims: the card is already folded into that result by the
 * verifier, so re-reading it here could only weaken the decision.
 *
 * Defaults are deny-by-default: any non-PASS required check blocks commerce.
 */

import type { TrustResult, Verdict } from '../verify/crossAgent.js';

/** Checks that must be PASS for commerce to be permitted. */
export const DEFAULT_REQUIRED_CHECKS = [
  'agent_discovered',
  'card_retrieved',
  'card_valid',
  'hash_matches_on_chain',
  'owner_matches',
  'status_active',
  'contract_references_match',
] as const;

/** Every check the verifier reports, including the advisory badge check. */
export type RequiredCheck =
  | (typeof DEFAULT_REQUIRED_CHECKS)[number]
  | 'badge_valid';

export interface TrustPolicy {
  /** Checks that must all be PASS. */
  require: readonly RequiredCheck[];
  /** Maximum amount (microCCD) this policy permits in one payment. */
  maxAmountMicroCcd?: string;
  /** Networks commerce may settle on. */
  allowedNetworks?: readonly string[];
  /** Asset identifiers commerce may settle in. */
  allowedAssets?: readonly string[];
  /** Permit agents the hosted badge checker has not confirmed. Advisory only. */
  allowBadgeNotTested?: boolean;
}

export const STRICT_POLICY: TrustPolicy = {
  require: DEFAULT_REQUIRED_CHECKS,
  allowBadgeNotTested: true, // badge_valid is corroboration; local checks decide
};

export const PARANOID_POLICY: TrustPolicy = {
  require: [...DEFAULT_REQUIRED_CHECKS, 'badge_valid'],
  allowBadgeNotTested: false,
};

export interface CommerceIntent {
  amountMicroCcd: string;
  asset: string;
  network: string;
}

export interface TrustPolicyDecision {
  allowed: boolean;
  /** Machine-readable code for the audit trail. */
  code: 'ALLOWED' | 'TRUST_REJECTED' | 'TRUST_INCONCLUSIVE' | 'CHECK_NOT_PASS' | 'AMOUNT_EXCEEDED' | 'ASSET_NOT_ALLOWED' | 'NETWORK_NOT_ALLOWED';
  /** Human-readable explanation, safe to log. */
  reason: string;
  /** Per-requirement evaluation, in policy order. */
  evaluated: { check: string; value: Verdict; required: boolean; ok: boolean }[];
}

/** Evaluate a trust result against a policy, optionally with a commerce intent. */
export function evaluateTrustPolicy(
  result: TrustResult,
  policy: TrustPolicy = STRICT_POLICY,
  intent?: CommerceIntent,
): TrustPolicyDecision {
  const evaluated = policy.require.map(check => {
    const value = (result[check as keyof TrustResult] ?? 'NOT_TESTED') as Verdict;
    return { check, value, required: true, ok: value === 'PASS' };
  });

  // The verifier's own verdict is authoritative first: a REJECTED result can
  // never be rescued by individual checks, and INCONCLUSIVE is not consent.
  if (result.trust_decision === 'REJECTED') {
    const failed = evaluated.filter(e => !e.ok).map(e => `${e.check}=${e.value}`);
    return {
      allowed: false,
      code: 'TRUST_REJECTED',
      reason: `verification rejected${failed.length ? `: ${failed.join(', ')}` : ''}`,
      evaluated,
    };
  }
  if (result.trust_decision === 'INCONCLUSIVE') {
    const notPass = evaluated.filter(e => !e.ok).map(e => `${e.check}=${e.value}`);
    return {
      allowed: false,
      code: 'TRUST_INCONCLUSIVE',
      reason: `verification inconclusive${notPass.length ? `: ${notPass.join(', ')}` : ''}`,
      evaluated,
    };
  }

  const blocking = evaluated.filter(e => !e.ok);
  if (blocking.length > 0) {
    return {
      allowed: false,
      code: 'CHECK_NOT_PASS',
      reason: `required checks not satisfied: ${blocking.map(e => `${e.check}=${e.value}`).join(', ')}`,
      evaluated,
    };
  }

  // Badge advisory handling: when the policy requires it, it is already in
  // `require`; when it does not, an unconfirmed badge is tolerated but a FAIL is not.
  if (!policy.allowBadgeNotTested && result.badge_valid !== 'PASS') {
    return {
      allowed: false,
      code: 'CHECK_NOT_PASS',
      reason: `badge must be confirmed by this policy (badge_valid=${result.badge_valid})`,
      evaluated,
    };
  }
  if (policy.allowBadgeNotTested && result.badge_valid === 'FAIL') {
    return {
      allowed: false,
      code: 'CHECK_NOT_PASS',
      reason: 'hosted badge checker reported an invalid badge',
      evaluated,
    };
  }

  if (intent) {
    if (policy.allowedNetworks && !policy.allowedNetworks.includes(intent.network)) {
      return {
        allowed: false,
        code: 'NETWORK_NOT_ALLOWED',
        reason: `network ${intent.network} is not permitted by policy`,
        evaluated,
      };
    }
    if (policy.allowedAssets && !policy.allowedAssets.includes(intent.asset)) {
      return {
        allowed: false,
        code: 'ASSET_NOT_ALLOWED',
        reason: `asset ${intent.asset} is not permitted by policy`,
        evaluated,
      };
    }
    if (policy.maxAmountMicroCcd) {
      // Compare as bigint: these are integer strings in atomic units.
      const want = BigInt(intent.amountMicroCcd);
      const cap = BigInt(policy.maxAmountMicroCcd);
      if (want > cap) {
        return {
          allowed: false,
          code: 'AMOUNT_EXCEEDED',
          reason: `amount ${want} exceeds policy cap ${cap} microCCD`,
          evaluated,
        };
      }
    }
  }

  return {
    allowed: true,
    code: 'ALLOWED',
    reason: `all ${evaluated.length} required checks PASS${intent ? `; intent within policy limits` : ''}`,
    evaluated,
  };
}
