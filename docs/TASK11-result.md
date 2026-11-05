# TASK 11 — Secret Exposure Hardening

Date: 2026-11-05 · Bounded output-hardening task. No signing, no identity redesign, no on-chain
activity, no packaging changes.

Confirmed leak: one. Suspicious patterns: six, of which two were reachable and are now hardened, three
are benign by construction, and one is a structural property worth knowing about (documented, not
changed).

---

## VERIFIED

### V1 — The probe no longer emits key material

```console
$ node scripts/probe-agent-account.mjs --no-faucet
{
  "address": "4EfgogKPXiP1PZpEE4YVZkU4KYFMyvtRKCQ8JEJLdhtaPdQuT5",
  "addressLength": 50,
  "publicKeyHex": "aa1ef2d313545c21d1e04cc4fe4aa7bc856908c04184611e3367fb69de58d790",
  "privateKeyPrinted": false,
  "privateKeyPersisted": false
}
faucet: skipped (--no-faucet)
exit 0 · stderr empty
```

Before: the same run printed `"privateKeyHex": "<64 hex>"` — the Ed25519 private scalar, in the clear,
on stdout. The probe's diagnostic purpose is intact: the derived public address, its length, the public
key, and the faucet status are all still reported.

The private half is now **never exported at all** — the `pkcs8` export, the `privRaw` slice, and the
`privateKeyHex` field are gone, so there is nothing to leak later (test 03 asserts the source contains no
`privateKey.export`, no `pkcs8`, no `privRaw`).

### V2 — No other confirmed exposure path

Scanned `src/` and `scripts/` for key, seed, mnemonic, credential, and token emission:

```console
$ grep -rnE "privateKey|seedPhrase|seed_phrase|mnemonic|passphrase|secretKey|privRaw|pkcs8" src/ scripts/
```

After the fix, every remaining hit is one of: the redaction patterns themselves
(`src/core/redact.ts:11,15,22`), the audit guard's own regex (`src/audit/trail.ts:137`), the MCP
forbidden-field list (`src/mcp/tools.ts:98-99`), a `privateKeyHandled: false` manifest flag
(`scripts/task02-register.mjs:188`), or documentation prose. No emitter remains.

```console
$ grep -rnE "console\.(log|error|warn)\(.*\b(private|secret|seed|mnemonic|privKey|privRaw)\b" src/ scripts/
(none)
```

### V3 — Redaction of untrusted error payloads

`src/core/redact.ts` is a single pure function, no framework. Demonstrated on a realistic upstream error
that attached the offending request:

```console
$ node --input-type=module -e "…redactJson(err)…"
[3/6] FAIL: {"name":"Error","message":"invokeContract failed",
  "request":{"headers":"[REDACTED]","body":{"privateKey":"[REDACTED]"}},
  "sender":"4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d",
  "transaction":"5abc7f8bbc5197037424a1ac83779a1a1f7f7568c5e82c45014e41753d7efaf0"}
```

Secret gone, public identifiers intact, classification and message preserved.

### V4 — Tests

```console
$ npx tsx test/task11-secret-hardening.test.mts
  ok   01. the probe never prints a private key field or value
  ok   02. the probe still emits the diagnostics it exists for
  ok   03. the probe never exports the private half at all
  ok   04. redaction strips secret-named fields at any depth
  ok   05. redaction strips secret-shaped values even under a neutral field name
  ok   06. redaction preserves every public identifier
  ok   07. nested secret-bearing error objects cannot bypass redaction
  ok   08. arrays and deep nesting are handled without leaking
  ok   09. redaction never throws on hostile input
  ok   10. redaction output is bounded
  ok   11. audit assertNoSecrets still rejects secret-bearing events
  ok   12. the audit trail still contains no secrets after a normal run
  ok   13. no confirmed private-key output path remains in the source tree
  ok   14. no module prints a whole environment object

task11-secret-hardening: 14/14 passed
```

```console
$ npm run build       → exit 0
$ npm test            → exit 0   16 suites, 331 tests, all passed
$ npm run typecheck   → exit 0
```

Probe run live: `node scripts/probe-agent-account.mjs --no-faucet` → exit 0, sanitized output above.

CLI/MCP regression (unchanged behaviour):

| Command | Exit |
|---|---|
| `node dist/cli/verify.js --token-id 1004` | **0** (`TRUSTED`) |
| `node dist/cli/commerce.js --token-id 1004 --out /tmp/t11c` | **0** (`access_granted`) |
| `node dist/cli/index.js` (no `--owner`) | **1** (usage) |
| `node scripts/task08-demo.mjs --out /tmp/t11ev` | **0** (9 steps) |
| MCP `initialize` + `tools/list` + `trust.verify` | **0**, 3 stdout lines, 6 tools, stderr 0 bytes |

---

## FINDINGS

### CONFIRMED LEAK

**F13 — `scripts/probe-agent-account.mjs:45` printed an Ed25519 private scalar.**

```js
  privateKeyHex: privRaw.toString('hex'),
```

Emitted on **stdout**, unconditionally, by a script that the TASK 01 investigation left in the tree. The
key is generated at `:27`, never persisted, and never funded, so nothing was at risk in practice — but it
is a live example of the pattern, it sits in a repository whose security claim is "no key material
anywhere", and the same shape would be catastrophic if copied into a funded path.

Fixed: field removed; the private half is never exported (`:29` no longer requests PKCS#8, `:32` no longer
slices a private buffer). Public address, address length, public key, and faucet status are preserved.
`--no-faucet` added so the probe can be exercised without touching the network.

### REACHABLE, NOW HARDENED

**F18 — `src/cli/index.ts:79` dumped an arbitrary object on a failure path.**

```ts
console.error('[3/6] FAIL:', JSON.stringify(result));
```

`result` is the raw `invokeContract` response. On an unexpected tag it was serialized wholesale — no
redaction, no bound. Reachable in the registration flow, which is exactly the flow that handles
transaction material. Now: `redactJson(result, 600)`.

**F19 — `src/cli/index.ts:112` dumped an arbitrary registry record.**

```ts
console.error('[6/6] On-chain record:', JSON.stringify(record, null, 1).slice(0, 400));
```

`record` comes from the registry MCP — a third party. Truncation is not redaction: a secret in the first
400 characters passes through unchanged. Now: `redactJson(record, 400)`.

Both are *latent* rather than demonstrated: neither path emitted a secret in any run recorded in
`docs/evidence/`. They are fixed because the risk is structural (untrusted object → stdout), not because a
leak was observed.

### SUSPICIOUS PATTERNS — examined, not leaks

**S1 — `src/cli/index.ts:133-137` prints a `transactionJson`.**

This is the **unsigned** `Transaction.JSON` handed to the browser wallet, containing the contract update,
the sender, and the expiry. It carries no signature and no key; the wallet signs it out of process. This
is the intended interface, not an exposure. **Public by design.**

**S2 — `scripts/task02c-repin-v2.mjs:69` embeds an MCP response in a thrown error.**

```js
throw new Error('build_agent_badge returned no card: ' + JSON.stringify(badged).slice(0, 400));
```

The payload is a badge/agent-card build result — public metadata. Not hardened: the cost of a misleading
"secret" abstraction outweighs the theoretical gain, and the value is already published on chain.
**Benign by construction.**

**S3 — `src/payments/x402Sdk.ts:63` echoes up to 200 chars of a facilitator response body.**

```ts
if (!res.ok) throw new Error(`facilitator ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
```

A malicious facilitator could echo a request payload back. Our own payloads contain only the public
payment requirement (no key, no signature of ours), and this module is not on any path a secret travels.
**Benign today; noted as a trust boundary.**

**S4 — `test/helpers.mjs:64` echoes `e.message` into the failure line.**

Test diagnostics print an error message verbatim. Every message in this codebase is constructed from
public values (addresses, token ids, counts, contract coordinates). No test constructs an error from key
material. **Benign.**

**S5 — `scripts/task02-register.mjs:95` writes `register-payload.json` to disk.**

The parameter hex for `CIS-8004.register` — a public contract call. Not a credential, not signed.
**Public by design.**

**S6 — nothing dumps `process.env`.**

`src/mcp/server.ts:30-31` reads two named variables and passes them into config; it never prints them.
Test 14 asserts no `console.*` call in `src/` or `scripts/` interpolates `process.env` directly. The only
full-environment spread is `scripts/task08-demo.mjs:54`, passed to `spawn` as the child's environment —
never printed, and the child receives the same process env it would inherit anyway.

### STRUCTURAL NOTE (documented, not changed)

**S7 — `AuditTrail.record()` accepts a fixed field set, so an unknown top-level key never reaches
`assertNoSecrets`.**

`src/audit/trail.ts` builds `body` from `{ outcome, reason, agent, payment, evidence_ref }` only. A caller
passing `{ …, privateKey: 'x' }` has that key dropped *before* validation — the record is written without
it, so nothing leaks, but the caller gets no error and may believe the field was recorded. The reachable
paths (`agent`, `payment`) **are** validated, and that is what test 11 exercises. Left as-is: adding
rejection for unknown keys would change the audit API, which is out of scope for this task.

---

## Changes

| File | Change |
|---|---|
| `scripts/probe-agent-account.mjs` | private key never exported or printed; `--no-faucet` flag; self-reports `privateKeyPrinted: false` |
| `src/core/redact.ts` | **new** — `redact()`, `redactJson()`, `REDACTED`; secret-named fields, key-shaped values, mnemonics, credential-shaped strings; `Error` handled via its own properties; bounded output |
| `src/cli/index.ts` | `:79` and `:112` route through `redactJson` instead of raw `JSON.stringify` |
| `test/task11-secret-hardening.test.mts` | **new** — 14 tests |
| `docs/TASK11-result.md` | **new** — this report |

Nothing else was touched: no MCP tool, no security boundary, no x402 path, no audit semantics, no
packaging, no documentation finding.

Redaction policy, stated precisely (it matters, because over-redaction is its own failure):

- **Redacted:** fields matching `private|secret|seed|mnemonic|passphrase|password|credential|bearer|apikey|signerkey|auth_token|tokens|authorization|authentication|headers`; any string that is 64+ hex chars, a 12+-word mnemonic, or a `Bearer …` / `ghp_…` / `sk-…`-shaped token.
- **Preserved:** `address`, `sender`, `payTo`, `owner`, `feePayer`, `agentWallet`, `transaction`, `hash`, `metadata_hash_hex`, `sha256`, `head_hash`, `prev_hash`, `checkpoint`, `agent_uri`, `token_address`, `network`, `session_id`, `token_id` — checked *before* the secret patterns, so a public identifier can never be masked by accident.
- A 64-char hex value is ambiguous on its own, so the **field name** decides; `transaction` and
  `metadata_sha256` are public, `privateKey` is not.

---

## NOT TESTED

- **The probe with the faucet enabled.** Running it would PUT to
  `wallet-proxy.testnet.concordium.com` and fund a throwaway address — network write, and outside this
  task. The `--no-faucet` path covers everything except that final `fetch`.
- **Redaction under a real leak.** No test can prove a secret that was never produced is absent; the tests
  prove the *mechanism* with synthetic values and prove the *source* has no remaining emitter.
- **Downstream consumers of `redactJson`'s output shape.** The two CLI lines are human diagnostics; no
  program parses them.
- **Windows paths / non-UTF8 streams.** Out of scope.

## BLOCKED

Nothing. No signing, no transactions, no on-chain state touched (`nonce 4`, `pending 4`,
`19943.619923 CCD`, unchanged).

---

## FINAL VERDICT

**PASS — no confirmed private-key or credential exposure remains in the inspected output paths.**

One real leak (F13) is closed at its root: the key is no longer exported, not merely unprinted. Two
latent untrusted-object dumps (F18, F19) now route through a single allowlist-aware redactor. The audit
trail's `assertNoSecrets` is untouched and still refuses key-shaped values and secret-named fields
(tests 11, 12). Public diagnostics remain fully usable — addresses, transaction hashes, metadata hashes,
token ids, contract coordinates and the probe's own output all survive redaction intact (test 06 asserts
this field by field, so over-redaction would fail the suite).

Six further patterns were examined and are benign by construction or public by design (S1–S6); one
structural property of `AuditTrail.record()` is documented rather than changed (S7), because changing it
would alter the audit API.
