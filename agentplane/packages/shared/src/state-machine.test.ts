import { describe, it, expect } from "vitest";
import {
  canTransitionDemand,
  canTransitionRun,
  assertDemandTransition,
  assertRunTransition,
  isTerminalRunStatus,
  isWriteMode,
  IllegalTransitionError,
} from "./state-machine.js";

describe("demand state machine", () => {
  it("allows the documented transitions", () => {
    expect(canTransitionDemand("inbox", "clarified")).toBe(true);
    expect(canTransitionDemand("queued", "running")).toBe(true);
    expect(canTransitionDemand("running", "waiting_review")).toBe(true);
    expect(canTransitionDemand("waiting_review", "accepted")).toBe(true);
    expect(canTransitionDemand("failed", "queued")).toBe(true);
  });

  it("rejects illegal jumps", () => {
    expect(canTransitionDemand("inbox", "running")).toBe(false);
    expect(canTransitionDemand("done", "queued")).toBe(false);
    expect(canTransitionDemand("accepted", "inbox")).toBe(false);
  });

  it("assert throws IllegalTransitionError", () => {
    expect(() => assertDemandTransition("inbox", "deployed")).toThrow(IllegalTransitionError);
    expect(() => assertDemandTransition("inbox", "clarified")).not.toThrow();
  });
});

describe("run state machine", () => {
  it("walks the happy path", () => {
    expect(canTransitionRun("queued", "preparing_workspace")).toBe(true);
    expect(canTransitionRun("preparing_workspace", "running")).toBe(true);
    expect(canTransitionRun("running", "waiting_review")).toBe(true);
    expect(canTransitionRun("running", "succeeded")).toBe(true);
  });

  it("treats waiting_review/succeeded/failed/cancelled/timed_out as terminal", () => {
    for (const s of ["waiting_review", "succeeded", "failed", "cancelled", "timed_out"] as const) {
      expect(isTerminalRunStatus(s)).toBe(true);
      expect(canTransitionRun(s, "running")).toBe(false);
    }
  });

  it("waiting_user_input can resume or time out", () => {
    expect(canTransitionRun("waiting_user_input", "running")).toBe(true);
    expect(canTransitionRun("waiting_user_input", "timed_out")).toBe(true);
    expect(() => assertRunTransition("succeeded", "running")).toThrow();
  });
});

describe("write modes", () => {
  it("edit/build/deploy are write modes; analysis/test are not write (analysis read-only)", () => {
    expect(isWriteMode("edit")).toBe(true);
    expect(isWriteMode("build")).toBe(true);
    expect(isWriteMode("deploy")).toBe(true);
    expect(isWriteMode("analysis")).toBe(false);
    expect(isWriteMode("test")).toBe(false);
  });
});
