// Allowlist tests cover doctor allowlist diagnostics and repair helpers.
import { describe, expect, it } from "vitest";
import { hasAllowFromEntries } from "./allowlist.js";

describe("doctor allowlist helpers", () => {
  it("returns false for missing and blank entries", () => {
    expect(hasAllowFromEntries()).toBe(false);
    expect(hasAllowFromEntries([])).toBe(false);
    expect(hasAllowFromEntries(["", "   "])).toBe(false);
  });

  it("returns true when at least one trimmed entry is present", () => {
    expect(hasAllowFromEntries(["   ", "12345"])).toBe(true);
    expect(hasAllowFromEntries([0, " "])).toBe(true);
  });
});
