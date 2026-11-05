/**
 * x402 Exact payment module — protocol layer only.
 *
 * Scope:
 *   - declare an exact CCD payment requirement
 *   - emit a standards-compliant 402 Payment Required response
 *   - verify a payment payload through an injected facilitator
 *   - settle through an injected facilitator
 *   - produce a structured receipt
 *
 * Deliberately NOT here:
 *   - no key handling, no signing, no wallet, no credential issuance
 *   - no network I/O unless a facilitator explicitly makes it
 *   - no coupling to CIS-8004 identity or registry discovery
 *
 * The facilitator is injected behind `FacilitatorPort`, so the whole flow is
 * testable against a mock and cannot accidentally reach a real chain.
 */

import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';

/** Minimal facilitator surface required by the resource server. */
export interface ConsumerFacilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  getSupported(): Promise<{
    kinds: { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }[];
    extensions?: string[];
    signers?: Record<string, string[]>;
  }>;
}

export const X402_VERSION = 2;

/** Concordium testnet CAIP-2, as exported by @x402/concordium. */
export const CCD_TESTNET_CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
/** Native CCD asset identifier (Concordium convention; not a token contract). */
export const CCD_ASSET = 'CCD';
/** Native CCD has 6 decimals: 1 CCD = 1_000_000 microCCD. */
export const CCD_DECIMALS = 6;

/**
 * Maximum distance into the future a payment transaction expiry may sit.
 * Mirrors @x402/concordium's MAX_EXPIRY_OFFSET_SECONDS (spec rule 7).
 */
export const MAX_EXPIRY_OFFSET_SECONDS = 600;

export interface PaymentConfig {
  /** Recipient account (base58check). */
  payTo: string;
  /** Amount in atomic units (microCCD) as a decimal string. */
  amountMicroCcd: string;
  /** Seconds the requirement stays valid; the client uses this as its deadline budget. */
  maxTimeoutSeconds?: number;
  /** Human-readable description surfaced in the 402 body. */
  description?: string;
  /** Resource URL being protected. */
  resourceUrl: string;
  mimeType?: string;
  /** Facilitator sponsor address, announced via /supported and copied into extra.feePayer. */
  feePayer?: string;
  network?: string;
}

export interface PaymentReceipt {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  amount: string;
  asset: string;
  payTo: string;
  settledAt: string;
  /** Explorer URL for the settlement transaction, when derivable. */
  explorerUrl?: string;
  errorReason?: string;
  errorMessage?: string;
  /** Free-form audit metadata (e.g. agent identity). Never required for protocol correctness. */
  audit?: Record<string, unknown>;
}

/**
 * Concordium account addresses are base58check over 37 bytes and are therefore
 * ALWAYS exactly 50 characters.
 *
 * Note: @x402/concordium exports CONCORDIUM_ADDRESS_REGEX as `{45,55}`, which is
 * looser than the chain accepts — the SDK's own web-sdk dependency
 * (AccountAddress.fromBase58) rejects anything that is not exactly 50. We match
 * the chain, not the SDK's permissive shape check.
 */
const CCD_REGEX = /^[1-9A-HJ-NP-Za-km-z]{50}$/;

/** Validate a base58check Concordium account address (length + alphabet). */
export function isConcordiumAccount(value: unknown): value is string {
  return typeof value === 'string' && CCD_REGEX.test(value);
}

/** Convert a CCD decimal amount to microCCD, refusing precision loss. */
export function ccdToMicroCcd(ccd: string | number): string {
  const s = String(ccd).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    throw new Error(`invalid CCD amount "${s}": need a decimal with at most 6 places`);
  }
  const [whole, frac = ''] = s.split('.');
  return `${whole}${frac.padEnd(6, '0')}`.replace(/^0+(?=\d)/, '');
}

/** Convert microCCD back to a CCD decimal string. */
export function microCcdToCcd(micro: string): string {
  const s = micro.replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(s)) throw new Error(`invalid microCCD amount "${micro}"`);
  const padded = s.padStart(7, '0');
  const whole = padded.slice(0, -6);
  const frac = padded.slice(-6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Build `PaymentRequirements` for an exact CCD payment.
 *
 * Shape matches @x402/core `PaymentRequirements` exactly:
 *   { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra }
 * `extra.feePayer` is where the facilitator's sponsor address is carried.
 */
export function buildPaymentRequirements(config: PaymentConfig): PaymentRequirements {
  if (!isConcordiumAccount(config.payTo)) {
    throw new Error(`payTo is not a valid Concordium account: ${String(config.payTo)}`);
  }
  if (!/^\d+$/.test(config.amountMicroCcd)) {
    throw new Error(`amount must be an integer string in microCCD, got "${config.amountMicroCcd}"`);
  }
  if (BigInt(config.amountMicroCcd) <= 0n) {
    throw new Error('amount must be greater than zero');
  }
  const timeout = config.maxTimeoutSeconds ?? 300;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error('maxTimeoutSeconds must be a positive integer');
  }
  const extra: Record<string, unknown> = {};
  if (config.feePayer !== undefined) {
    if (!isConcordiumAccount(config.feePayer)) {
      throw new Error(`feePayer is not a valid Concordium account: ${String(config.feePayer)}`);
    }
    extra.feePayer = config.feePayer;
  }

  return {
    scheme: 'exact',
    network: (config.network ?? CCD_TESTNET_CAIP2) as PaymentRequirements['network'],
    asset: CCD_ASSET,
    amount: config.amountMicroCcd,
    payTo: config.payTo,
    maxTimeoutSeconds: timeout,
    extra,
  };
}

/**
 * Build the 402 body. Field names follow @x402/core `PaymentRequired`:
 *   { x402Version, error?, resource, accepts[], extensions? }
 */
export function buildPaymentRequired(
  requirements: PaymentRequirements,
  config: Pick<PaymentConfig, 'resourceUrl' | 'description' | 'mimeType'>,
  error = 'X-PAYMENT header is required',
): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error,
    resource: {
      url: config.resourceUrl,
      ...(config.description ? { description: config.description } : {}),
      ...(config.mimeType ? { mimeType: config.mimeType } : {}),
    },
    accepts: [requirements],
  };
}

/**
 * Validate a client-supplied payment payload against our requirements before
 * asking any facilitator. Cheap local pre-checks only; the facilitator remains
 * authoritative for signatures and amount.
 */
export function preflightPaymentPayload(
  payload: unknown,
  requirements: PaymentRequirements,
  /** Unix seconds. Injectable so expiry handling is deterministic under test. */
  nowSeconds: number = Date.now() / 1000,
): { ok: true } | { ok: false; reason: string } {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'payment payload is missing or not an object' };
  }
  const p = payload as Partial<PaymentPayload>;
  if (p.x402Version !== X402_VERSION) {
    return { ok: false, reason: `unsupported x402Version ${String(p.x402Version)} (expected ${X402_VERSION})` };
  }
  if (!p.accepted || typeof p.accepted !== 'object') {
    return { ok: false, reason: 'payment payload has no accepted requirements' };
  }
  const a = p.accepted as PaymentRequirements;
  if (a.scheme !== requirements.scheme) {
    return { ok: false, reason: `scheme mismatch: accepted=${a.scheme} required=${requirements.scheme}` };
  }
  if (a.network !== requirements.network) {
    return { ok: false, reason: `network mismatch: accepted=${a.network} required=${requirements.network}` };
  }
  if (a.asset !== requirements.asset) {
    return { ok: false, reason: `asset mismatch: accepted=${a.asset} required=${requirements.asset}` };
  }
  if (String(a.amount) !== String(requirements.amount)) {
    return { ok: false, reason: `amount mismatch: accepted=${a.amount} required=${requirements.amount}` };
  }
  if (a.payTo !== requirements.payTo) {
    return { ok: false, reason: `payTo mismatch: accepted=${a.payTo} required=${requirements.payTo}` };
  }
  if (!p.payload || typeof p.payload !== 'object') {
    return { ok: false, reason: 'payment payload has no payload body' };
  }

  const expiryCheck = checkTransactionExpiry(p.payload, nowSeconds);
  if (!expiryCheck.ok) return expiryCheck;

  return { ok: true };
}

/**
 * Spec rule 7, checked locally so an expired or over-far-future payment never
 * reaches a facilitator. `nowSeconds` is injectable so tests stay deterministic.
 *
 * Only applies to payloads that carry a Concordium V1 transaction expiry; other
 * payload shapes are left to the facilitator.
 */
export function checkTransactionExpiry(
  payloadBody: unknown,
  nowSeconds: number,
): { ok: true } | { ok: false; reason: string } {
  const signed = (payloadBody as { signedTransaction?: { header?: { expiry?: unknown } } })?.signedTransaction;
  const rawExpiry = signed?.header?.expiry;
  if (rawExpiry === undefined || rawExpiry === null) {
    return { ok: true }; // no expiry claim to check
  }
  const expiry = Number(rawExpiry);
  if (!Number.isFinite(expiry)) {
    return { ok: false, reason: `expiry is not a number: ${String(rawExpiry)}` };
  }
  if (expiry <= nowSeconds) {
    return { ok: false, reason: `payment expired at ${expiry} (now ${Math.floor(nowSeconds)})` };
  }
  if (expiry > nowSeconds + MAX_EXPIRY_OFFSET_SECONDS) {
    return {
      ok: false,
      reason: `expiry ${expiry} is more than ${MAX_EXPIRY_OFFSET_SECONDS}s in the future (rule 7)`,
    };
  }
  return { ok: true };
}

/**
 * Same as {@link preflightPaymentPayload} but with an injected clock, so expiry
 * handling can be tested without waiting for real time to pass.
 */
export function preflightPaymentPayloadAt(
  payload: unknown,
  requirements: PaymentRequirements,
  nowSeconds: number,
): { ok: true } | { ok: false; reason: string } {
  return preflightPaymentPayload(payload, requirements, nowSeconds);
}

export interface AccessDecision {
  granted: boolean;
  receipt: PaymentReceipt | null;
  reason: string;
  /** Facilitor responses kept verbatim for auditability. */
  verify?: VerifyResponse;
  settle?: SettleResponse;
}

/**
 * Full paid-access gate: preflight → facilitator verify → facilitator settle →
 * receipt. Access is granted only when settlement reports success AND returns a
 * transaction hash. Any failure path returns granted=false.
 *
 * `settle` is a separate flag so a verify-only dry run is possible without ever
 * invoking the settlement interface.
 */
export async function authorizePayment(opts: {
  facilitator: ConsumerFacilitator;
  paymentPayload: unknown;
  requirements: PaymentRequirements;
  /** Call the settlement interface. Default false: verify only. */
  settle?: boolean;
  audit?: Record<string, unknown>;
  /** Unix seconds; injectable for deterministic expiry tests. */
  nowSeconds?: number;
}): Promise<AccessDecision> {
  const { facilitator, paymentPayload, requirements } = opts;

  const pre = opts.nowSeconds === undefined
    ? preflightPaymentPayload(paymentPayload, requirements)
    : preflightPaymentPayload(paymentPayload, requirements, opts.nowSeconds);
  if (!pre.ok) {
    return { granted: false, receipt: null, reason: `preflight: ${pre.reason}` };
  }
  const payload = paymentPayload as PaymentPayload;

  let verify: VerifyResponse;
  try {
    verify = await facilitator.verify(payload, requirements);
  } catch (e) {
    return { granted: false, receipt: null, reason: `verify threw: ${(e as Error).message}` };
  }
  if (!verify?.isValid) {
    return {
      granted: false,
      receipt: null,
      reason: `verify rejected: ${verify?.invalidReason ?? 'unknown'}${verify?.invalidMessage ? ` — ${verify.invalidMessage}` : ''}`,
      verify,
    };
  }

  if (!opts.settle) {
    // Verified but not settled: no access is granted, because the transfer has not happened.
    return {
      granted: false,
      receipt: null,
      reason: 'verified only — settlement not requested',
      verify,
    };
  }

  let settle: SettleResponse;
  try {
    settle = await facilitator.settle(payload, requirements);
  } catch (e) {
    return { granted: false, receipt: null, reason: `settle threw: ${(e as Error).message}`, verify };
  }

  if (!settle?.success) {
    return {
      granted: false,
      receipt: null,
      reason: `settle failed: ${settle?.errorReason ?? 'unknown'}${settle?.errorMessage ? ` — ${settle.errorMessage}` : ''}`,
      verify,
      settle,
    };
  }
  if (!settle.transaction) {
    // A "successful" settlement with no transaction cannot be audited; refuse access.
    return {
      granted: false,
      receipt: null,
      reason: 'settle reported success but returned no transaction hash',
      verify,
      settle,
    };
  }

  return {
    granted: true,
    receipt: buildReceipt(settle, requirements, opts.audit),
    reason: 'settled',
    verify,
    settle,
  };
}

/** Structured, auditable receipt for a settled payment. */
export function buildReceipt(
  settle: SettleResponse,
  requirements: PaymentRequirements,
  audit?: Record<string, unknown>,
): PaymentReceipt {
  return {
    success: settle.success,
    transaction: settle.transaction,
    network: settle.network,
    ...(settle.payer ? { payer: settle.payer } : {}),
    amount: requirements.amount,
    asset: requirements.asset,
    payTo: requirements.payTo,
    settledAt: new Date().toISOString(),
    ...(explorerUrl(settle.network, settle.transaction)
      ? { explorerUrl: explorerUrl(settle.network, settle.transaction)! }
      : {}),
    ...(audit ? { audit } : {}),
  };
}

/** ccdexplorer.io transaction URL for the settlement network. */
export function explorerUrl(network: string, txHash: string): string | undefined {
  const base =
    network === 'ccd:9dd9ca4d19e9393877d2c44b70f89acb'
      ? 'https://ccdexplorer.io/mainnet'
      : network === CCD_TESTNET_CAIP2
        ? 'https://ccdexplorer.io/testnet'
        : undefined;
  return base ? `${base}/transaction/${txHash}` : undefined;
}

/**
 * A facilitator whose methods throw. Used as the default so that no code path
 * can reach a real facilitator without one being injected explicitly.
 */
export const DENY_ALL_FACILITATOR: ConsumerFacilitator = {
  async verify() {
    throw new Error('no facilitator configured: refusing to verify');
  },
  async settle() {
    throw new Error('no facilitator configured: refusing to settle');
  },
  async getSupported() {
    return { kinds: [] };
  },
};
