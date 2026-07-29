// Secret input normalization tests cover trimming and empty-value handling.
import { describe, expect, it } from "vitest";
import { normalizeOptionalSecretInput, normalizeSecretInput } from "./normalize-secret-input.js";

describe("normalizeSecretInput", () => {
  it("returns empty string for non-string values", () => {
    expect(normalizeSecretInput(undefined)).toBe("");
    expect(normalizeSecretInput(null)).toBe("");
    expect(normalizeSecretInput(123)).toBe("");
    expect(normalizeSecretInput({})).toBe("");
  });

  it("strips embedded line breaks and surrounding whitespace", () => {
    expect(normalizeSecretInput("  sk-\r\nabc\n123  ")).toBe("sk-abc123");
  });

  it("strips embedded control characters while preserving ordinary spaces", () => {
    expect(normalizeSecretInput("  sk-\u0000ab\tc\u007f\u0085  ")).toBe("sk-abc");
    expect(normalizeSecretInput("  Bearer token value  ")).toBe("Bearer token value");
  });

  it("drops non-Latin1 code points that can break HTTP ByteString headers", () => {
    // U+0417 (Cyrillic З) and U+2502 (box drawing │) are > 255.
    expect(normalizeSecretInput("key-\u0417\u2502-token")).toBe("key--token");
  });

  it("preserves Latin-1 characters and internal spaces", () => {
    expect(normalizeSecretInput("  café token  ")).toBe("café token");
  });
});

describe("normalizeOptionalSecretInput", () => {
  it("returns undefined when normalized value is empty", () => {
    expect(normalizeOptionalSecretInput(" \r\n ")).toBeUndefined();
    expect(normalizeOptionalSecretInput("\u0417\u2502")).toBeUndefined();
  });

  it("returns normalized value when non-empty", () => {
    expect(normalizeOptionalSecretInput("  key-\u0417  ")).toBe("key-");
  });
});
