import { describe, it, expect } from "vitest";
import { roleAtLeast, roleRank } from "./roles.js";

describe("roles", () => {
  it("orders roles", () => {
    expect(roleRank("viewer")).toBeLessThan(roleRank("developer"));
    expect(roleRank("reviewer")).toBeLessThan(roleRank("admin"));
    expect(roleRank("admin")).toBeLessThan(roleRank("owner"));
  });
  it("roleAtLeast respects the hierarchy", () => {
    expect(roleAtLeast("developer", "developer")).toBe(true);
    expect(roleAtLeast("reviewer", "developer")).toBe(true);
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("viewer", "developer")).toBe(false);
    expect(roleAtLeast("developer", "reviewer")).toBe(false);
    expect(roleAtLeast(null, "viewer")).toBe(false);
  });
});
