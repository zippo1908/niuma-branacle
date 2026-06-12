import { describe, it, expect } from "vitest";
import { safeJoin, PathTraversalError, isValidSlug, sanitizeFilename } from "./safe-join.js";

describe("safeJoin", () => {
  const root = "/srv/agentplane/workspaces";

  it("joins safe relative paths", () => {
    expect(safeJoin(root, "proj", "run-1")).toBe("/srv/agentplane/workspaces/proj/run-1");
    expect(safeJoin(root, "attachments/a.png")).toBe("/srv/agentplane/workspaces/attachments/a.png");
  });

  it("blocks .. traversal", () => {
    expect(() => safeJoin(root, "..", "etc", "passwd")).toThrow(PathTraversalError);
    expect(() => safeJoin(root, "proj/../../escape")).toThrow(PathTraversalError);
  });

  it("blocks absolute injection", () => {
    expect(() => safeJoin(root, "/etc/passwd")).toThrow(PathTraversalError);
  });

  it("returns root itself when no segments escape", () => {
    expect(safeJoin(root)).toBe(root);
  });
});

describe("isValidSlug", () => {
  it("accepts safe slugs", () => {
    expect(isValidSlug("agentplane-portal")).toBe(true);
    expect(isValidSlug("p1")).toBe(true);
  });
  it("rejects unsafe slugs", () => {
    expect(isValidSlug("../etc")).toBe(false);
    expect(isValidSlug("Has Space")).toBe(false);
    expect(isValidSlug("a")).toBe(false); // too short
    expect(isValidSlug("UPPER")).toBe(false);
  });
});

describe("sanitizeFilename", () => {
  it("strips directories and unsafe chars", () => {
    expect(sanitizeFilename("../../evil.png")).toBe("evil.png");
    expect(sanitizeFilename("my report (1).png")).toBe("my_report__1_.png");
    expect(sanitizeFilename("/etc/passwd")).toBe("passwd");
  });
  it("never returns empty", () => {
    expect(sanitizeFilename("...")).toBe("file");
  });
});
