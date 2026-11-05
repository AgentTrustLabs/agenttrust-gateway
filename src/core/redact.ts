/**
 * Redaction for diagnostic output.
 *
 * One function, no framework: diagnostics that must serialize a whole object go
 * through here so a secret can't ride along by accident. It is deliberately
 * conservative — it removes key-named fields and key-shaped values, and leaves
 * every public identifier intact (account addresses, transaction hashes,
 * metadata hashes, token ids, contract coordinates).
 *
 * The distinction that matters:
 *   SECRET   — private key, seed phrase, mnemonic, credential, bearer token
 *   PUBLIC   — base58 account address, hex tx hash, metadata SHA-256
 *
 * A 64-char hex value is ambiguous on its own, so it is treated by *field name*:
 * `transaction`, `metadata_sha256`, `hash`, `checkpoint` are public; `privateKey`,
 * `seed`, `secret` are not. Field names are the only reliable signal, which is why
 * values are never partially masked on shape alone.
 */

/** Field names that must never be printed, matched case-insensitively as substrings. */
const SECRET_FIELD =
  /(private|secret|seed|mnemonic|passphrase|password|credential|bearer|apikey|api_key|signerkey|auth[_-]?token|^tokens?$|^authorization$|^authentication$|^headers?$)/i;

/**
 * Field names that are public despite matching a broad pattern above or looking
 * key-shaped. Checked first, so they are never redacted by accident.
 */
const PUBLIC_FIELD = /^(address|sender|payTo|pay_to|owner|owner_account|feePayer|fee_payer|agentWallet|agent_wallet|transaction|tx_?hash|hash|metadata_hash_hex|metadata_sha256|sha256|head_hash|prev_hash|checkpoint|resourceUrl|resource_url|agent_uri|token_address|contract|network|session_id|sessionId|token_id)$/i;

/** A value that is 32+ hex chars with no public field name to vouch for it. */
const HEX_KEY_SHAPED = /^(0x)?[0-9a-f]{64,}$/i;

/** BIP-39-ish: 12+ lowercase words separated by single spaces. */
const MNEMONIC_SHAPED = /^([a-z]{3,8}\s+){11,}[a-z]{3,8}$/;

/** Credential-shaped values: bearer headers, provider tokens, basic auth. */
const CREDENTIAL_SHAPED = /^(bearer|basic|token|apikey)\s+\S+$|\b(gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/i;

export const REDACTED = '[REDACTED]';

/**
 * Redact one value for diagnostics.
 *
 * Returns a plain JSON-safe structure: objects are shallow-copied per level,
 * arrays mapped, primitives passed through unless they match a secret shape.
 * No cycles are expected in diagnostic payloads; if one appears, it is reported
 * as `[CIRCULAR]` rather than throwing inside an error handler.
 */
export function redact(value: unknown, key = '', depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[TRUNCATED]';

  if (PUBLIC_FIELD.test(key)) return value;

  if (typeof value === 'string') {
    if (MNEMONIC_SHAPED.test(value)) return REDACTED;
    if (HEX_KEY_SHAPED.test(value)) return REDACTED;
    if (CREDENTIAL_SHAPED.test(value)) return REDACTED;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (typeof value === 'function') return '[FUNCTION]';
  if (typeof value === 'symbol') return '[SYMBOL]';

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[CIRCULAR]';
    seen.add(value as object);

    // Errors carry their useful diagnostics on non-enumerable properties, so a
    // plain Object.entries walk would return {} — losing the message *and* the
    // redaction of whatever the error attached.
    if (value instanceof Error) {
      const own = value as unknown as Record<string, unknown>;
      const out: Record<string, unknown> = {
        name: value.name,
        message: redact(value.message, 'message', depth + 1, seen),
        ...(typeof own['code'] === 'string' ? { code: own['code'] } : {}),
      };
      if (own['cause'] !== undefined) out['cause'] = redact(own['cause'], 'cause', depth + 1, seen);
      for (const [k, v] of Object.entries(own)) {
        if (k === 'name' || k === 'message' || k === 'stack' || k === 'cause' || k === 'code') continue;
        out[k] = SECRET_FIELD.test(k) && !PUBLIC_FIELD.test(k) ? REDACTED : redact(v, k, depth + 1, seen);
      }
      return out;
    }

    if (Array.isArray(value)) {
      // A secret-named field short-circuits above; inside a normal array each
      // element is judged on its own, not on the array's field name.
      return value.slice(0, 50).map(v => redact(v, '', depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(k) && !PUBLIC_FIELD.test(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = redact(v, k, depth + 1, seen);
    }
    return out;
  }

  return REDACTED;
}

/** Convenience for a single-line diagnostic string. */
export function redactJson(value: unknown, maxLength = 1500): string {
  let text: string;
  try {
    text = JSON.stringify(redact(value));
  } catch {
    return '[UNSERIALIZABLE]';
  }
  return text && text.length > maxLength ? `${text.slice(0, maxLength)}…[truncated]` : (text ?? 'null');
}
