// Covers gateway TLS fingerprint normalization across prefixes, separators,
// blank values, and malformed text.
import { describe, expect, it } from "vitest";
import { normalizeFingerprint } from "./fingerprint.js";

describe("normalizeFingerprint", () => {
  it("strips sha256 prefixes and common separators", () => {
    expect(normalizeFingerprint("sha256:AA:BB:cc")).toBe("aabbcc");
    expect(normalizeFingerprint("SHA-256 11-22-33")).toBe("112233");
    expect(normalizeFingerprint("aa:bb:cc")).toBe("aabbcc");
  });

  it("handles blank, non-hex, and mixed punctuation input", () => {
    expect(normalizeFingerprint("   ")).toBe("");
    expect(normalizeFingerprint("sha256:zz-!!")).toBe("");
    expect(normalizeFingerprint("  sha256 : AB cd / 12  ")).toBe("abcd12");
  });

  it("only strips the sha256 prefix at the start of the value", () => {
    expect(normalizeFingerprint("prefix sha256:AA:BB")).toBe("efa256aabb");
  });
});
