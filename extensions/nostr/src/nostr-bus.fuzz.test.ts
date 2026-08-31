// Nostr tests cover nostr bus.fuzz plugin behavior.
import { describe, expect, it } from "vitest";
import { validatePrivateKey, normalizePubkey } from "./nostr-key-utils.js";
import { TEST_HEX_PRIVATE_KEY } from "./test-fixtures.js";

function expectThrowsError(run: () => unknown): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
}

// ============================================================================
// Fuzz Tests for validatePrivateKey
// ============================================================================

describe("validatePrivateKey fuzz", () => {
  describe("validatePrivateKey type confusion", () => {
    it("rejects non-string input", () => {
      for (const value of [null, undefined, 123, true, {}, [], () => {}]) {
        expectThrowsError(() => validatePrivateKey(value as unknown as string));
      }
    });
  });

  describe("unicode attacks", () => {
    it("rejects unicode and control-character attacks", () => {
      const invalidKeys = [
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\u200Bf",
        `\u202E${TEST_HEX_PRIVATE_KEY}`,
        "0123456789\u0430bcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab😀",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\u0301",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\x00f",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\nf",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\rf",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\tf",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\ff",
      ];

      for (const key of invalidKeys) {
        expectThrowsError(() => validatePrivateKey(key));
      }
    });
  });

  describe("edge cases", () => {
    it("rejects very long string", () => {
      const veryLong = "a".repeat(10000);
      expectThrowsError(() => validatePrivateKey(veryLong));
    });

    it("rejects string of spaces matching length", () => {
      const spaces = " ".repeat(64);
      expectThrowsError(() => validatePrivateKey(spaces));
    });

    it("rejects hex with spaces between characters", () => {
      const withSpaces =
        "01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef";
      expectThrowsError(() => validatePrivateKey(withSpaces));
    });
  });

  describe("nsec format edge cases", () => {
    it("rejects nsec with invalid bech32 characters", () => {
      // 'b', 'i', 'o' are not valid bech32 characters
      const invalidBech32 = "nsec1qypqxpq9qtpqscx7peytbfwtdjmcv0mrz5rjpej8vjppfkqfqy8skqfv3l";
      expectThrowsError(() => validatePrivateKey(invalidBech32));
    });

    it("rejects nsec with wrong prefix", () => {
      expectThrowsError(() => validatePrivateKey("nsec0aaaa"));
    });

    it("rejects partial nsec", () => {
      expectThrowsError(() => validatePrivateKey("nsec1"));
    });
  });
});

describe("normalizePubkey fuzz", () => {
  describe("prototype pollution attempts", () => {
    it("throws for prototype property names", () => {
      for (const value of ["__proto__", "constructor", "prototype"]) {
        expectThrowsError(() => normalizePubkey(value));
      }
    });
  });

  describe("case sensitivity", () => {
    it("normalizes uppercase to lowercase", () => {
      const upper = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
      expect(normalizePubkey(upper)).toBe(TEST_HEX_PRIVATE_KEY);
    });

    it("normalizes mixed case to lowercase", () => {
      const mixed = "0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf";
      expect(normalizePubkey(mixed)).toBe(TEST_HEX_PRIVATE_KEY);
    });
  });
});
