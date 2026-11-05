/**
 * Deterministic, offline payment simulation.
 *
 * Extracted from `src/cli/commerce.ts` so the CLI and the MCP server share one
 * implementation — the MCP layer must not carry its own copy of business logic.
 *
 * Nothing here signs, submits, or touches a chain. The "transaction" is derived
 * locally from payTo:amount:asset and is labelled `simulated:` in its preimage so
 * it can never be mistaken for a chain hash.
 */

import {
  CCD_TESTNET_CAIP2,
  X402_VERSION,
  type ConsumerFacilitator,
} from '../payments/x402.js';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

export type FacilitatorMode = 'ok' | 'reject' | 'settle-fail' | 'settle-nohash';

/**
 * MOCK facilitator. Deterministic and offline.
 *
 * The "transaction" is derived locally from payTo:amount:asset — it is NOT a
 * chain hash and is never submitted. Labelled as simulated throughout.
 */
export function mockFacilitator(mode: FacilitatorMode): ConsumerFacilitator & { calls: string[] } {
  const calls: string[] = [];
  const fakeTx = (r: PaymentRequirements) => {
    let h = 0n;
    for (const ch of `simulated:${r.payTo}:${r.amount}:${r.asset}`) {
      h = (h * 131n + BigInt(ch.codePointAt(0)!)) % (1n << 256n);
    }
    return h.toString(16).padStart(64, '0');
  };
  return {
    calls,
    async verify(payload: PaymentPayload) {
      calls.push('verify');
      if (mode === 'reject') {
        return { isValid: false, invalidReason: 'sender_signature_invalid', invalidMessage: 'mock rejection' };
      }
      const signed = (payload.payload as any)?.signedTransaction;
      if (!signed || signed.version !== 1) {
        return { isValid: false, invalidReason: 'invalid_transaction_format' };
      }
      return { isValid: true, payer: signed?.header?.sender };
    },
    async settle(_p: PaymentPayload, r: PaymentRequirements) {
      calls.push('settle');
      if (mode === 'settle-fail') {
        return { success: false, transaction: '', network: r.network, errorReason: 'insufficient_funds' };
      }
      if (mode === 'settle-nohash') {
        return { success: true, transaction: '', network: r.network };
      }
      return { success: true, transaction: fakeTx(r), network: r.network, payer: r.payTo };
    },
    async getSupported() {
      return { kinds: [{ x402Version: X402_VERSION, scheme: 'exact', network: CCD_TESTNET_CAIP2 }] };
    },
  };
}

/** Structural client payload. Contains a placeholder signature — never a real one. */
export function structuralPayload(requirements: PaymentRequirements): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    accepted: requirements,
    payload: {
      signedTransaction: {
        version: 1,
        header: {
          sender: requirements.payTo,
          nonce: 1,
          expiry: Math.floor(Date.now() / 1000) + 300,
          executionEnergyAmount: 300,
          numSignatures: 1,
          sponsor: { account: requirements.payTo, numSignatures: 1 },
        },
        payload: { type: 'transfer', toAddress: requirements.payTo, amount: requirements.amount },
        signatures: { sender: { '0': { '0': '00' } }, sponsor: {} },
      },
    },
  } as PaymentPayload;
}

/** The fixed disclaimer every simulated result carries. */
export const SIMULATION_DISCLAIMER =
  'SIMULATED settlement: no transaction was signed, submitted, or recorded on chain.';
