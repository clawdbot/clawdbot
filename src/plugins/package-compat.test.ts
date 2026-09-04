// Verifies plugin package API compatibility ranges.
import { describe, expect, it } from "vitest";
import { satisfiesPluginApiRange } from "./package-compat.js";

describe("package plugin API compatibility", () => {
  it("checks plugin api ranges with semver precedence", () => {
    expect(satisfiesPluginApiRange("1.2.3", "^1.2.0")).toBe(true);
    expect(satisfiesPluginApiRange("1.2.3", "~1.2.0")).toBe(true);
    expect(satisfiesPluginApiRange("1.2.3", "1.2.x")).toBe(true);
    expect(satisfiesPluginApiRange("1.9.0", ">=1.2.0 <2.0.0")).toBe(true);
    expect(satisfiesPluginApiRange("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("2.0.0-beta.1", "^1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.1.9", ">=1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.22", ">=2026.3.22")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.21", ">=2026.3.22")).toBe(false);
    expect(satisfiesPluginApiRange("invalid", "^1.2.0")).toBe(false);
  });

  it("treats OpenClaw release correction versions as stable plugin API hosts", () => {
    expect(satisfiesPluginApiRange("2026.5.3-1", ">=2026.5.3")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.32-1", ">=2026.5.32")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.3-2", ">=2026.5.3")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.3-beta.1", ">=2026.5.3")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.3-alpha.1", ">=2026.5.3")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.3-rc.1", ">=2026.5.3")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.2-beta.1", ">=2026.5.3")).toBe(false);
  });

  it("preserves prerelease ordering for explicit plugin API prerelease floors", () => {
    expect(satisfiesPluginApiRange("2026.3.24-beta.1", ">=2026.3.24-beta.2")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.24-beta.2", ">=2026.3.24-beta.2")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.24-1", ">=2026.3.24-beta.2")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.24", ">=2026.3.24-beta.2")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.24-beta.1", ">=2026.3.24")).toBe(true);
  });

  it("accepts legacy bare major.minor plugin api ranges as lower bounds", () => {
    expect(satisfiesPluginApiRange("2026.5.2", "2026.4")).toBe(true);
    expect(satisfiesPluginApiRange("2026.4.0", "2026.4")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.99", "2026.4")).toBe(false);
    expect(satisfiesPluginApiRange("2026.4.1", "=2026.4")).toBe(false);
    expect(satisfiesPluginApiRange("2026.5.2", "=2026.4")).toBe(false);
    expect(satisfiesPluginApiRange("invalid", "2026.4")).toBe(false);
  });

  it.each(["*", "x", "X", "=*", "=x", ">=*", ">=x", "<=*", "^*", "~*"] as const)(
    "accepts plugin api wildcard range %s for valid runtime versions",
    (range) => {
      expect(satisfiesPluginApiRange("2026.3.24", range)).toBe(true);
      expect(satisfiesPluginApiRange("1.0.0", range)).toBe(true);
    },
  );

  it("keeps wildcard plugin api ranges intersected with concrete comparators", () => {
    expect(satisfiesPluginApiRange("2026.3.24", "* >=2026.3.22")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.21", "* >=2026.3.22")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.24", "x <2026.3.24")).toBe(false);
  });

  it("rejects invalid runtime versions and impossible wildcard comparators", () => {
    expect(satisfiesPluginApiRange("invalid", "*")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.24", ">*")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.24", "<*")).toBe(false);
    expect(satisfiesPluginApiRange("1.5.0", ">=1.0.0 || >=2.0.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.2.3", "1.2.3||2.0.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.5.0", "1.0.0 - 2.0.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.2.3", "~>1.2.3")).toBe(false);
  });
});
