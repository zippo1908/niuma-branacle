import { describe, it, expect } from "vitest";
import { scoreDemand, orderForStack, needsHuman, type PlannableDemand } from "./planning.js";

const base = (over: Partial<PlannableDemand>): PlannableDemand => ({
  id: "d", priority: 3, riskLevel: "medium", retryCount: 0, createdAt: new Date(0), status: "inbox", ...over,
});

describe("scoreDemand", () => {
  it("ranks higher priority above lower", () => {
    expect(scoreDemand(base({ priority: 1 }))).toBeGreaterThan(scoreDemand(base({ priority: 5 })));
  });
  it("bubbles up previously-failed (retry) demands", () => {
    expect(scoreDemand(base({ retryCount: 2 }))).toBeGreaterThan(scoreDemand(base({ retryCount: 0 })));
  });
});

describe("orderForStack", () => {
  it("orders by score desc", () => {
    const list = [base({ id: "low", priority: 5 }), base({ id: "high", priority: 1 }), base({ id: "mid", priority: 3 })];
    expect(orderForStack(list).map((d) => d.id)).toEqual(["high", "mid", "low"]);
  });
});

describe("needsHuman", () => {
  it("flags after 3 retries or critical risk", () => {
    expect(needsHuman({ retryCount: 3, riskLevel: "low" })).toBe(true);
    expect(needsHuman({ retryCount: 0, riskLevel: "critical" })).toBe(true);
    expect(needsHuman({ retryCount: 1, riskLevel: "medium" })).toBe(false);
  });
});
