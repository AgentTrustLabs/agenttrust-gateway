# TASK 14 — Audit Trail API Strictness

Date: 2026-11-05 · Bounded API hardening for finding S7. No audit-format redesign, no canonicalization
change, no external anchoring, no MCP/payment change, no historical evidence migrated.

---

## VERIFIED

### V1 — The defect was real and is now closed

`AuditTrail.record()` built its event by spreading a fixed field set:

```ts
const body = { seq, event_id, timestamp, session_id, type, outcome: fields.outcome,
  ...(fields.reason !== undefined ? { reason: fields.reason } : {}), … };
assertNoSecrets(body);          // ← body, not `fields`
```

An unknown top-level key never reached `assertNoSecrets()` because it was never copied into `body`. Two
consequences, both demonstrated before the fix and asserted after it:

1. **Caller false confidence.** `record(t, { outcome, note: 'x' })` returned a persisted event and a
   success value, with no signal that `note` was discarded.
2. **Secret-guard bypass by shape.** `record(t, { outcome, privateKey: 'x' })` wrote a clean event; the
   secret was dropped, not rejected. Nothing leaked, but the guard's contract ("secret-bearing input is
   refused") was violated for that input shape.

After the fix, both throw:

```console
$ node --input-type=module …   # test 01, reproduced
audit refused: record() fields.privateKey is a secret-bearing field
  (not an accepted field: outcome, reason, agent, payment, evidence_ref)
```

### V2 — Fail-closed contract, before any hashing or writing

`record()` now calls `assertEventType(type)` then `validateRecordFields(fields)` **as its first two
statements**, before the event body is built, before `assertNoSecrets`, before the lock is taken.

| Input | Behaviour |
|---|---|
| Unknown top-level field | `AuditEventValidationError` `INVALID_FIELDS` — names every offender and lists the accepted set |
| Unknown nested field in `agent` / `payment` | `INVALID_AGENT_FIELDS` / `INVALID_PAYMENT_FIELDS` — same message shape |
| Secret-named field anywhere in the rejected position | reported as `audit refused: … is a secret-bearing field`, so it cannot be mistaken for a typo |
| Missing `outcome` | `INVALID_FIELD_TYPE` — "required (one of …)" |
| Invalid `outcome` value | `INVALID_OUTCOME` |
| Wrong primitive type (`reason: 42`, `token_id: '1004'`, `payment: 'x'`, `agent: []`) | `INVALID_FIELD_TYPE` |
| Unknown event type (`'agent.discoverd'`, `''`, `123`) | `INVALID_TYPE` |
| `fields` not a plain object (`null`, array) | `INVALID_RECORD` |
| `undefined` optional values | accepted, treated as **absent** — unchanged from before |
| Secret-shaped *value* (bare 64-hex outside a public hash field) | still refused by `assertNoSecrets`, unchanged |

Accepted field sets are now enumerated constants and asserted by test 05:

```
record() fields : outcome, reason, agent, payment, evidence_ref
agent fields    : token_id, token_address, owner_account, agent_uri, metadata_sha256
payment fields  : requirement_id, amount, asset, network, pay_to, payer, transaction
```

### V3 — Rejection leaves no trace

Test 02 and 03 prove the append path is untouched by a rejected call:

```console
reject event N → next accepted event has seq 2 (not 3)   # no sequence burn
log bytes       → identical before/after                  # no partial write
checkpoint bytes→ identical before/after                  # no checkpoint update
```

This matters because a discarded-but-sequenced event would create a permanent gap that
`AuditTrail.verify()` would flag as tampering for the rest of the file's life.

### V4 — Integrity guarantees unchanged

| Property | Evidence |
|---|---|
| Canonicalization frozen | test 12 pins `canonicalize({b:1,a:2}) === '{"a":2,"b":1}'`, array ordering, `undefined` omission, `null` |
| Digest contract frozen | test 12 recomputes `eventHash` independently and asserts the `hash` field is excluded from its own digest |
| Existing evidence verifies | test 13 re-verifies the three TASK 05 trails on disk with `requireCheckpoint: true` |
| Tamper detection intact | `task06-tamper-demo` → **11 cases, 0 unexpected** (07/08 still REJECT on truncation, 12 still ACCEPT as the documented undetectable case) |
| Concurrent append intact | test 15: two OS processes × 5 events → 10 events, one chain, checkpoint matches, no lock leaked |
| Lock behaviour intact | `task06.1-lock-hardening` 14/14, including fail-closed timeout and stale-lock reclaim |
| `assertNoSecrets` not weakened | test 16 asserts bare-hex refusal, nested secret refusal, and that public `metadata_sha256` / `transaction` still pass |

### V5 — Backward compatibility, precisely

`AuditTrail.verify()` does **not** run shape validation — it reads, re-hashes, and compares. Test 14
confirms a legacy line whose `reason` is a number still verifies and is read back as stored. So:

- **Existing files:** unaffected. Historical trails written before this task still verify (test 13).
- **Existing callers:** all 16 `record()` call sites in `src/commerce/orchestrator.ts` pass only documented
  fields (verified by running the commerce CLI and MCP flow — see V6).
- **Existing tests:** two fixtures passed `reason: i` where `i` is a number. That was *relying on the
  leniency being fixed* — a number in a string field. Both were changed to `String(i)` with no change to
  what the test asserts (still 8 and 10 distinct events; the string values are still unique). This is a
  fixture correction, not a weakened expectation.

### V6 — Downstream behaviour unchanged

```console
$ node dist/cli/commerce.js --token-id 1004 --out /tmp/t14c   → exit 0, access_granted, 8 audit events
$ node scripts/task08-demo.mjs --out /tmp/t14ev               → exit 0, all 9 steps, audit 3/3 verified
$ node dist/cli/verify.js --token-id 1004                     → exit 0, TRUSTED
```

The MCP `commerce.simulate` and `audit.verify` tools produce identical results (demo step 9 re-verifies
three trails).

---

## API behaviour before and after

| Case | Before | After |
|---|---|---|
| `{ outcome:'PASS', note:'x' }` | **accepted**, `note` silently dropped | **rejected** `INVALID_FIELDS` |
| `{ outcome:'PASS', privateKey:'x' }` | **accepted**, secret dropped before the guard | **rejected** as secret-bearing |
| `{ outcome:'PASS', agent:{ token_id:1004, extra:1 } }` | accepted, `extra` dropped | **rejected** `INVALID_AGENT_FIELDS` |
| `{ }` (no outcome) | accepted, `outcome: undefined` written, then failed the hash/verify path later | **rejected** at the call |
| `{ outcome:'OK' }` | accepted (not a valid outcome) | **rejected** `INVALID_OUTCOME` |
| `record('agent.discoverd', …)` | accepted (unknown type) | **rejected** `INVALID_TYPE` |
| `{ outcome:'PASS', reason: 42 }` | accepted, number written into a string field | **rejected** `INVALID_FIELD_TYPE` |
| `{ outcome:'PASS', reason: undefined }` | accepted, field omitted | **unchanged** — accepted, omitted |
| `{ outcome:'PASS', agent: {} }` | accepted, `agent:{}` written | **unchanged** |
| Secret 64-hex in `payment.payer` | rejected by `assertNoSecrets` | **unchanged** |

## Compatibility impact

- **On-disk format:** byte-identical for any event that was valid before. `canonicalize`/`eventHash`
  untouched, so every existing trail still verifies (test 13, tamper demo).
- **Read path:** unchanged and deliberately *not* strict — legacy shapes readable (test 14).
- **Write path:** stricter. Any hypothetical external caller sending undocumented fields now gets a loud
  error instead of silent loss. In this repository there were none.
- **Sequence/checkpoint:** a rejected call consumes neither, so no gaps are introduced.
- **Secret guard:** unchanged in behaviour for accepted input; now additionally unreachable-by-bypass
  because validation runs first and reports secret-named keys explicitly.

---

## FILES CHANGED

**New**
- `src/audit/validate.ts` — `validateRecordFields`, `assertEventType`, `AuditEventValidationError`,
  `RECORD_FIELDS` / `AGENT_FIELDS` / `PAYMENT_FIELDS`
- `test/task14-audit-strictness.test.mts` — 18 tests
- `docs/TASK14-result.md` — this report

**Modified**
- `src/audit/trail.ts` — two calls added at the top of `record()`; re-export of the validator. No change to
  canonicalization, hashing, checkpointing, locking, `verify()`, or `assertNoSecrets`.
- `test/task06-audit-integrity.test.mts` — `reason: i` → `reason: String(i)` (fixture only)
- `test/task06.1-lock-hardening.test.mts` — same, one line
- `test/task11-secret-hardening.test.mts` — comment updated to reflect that validation now rejects earlier

No historical evidence, MCP tool, payment code, or audit format was touched.

---

## TEST RESULTS

```console
$ npx tsx test/task14-audit-strictness.test.mts
  ok   01. an unknown top-level field is rejected instead of silently dropped
  ok   02. a rejected event burns no sequence number and no hash
  ok   03. an event rejected mid-session leaves the file byte-identical
  ok   04. unknown nested fields are rejected in agent and payment
  ok   05. the accepted field sets match the documented schema exactly
  ok   06. a missing or invalid outcome is rejected
  ok   07. invalid field types are rejected
  ok   08. an unknown event type is rejected
  ok   09. every valid event shape from the orchestrator is accepted
  ok   10. absent optional values behave exactly as before (undefined is "absent")
  ok   11. an empty agent/payment object is accepted and serialised as {}
  ok   12. canonicalization and hashing are untouched
  ok   13. existing on-disk evidence still verifies byte-for-byte
  ok   14. a legacy record with a non-string reason still verifies
  ok   15. concurrent writers keep one chain with strict validation on
  ok   16. assertNoSecrets is unchanged and still applied to accepted events
  ok   17. validation is exposed for direct use and matches record()
  ok   18. an in-memory trail enforces the same contract

task14-audit-strictness: 18/18 passed
```

```console
$ npm test                     → exit 0   18 suites, 360 tests, all passed
$ npm run typecheck            → exit 0
$ npx tsx scripts/task06-tamper-demo.mts docs/evidence/task05
                               → exit 0   11 tamper cases, 0 unexpected
```

Suite totals before this task: 17 suites / 342 tests. Delta: `task14-audit-strictness` (18). No existing
suite's count changed.

---

## NOT TESTED

- **A caller outside this repository.** There is no published package (`"private": true`), so the only
  consumers are in-tree. The stricter contract is therefore a local guarantee, not a compatibility audit
  against third parties.
- **Validation of `type` at the type level.** `assertEventType` narrows at runtime; the TypeScript signature
  still accepts `AuditEventType`, so a JS caller or a `as never` cast is the only way to reach the error.
  That is what the tests exercise.
- **Behaviour under a hostile `fields` object** (getters that throw, `Proxy`, `Object.create(null)` with
  inherited keys). `Object.keys` is own-enumerable only, so inherited keys are ignored — benign, but not
  separately asserted.
- **Fuzz/property testing** of the validator. Fixed cases only.

## BLOCKED

Nothing. No on-chain activity: `nonce 4`, `pending 4`, `19943.619923 CCD` — unchanged. No key, no signing,
no transaction.

---

## FINAL VERDICT

**PASS — S7 closed, integrity preserved.**

The behaviour was a genuine defect with two distinct harms: a caller could believe a field was recorded
when it was discarded, and a secret-shaped field could bypass `assertNoSecrets()` purely by sitting at an
unexpected position in the object. Both are now hard errors raised before anything is hashed, appended, or
checkpointed — so a rejected call cannot burn a sequence number or leave a partial line that later looks
like tampering.

The fix is additive and local: one new module, two calls at the top of `record()`. Canonical serialization,
the hash chain, checkpoint semantics, locking, and the read path are untouched — proven by the frozen
digest expectations (test 12), by re-verifying pre-existing on-disk evidence (test 13), by the 11-case
tamper matrix still producing 0 unexpected verdicts, and by the two-process concurrency test still
yielding one continuous chain. `assertNoSecrets` is not weakened; it is now reached for every accepted
event and its rejection vocabulary is preserved for secret-named keys that fail validation first.

Two test fixtures in TASK 06/06.1 relied on the leniency being removed (a number in a string field) and
were corrected to `String(i)` with no change to their assertions — the only place existing tests were
edited, and not to make anything pass that should have failed.
