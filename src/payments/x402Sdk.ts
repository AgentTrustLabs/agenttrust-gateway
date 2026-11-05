/**
 * x402 protocol adaptation against the OFFICIAL SDK.
 *
 * `src/payments/x402.ts` is hand-rolled and dependency-free so it can be read and
 * unit-tested without the SDK. This file is the bridge: it proves our shapes are
 * accepted by @x402/concordium / @x402/core and exposes adapters for them.
 *
 * Nothing here signs, holds keys, or touches the network. The facilitator is
 * injected; a real one is never constructed here.
 */

import { ExactConcordiumScheme as ConcordiumServerScheme } from '@x402/concordium/exact/server';
import {
  CONCORDIUM_TESTNET_CAIP2,
  CCD_ASSET_IDENTIFIER,
  CCD_DECIMALS,
  getConcordiumGrpcUrl,
  getExplorerTxUrl,
} from '@x402/concordium';
import { x402ResourceServer } from '@x402/core/server';
import type { ConsumerFacilitator } from './x402.js';
import type { PaymentRequirements } from '@x402/core/types';

/** Official testnet CAIP-2 as exported by the SDK (single source of truth). */
export const SDK_TESTNET_CAIP2: string = CONCORDIUM_TESTNET_CAIP2;

/** The SDK's own constants, surfaced so tests can assert we agree with it. */
export const SDK_CONSTANTS = {
  ccdAsset: CCD_ASSET_IDENTIFIER,
  ccdDecimals: CCD_DECIMALS,
  grpcUrl: getConcordiumGrpcUrl(CONCORDIUM_TESTNET_CAIP2),
} as const;

/**
 * A `FacilitatorPort` backed by a live x402 facilitator HTTP endpoint.
 *
 * Constructed only when a caller passes an explicit URL — there is no default,
 * and no code path in this project constructs one during TASK 04.
 */
export interface HttpFacilitatorOptions {
  url: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export function createHttpFacilitator(opts: HttpFacilitatorOptions): ConsumerFacilitator {
  if (!opts.url) throw new Error('facilitator url is required');
  const base = opts.url.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`facilitator ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async verify(paymentPayload, requirements) {
      return post('/verify', {
        x402Version: 2,
        paymentPayload,
        paymentRequirements: requirements,
      });
    },
    async settle(paymentPayload, requirements) {
      return post('/settle', {
        x402Version: 2,
        paymentPayload,
        paymentRequirements: requirements,
      });
    },
    async getSupported() {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}/supported`, { headers, signal: ac.signal });
        if (!res.ok) throw new Error(`facilitator /supported HTTP ${res.status}`);
        return (await res.json()) as Awaited<ReturnType<ConsumerFacilitator['getSupported']>>;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Assert that the official Concordium server scheme parses our requirement shape
 * identically. This is the compatibility check: if the SDK changes its price or
 * asset handling, this throws instead of silently diverging.
 */
export async function assertSdkAcceptsRequirements(
  requirements: PaymentRequirements,
): Promise<{ sdkAsset: string; sdkAmount: string }> {
  const scheme = new ConcordiumServerScheme();
  const parsed = await scheme.parsePrice(
    { amount: requirements.amount, asset: requirements.asset },
    requirements.network,
  );
  if (parsed.asset !== requirements.asset) {
    throw new Error(`SDK parsed asset ${parsed.asset} but requirement says ${requirements.asset}`);
  }
  if (String(parsed.amount) !== String(requirements.amount)) {
    throw new Error(`SDK parsed amount ${parsed.amount} but requirement says ${requirements.amount}`);
  }
  return { sdkAsset: parsed.asset, sdkAmount: String(parsed.amount) };
}

/**
 * Build a resource server wired with the official Concordium scheme, using an
 * injected facilitator. Never initialized against the network here.
 */
export function buildResourceServer(facilitator: ConsumerFacilitator): {
  server: x402ResourceServer;
  registered: boolean;
} {
  const server = new x402ResourceServer(facilitator as never).register(
    CONCORDIUM_TESTNET_CAIP2 as never,
    new ConcordiumServerScheme(),
  );
  // NB: SDK signature is hasRegisteredScheme(network, scheme) — network first.
  return {
    server,
    registered: server.hasRegisteredScheme(
      CONCORDIUM_TESTNET_CAIP2 as never,
      'exact' as never,
    ),
  };
}

/** Explorer URL for a settlement, via the SDK's own helper. */
export function sdkExplorerTxUrl(network: string, txHash: string): string | undefined {
  return getExplorerTxUrl(network as never, txHash);
}

/** SDK constants vs our module's constants: fail if they ever diverge. */
export function assertConstantsAgree(local: { asset: string; decimals: number; network: string }): void {
  if (local.asset !== CCD_ASSET_IDENTIFIER) {
    throw new Error(`asset constant drift: local=${local.asset} sdk=${CCD_ASSET_IDENTIFIER}`);
  }
  if (local.decimals !== CCD_DECIMALS) {
    throw new Error(`decimals constant drift: local=${local.decimals} sdk=${CCD_DECIMALS}`);
  }
  if (local.network !== CONCORDIUM_TESTNET_CAIP2) {
    throw new Error(`network constant drift: local=${local.network} sdk=${CONCORDIUM_TESTNET_CAIP2}`);
  }
}
