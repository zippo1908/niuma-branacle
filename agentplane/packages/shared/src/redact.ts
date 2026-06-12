/**
 * Secret redaction applied to every log line before it is persisted to the DB,
 * published over SSE, or shown in the portal (docs/architecture/07 §8).
 *
 * The raw, un-redacted stream is only ever written to `/logs/{run_id}.log`
 * (mode 0600, admin-only download via the audited endpoint).
 */

const REDACTED = "***REDACTED***";

const PATTERNS: RegExp[] = [
  // key=value / key: value style secrets
  /\b(api[_-]?key|token|secret|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[=:]\s*['"]?[\w.\-/+=]{6,}['"]?/gi,
  // Authorization headers
  /\b(authorization|x-api-key)\b\s*[=:]\s*['"]?\S+['"]?/gi,
  // AWS access key id + secret
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\baws_secret_access_key\b\s*[=:]\s*\S+/gi,
  // GitHub tokens (classic + fine-grained + oauth)
  /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
  // OpenAI / Anthropic style keys
  /\bsk-[A-Za-z0-9_\-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_\-]{16,}\b/g,
  // Private key blocks
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

export function redact(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(re, (match) => {
      // Preserve the "key=" prefix where present so logs stay readable.
      const eq = match.search(/[=:]/);
      if (eq > 0 && /^[\w.\-/ ]+$/.test(match.slice(0, eq))) {
        return match.slice(0, eq + 1) + " " + REDACTED;
      }
      return REDACTED;
    });
  }
  return out;
}

/** True if a string still appears to contain a secret after redaction (defence-in-depth check for tests). */
export function looksRedacted(input: string): boolean {
  return input.includes(REDACTED);
}
