import { describe, it, expect } from "vitest";
import { redact } from "./redact.js";

describe("redact", () => {
  it("masks key=value secrets but keeps the key", () => {
    expect(redact("ANTHROPIC_API_KEY=sk-ant-abc123def456ghi789")).toContain("***REDACTED***");
    expect(redact("password: hunter2hunter2")).toContain("***REDACTED***");
  });

  it("masks provider tokens anywhere", () => {
    expect(redact("using ghp_0123456789abcdefABCDEF0123456789abcd now")).toContain("***REDACTED***");
    expect(redact("key sk-abcdefghijklmnopqrstuv done")).toContain("***REDACTED***");
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toContain("***REDACTED***");
  });

  it("masks private key blocks", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY-----";
    expect(redact(pem)).toBe("***REDACTED***");
  });

  it("leaves ordinary log text untouched", () => {
    const line = "Running tests... 12 passed, 0 failed in 3.2s";
    expect(redact(line)).toBe(line);
  });
});
