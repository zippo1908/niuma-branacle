import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyGithubSignature, mapGithubCiStatus } from "./webhook.js";

describe("verifyGithubSignature", () => {
  const secret = "s3cr3t";
  const body = JSON.stringify({ action: "completed" });
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correct signature", () => {
    expect(verifyGithubSignature(secret, body, sig)).toBe(true);
  });
  it("rejects a wrong signature / secret / missing header", () => {
    expect(verifyGithubSignature("wrong", body, sig)).toBe(false);
    expect(verifyGithubSignature(secret, body + "x", sig)).toBe(false);
    expect(verifyGithubSignature(secret, body, undefined)).toBe(false);
    expect(verifyGithubSignature(secret, body, "deadbeef")).toBe(false);
  });
});

describe("mapGithubCiStatus", () => {
  it("maps workflow_run states", () => {
    expect(mapGithubCiStatus("queued", null)).toBe("queued");
    expect(mapGithubCiStatus("in_progress", null)).toBe("in_progress");
    expect(mapGithubCiStatus("completed", "success")).toBe("success");
    expect(mapGithubCiStatus("completed", "failure")).toBe("failure");
    expect(mapGithubCiStatus("completed", "cancelled")).toBe("cancelled");
  });
});
