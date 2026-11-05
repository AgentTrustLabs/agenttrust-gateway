# TASK 02.1 — Integration Lessons & Regression Protection · Result

Date: 2026-11-05 · No blockchain transactions performed in this task.

---

## VERIFIED

All four findings documented in `docs/CONCORDIUM-INTEGRATION-LESSONS.md`, each tagged with an
evidence label (`VERIFIED — live` / `VERIFIED — source` / `UNDOCUMENTED` / `DOCUMENTED`).

1. **Undocumented faucet** — `PUT wallet-proxy/v0/testnetGTUDrop/{addr}`. Live: `submissionId
   eb21350f…`, balance 0 → 20 000 CCD. Source: `concordium-browser-wallet` `getCcdDrop()`. Explicitly
   labelled NOT a supported API, with a documented fallback (wallet UI) and a scope limit
   (testnet bootstrap only).
2. **Account creation needs an IP credential** — negative result recorded: a structurally valid
   keypair-derived address (`4SjjGXAx…`, 50 chars, valid checksum) is rejected by the chain with
   `Account creation is not finalized`. Address encoding proven (version byte 1 ‖ 32-byte key ‖
   double-SHA-256[:4]). Testnet identity needs no KYC (official docs quoted); no public issuance API.
3. **Post-registration token identity** — root cause corrected and made precise: `build_agent_card`
   *does* populate `tokenAddress` + `registrations` when `token_id` is forwarded; our typed wrapper was
   dropping it. `build_agent_badge` is the tool for an existing card. Both converge on byte-identical
   output. Wrapper fixed; forwarding is now a regression test.
4. **Wallet serialization** — numeric type `2`, `{value}` wrappers (or raw bigint for energy / plain
   string for receiveName), `{type:'module'}` schema, params passed separately. Each shape pinned to the
   wallet source line and to the exact live error it prevents.

Byte-level guarantees (parameter hex ≡ MCP bytes; card hash ≡ on-chain anchor) are asserted offline.

## NOT TESTED

- Faucet `v1` or parameterised variants; faucet on mainnet (must not exist by design).
- `build_agent_card` tokenAddress behaviour across future MCP releases — pinned only by fixture drift.
- `schema.type: 'parameter'` inside a real browser wallet (tested offline only).
- `updateOperator`, `setAgentWallet` proof-of-control, multi-credential accounts.
- Any non-testnet network behaviour.

## BLOCKED

Nothing blocked. One constraint is structural rather than a blocker: identity issuance cannot be
automated (by design — it is the user's credential), so any future end-to-end test needs a
human-created account as a precondition.

## FILES CHANGED

**New — documentation**
- `docs/CONCORDIUM-INTEGRATION-LESSONS.md`
- `docs/TASK02.1-result.md` (this file)

**New — regression suite (offline, no network, no chain)**
- `test/run.mjs` · runner
- `test/helpers.mjs` · shared assertions + TASK 02 constants
- `test/finding-1-faucet.test.mjs` · 6 tests
- `test/finding-2-account-derivation.test.mjs` · 7 tests
- `test/finding-3-agent-card.test.mjs` · 11 tests
- `test/finding-4-wallet-serialization.test.mjs` · 10 tests
- `test/regression-bytes.test.mjs` · 9 tests
- `test/fixtures/cis8004-module-schema.bin` (11 208 B, `sha256 9f8b59ab…`)
- `test/fixtures/mcp-build-agent-card-token1004.json` (+ `.raw.json`)
- `test/fixtures/mcp-build-agent-badge-token1004.json` (+ `.raw.json`)

**Modified — source (bug fixes only, no behaviour change to the working flow)**
- `src/registry/mcpClient.ts` — `buildAgentCard()` now forwards `tokenId`/`agentWallet`; added
  `callToolRaw()`; `verifyAgentCard()` snake_case params (found in TASK 02).
- `src/registry/txBuilder.ts` — `getTransactionStatus()` → `getBlockItemStatus()` (removed in web-sdk 12).
- `src/cli/index.ts` — `ReturnValue.buffer` handling; CLI arg parser typing.
- `package.json` — added `"test": "node test/run.mjs"`.

**Modified — documentation**
- `docs/TASK02-result.md` — cost corrected from CCD/microCCD mix-up to 56.380077 CCD with exact
  balance reconciliation and nonce accounting.

`tsc --noEmit` is clean; it was not before (4 pre-existing type errors in `cli/index.ts` and
`txBuilder.ts`).

## TEST RESULTS

```
$ npm test          # node test/run.mjs

PASS  finding-1-faucet.test.mjs                 6/6 passed
PASS  finding-2-account-derivation.test.mjs     7/7 passed
PASS  finding-3-agent-card.test.mjs            11/11 passed
PASS  finding-4-wallet-serialization.test.mjs  10/10 passed
PASS  regression-bytes.test.mjs                 9/9 passed
──────────────────────────────────────────────────────────
all suites passed                                43/43

$ npx tsc --noEmit
(clean)

$ npx tsx scripts/task02-verify.mjs 1004 5abc7f8b…
local===chain : true
RESULT: VERIFIED
```

TASK 02 verification still passes against the live chain — registration, owner, token id, URI, hash
all unchanged. No new transactions were created (`nonce 4`, balance `19943.619923` CCD, matching the
three recorded fees to the microCCD).

## Acceptance criteria

| Criterion | Status |
|---|---|
| All four findings documented | ✅ |
| Applicable regressions covered by automated tests | ✅ 43 tests |
| Existing TASK 02 tests remain passing | ✅ `task02-verify.mjs` → VERIFIED |
| Documentation identifies limitations and evidence | ✅ evidence labels + §8 open questions |
| No credentials / keys / seeds exposed | ✅ asserted by two test suites |
| No new blockchain transactions | ✅ nonce + balance unchanged |
