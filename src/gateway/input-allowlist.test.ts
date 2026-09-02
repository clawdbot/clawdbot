/**
 * Gateway input allowlist tests.
 */
import { describe, expect, it } from "vitest";
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";

describe("normalizeInputHostnameAllowlist", () => {
  it("treats missing and empty allowlists as unset", () => {
    expect(normalizeInputHostnameAllowlist(undefined)).toBeUndefined();
    expect(normalizeInputHostnameAllowlist([])).toBeUndefined();
  });

  it("drops whitespace-only entries and treats the result as unset", () => {
    expect(normalizeInputHostnameAllowlist(["", "   "])).toBeUndefined();
  });

  it("preserves trimmed hostname patterns", () => {
    expect(normalizeInputHostnameAllowlist([" cdn.example.com ", "*.assets.example.com"])).toEqual([
      "cdn.example.com",
      "*.assets.example.com",
    ]);
  });
});
