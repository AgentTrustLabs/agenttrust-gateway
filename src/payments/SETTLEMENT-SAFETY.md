# Settlement safety gate — x402 (Concordium Testnet)

TASK 04 implements the settlement **adapter**, not a settlement. This file states exactly what has to be
true before the adapter may be pointed at a real facilitator.

## What the code guarantees today

| Property | Mechanism |
|---|---|
| No settlement by default | `authorizePayment({ ..., settle })` — `settle` defaults to `false` |
| No facilitator by default | `DENY_ALL_FACILITATOR` throws on `verify` and `settle` |
| No implicit endpoint | `createHttpFacilitator({ url })` throws when `url` is empty; no env fallback |
| No key handling | the module accepts no signer, seed, private key or mnemonic |
| No wallet creation | none in the module |
| No credential issuance | none in the module |
| No access without a transaction | settlement must report success **and** return a tx hash |
| Verification is not payment | verify-only returns `granted: false` |

## Preconditions for a live settlement (all required)

```
1.  Explicit operator authorization for THIS settlement:
      recipient   = <base58 Concordium account>   must equal requirements.payTo
      amount      = <microCCD integer>            must equal requirements.amount
      asset       = CCD
      network     = ccd:4221332d34e1694168c2a0c0b3fd0f27  (testnet only)
      maxTimeoutSeconds <= 600
2.  A facilitator URL supplied explicitly, and its /supported response checked to advertise
    exact + ccd:4221332d34e1694168c2a0c0b3fd0f27 with a sponsor address in extra.feePayer.
3.  The sponsor account must be funded with testnet CCD — the sponsor pays the transaction fee.
4.  The client payload must come from `ExactConcordiumScheme.createPaymentPayload(2, requirements)`
    inside a process the operator controls; the signing key must never enter this repository or its logs.
5.  A verify-only dry run must pass before settlement is enabled.
6.  The resulting transaction hash must be confirmed on ccdexplorer testnet before any receipt is treated
    as final.
```

## What remains unproven

- No real facilitator has been contacted; `/supported`, `/verify` and `/settle` are unexercised against a
  live service.
- No real payment payload exists (a valid one needs a signer; TASK 04 forbids touching one).
- `src/payments/x402Sdk.ts#createHttpFacilitator` is written but never constructed anywhere in the project.

## Deliberate omissions

- No retry logic on settle. A settlement failure is surfaced, never retried automatically — retrying a
  payment that may have partially landed is a double-spend risk.
- No cached receipts. A receipt exists only for a settlement that returned a transaction hash.
- No fallback asset. `asset` is always explicit; the SDK's money-parser path (which resolves to USDR) is
  never used.
