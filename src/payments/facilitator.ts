/**
 * TASK 07 — facilitator readiness probe and response validation.
 *
 * Read-only by construction:
 *   - `probeFacilitator` only calls `/supported` (a capability query).
 *   - `validateSupported` classifies the answer against what our payment module needs.
 *   - Settlement is never invoked. There is no code here that can reach `/settle`
 *     or `/verify`.
 *
 * Pure functions for validation so the whole surface is testable offline; the
 * HTTP probe takes an injected fetch.
 */

import type { PaymentRequirements } from '@x402/core/types';
import { CCD_TESTNET_CAIP2, X402_VERSION, CCD_ASSET } from '../payments/x402.js';

// ─── capability discovery ────────────────────────────────────────────────

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions?: string[];
  signers?: Record<string, string[]>;
}

export type ProbeOutcome =
  | { ok: true; status: number; body: SupportedResponse; url: string; elapsedMs: number }
  | { ok: false; status: number | null; error: string; kind: ProbeFailureKind; url: string; elapsedMs: number };

export type ProbeFailureKind =
  | 'dns_or_tls_failure'
  | 'connection_refused'
  | 'timeout'
  | 'http_error'
  | 'invalid_json'
  | 'invalid_shape';

export interface ProbeOptions {
  /** Base URL of the facilitator, e.g. https://host/facilitator */
  url: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * Query `/supported` only. No other endpoint is ever contacted.
 * Returns a classified failure rather than throwing, so callers can decide policy.
 */
export async function probeFacilitator(
  opts: ProbeOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeOutcome> {
  const url = `${opts.url.replace(/\/+$/, '')}/supported`;
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: opts.headers ?? {}, signal: ac.signal });
    } catch (e) {
      const elapsedMs = Date.now() - started;
      const msg = (e as Error).message ?? String(e);
      const kind: ProbeFailureKind =
        (e as Error).name === 'AbortError'
          ? 'timeout'
          : /ENOTFOUND|EAI_AGAIN|getaddrinfo|certificate|CERT_|self.signed|unable to verify/i.test(msg)
            ? 'dns_or_tls_failure'
            : /ECONNREFUSED/i.test(msg)
              ? 'connection_refused'
              : 'dns_or_tls_failure';
      return { ok: false, status: null, error: msg, kind, url, elapsedMs };
    }

    const elapsedMs = Date.now() - started;
    const text = await res.text();

    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, kind: 'http_error', url, elapsedMs };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, error: 'response is not JSON', kind: 'invalid_json', url, elapsedMs };
    }

    const shape = validateSupportedShape(parsed);
    if (!shape.ok) {
      return { ok: false, status: res.status, error: shape.reason, kind: 'invalid_shape', url, elapsedMs };
    }

    return { ok: true, status: res.status, body: parsed as SupportedResponse, url, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

/** Structural validation of a `/supported` payload. */
export function validateSupportedShape(
  body: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'body is not an object' };
  }
  const b = body as Partial<SupportedResponse>;
  if (!Array.isArray(b.kinds)) return { ok: false, reason: 'missing or non-array "kinds"' };
  for (const [i, k] of b.kinds.entries()) {
    if (!k || typeof k !== 'object') return { ok: false, reason: `kinds[${i}] is not an object` };
    if (typeof (k as SupportedKind).x402Version !== 'number') {
      return { ok: false, reason: `kinds[${i}].x402Version is not a number` };
    }
    if (typeof (k as SupportedKind).scheme !== 'string') {
      return { ok: false, reason: `kinds[${i}].scheme is not a string` };
    }
    if (typeof (k as SupportedKind).network !== 'string') {
      return { ok: false, reason: `kinds[${i}].network is not a string` };
    }
  }
  if (b.extensions !== undefined && !Array.isArray(b.extensions)) {
    return { ok: false, reason: '"extensions" must be an array when present' };
  }
  if (b.signers !== undefined && (typeof b.signers !== 'object' || b.signers === null)) {
    return { ok: false, reason: '"signers" must be an object when present' };
  }
  return { ok: true };
}

// ─── compatibility classification ────────────────────────────────────────

export interface Compatibility {
  /** Can we construct a requirement this facilitator would accept? */
  usable: boolean;
  /** Machine-readable block reason. */
  code:
    | 'OK'
    | 'PROBE_FAILED'
    | 'NO_KINDS'
    | 'NO_CCD_NETWORK'
    | 'NO_EXACT_SCHEME'
    | 'WRONG_X402_VERSION'
    | 'NO_FEE_PAYER';
  reason: string;
  /** The matching kind, when usable. */
  kind?: SupportedKind;
  /** Sponsor address the facilitator announced, when present. */
  feePayer?: string;
  /** Every network the facilitator advertises (for reporting). */
  networks: string[];
  /** Every scheme advertised on our network. */
  schemesOnNetwork: string[];
}

/**
 * Decide whether a facilitator can serve an `exact` CCD payment on our network.
 *
 * A facilitator is only usable when it announces:
 *   - x402Version 2,
 *   - scheme exactly `exact`,
 *   - our CAIP-2 network,
 *   - a sponsor address in `extra.feePayer` (or `extra.facilitatorAddress`).
 *
 * Anything else is a hard block — we never fall back to another network or scheme.
 */
export function classifyCompatibility(
  body: SupportedResponse,
  network: string = CCD_TESTNET_CAIP2,
): Compatibility {
  const kinds = body.kinds ?? [];
  const networks = [...new Set(kinds.map(k => k.network))].sort();
  const schemesOnNetwork = [...new Set(kinds.filter(k => k.network === network).map(k => k.scheme))].sort();

  if (kinds.length === 0) {
    return { usable: false, code: 'NO_KINDS', reason: 'facilitator advertises no payment kinds', networks, schemesOnNetwork };
  }
  if (!networks.includes(network)) {
    return {
      usable: false,
      code: 'NO_CCD_NETWORK',
      reason: `facilitator does not advertise ${network} (advertises: ${networks.join(', ')})`,
      networks,
      schemesOnNetwork,
    };
  }
  if (!schemesOnNetwork.includes('exact')) {
    return {
      usable: false,
      code: 'NO_EXACT_SCHEME',
      reason: `facilitator advertises no 'exact' scheme on ${network} (offers: ${schemesOnNetwork.join(', ')})`,
      networks,
      schemesOnNetwork,
    };
  }

  const exactV2 = kinds.find(k => k.network === network && k.scheme === 'exact' && k.x402Version === X402_VERSION);
  if (!exactV2) {
    const versions = kinds
      .filter(k => k.network === network && k.scheme === 'exact')
      .map(k => k.x402Version);
    return {
      usable: false,
      code: 'WRONG_X402_VERSION',
      reason: `exact on ${network} is announced only for x402Version ${versions.join('/')} (need ${X402_VERSION})`,
      networks,
      schemesOnNetwork,
    };
  }

  const extra = (exactV2.extra ?? {}) as Record<string, unknown>;
  const feePayer =
    (typeof extra.feePayer === 'string' && extra.feePayer) ||
    (typeof extra.facilitatorAddress === 'string' && extra.facilitatorAddress) ||
    undefined;

  if (!feePayer) {
    return {
      usable: false,
      code: 'NO_FEE_PAYER',
      reason: 'facilitator does not announce a sponsor address in extra.feePayer',
      kind: exactV2,
      networks,
      schemesOnNetwork,
    };
  }

  return {
    usable: true,
    code: 'OK',
    reason: `exact v2 with feePayer ${feePayer}`,
    kind: exactV2,
    feePayer,
    networks,
    schemesOnNetwork,
  };
}

/**
 * Validate that a requirement we built is acceptable for a given facilitator
 * announcement. Rejects network/scheme/asset/version mismatch and a missing or
 * foreign fee payer — the local mirror of rule 3.
 */
export function validateRequirementAgainstFacilitator(
  requirements: PaymentRequirements,
  compat: Compatibility,
): { ok: true } | { ok: false; reason: string } {
  if (!compat.usable || !compat.kind) {
    return { ok: false, reason: `facilitator unusable: ${compat.code}` };
  }
  if (requirements.scheme !== 'exact') {
    return { ok: false, reason: `requirements use scheme '${requirements.scheme}', facilitator serves 'exact'` };
  }
  if (requirements.network !== compat.kind.network) {
    return {
      ok: false,
      reason: `requirements network ${requirements.network} != facilitator network ${compat.kind.network}`,
    };
  }
  if (requirements.asset !== CCD_ASSET) {
    return { ok: false, reason: `requirements asset ${requirements.asset} is not native CCD` };
  }
  const rpFee = (requirements.extra ?? {}).feePayer;
  if (!rpFee) {
    return { ok: false, reason: 'requirements carry no extra.feePayer; the client cannot name a sponsor' };
  }
  if (compat.feePayer && rpFee !== compat.feePayer) {
    return {
      ok: false,
      reason: `requirements feePayer ${String(rpFee)} != facilitator sponsor ${compat.feePayer}`,
    };
  }
  return { ok: true };
}
