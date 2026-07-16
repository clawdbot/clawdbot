import { describe, expect, it } from "vitest";
import { isAllowlistedCaller, normalizePhoneNumber } from "./allowlist.js";

describe("voice-call allowlist", () => {
  it("normalizes phone numbers by stripping non-digits", () => {
    expect(normalizePhoneNumber("+1 (415) 555-0123")).toBe("14155550123");
    expect(normalizePhoneNumber("  020-7946-0958  ")).toBe("02079460958");
    expect(normalizePhoneNumber("")).toBe("");
    expect(normalizePhoneNumber()).toBe("");
  });

  it("matches normalized allowlist entries and rejects blank callers", () => {
    expect(isAllowlistedCaller("14155550123", ["+1 (415) 555-0123", " 020-7946-0958 "])).toBe(true);
    expect(isAllowlistedCaller("02079460958", ["+1 (415) 555-0123", " 020-7946-0958 "])).toBe(true);
    expect(isAllowlistedCaller("", ["+1 (415) 555-0123"])).toBe(false);
    expect(isAllowlistedCaller("14155550123", ["", "abc"])).toBe(false);
  });
});
