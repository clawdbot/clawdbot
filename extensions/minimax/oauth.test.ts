import { describe, expect, it } from "vitest";
import { normalizeOAuthExpires } from "./oauth.js";

describe("normalizeOAuthExpires", () => {
  it("converts relative expiry seconds into an absolute millisecond timestamp", () => {
    expect(normalizeOAuthExpires(86_400, 1_700_000_000_000)).toBe(1_700_086_400_000);
  });

  it("converts Unix second timestamps into milliseconds", () => {
    expect(normalizeOAuthExpires(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("preserves absolute millisecond timestamps", () => {
    expect(normalizeOAuthExpires(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("rejects unsafe and malformed expiry values", () => {
    expect(normalizeOAuthExpires(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeOAuthExpires(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(normalizeOAuthExpires("3600s")).toBeUndefined();
  });
});
