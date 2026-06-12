import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a GitHub webhook `X-Hub-Signature-256` header against the raw body
 * (docs/architecture/07 §5). Constant-time compare; tolerant of a missing header.
 */
export function verifyGithubSignature(secret: string, rawBody: string | Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Map a GitHub workflow_run conclusion/status to our ci_status. */
export function mapGithubCiStatus(status: string | null, conclusion: string | null): string {
  if (status === "queued") return "queued";
  if (status === "in_progress") return "in_progress";
  if (status === "completed") {
    switch (conclusion) {
      case "success":
        return "success";
      case "cancelled":
        return "cancelled";
      default:
        return "failure"; // failure | timed_out | action_required | stale | ...
    }
  }
  return "pending";
}
