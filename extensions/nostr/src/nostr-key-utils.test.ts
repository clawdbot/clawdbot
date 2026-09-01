import * as nip19 from "nostr-tools/nip19";
import { describe, expect, it } from "vitest";
import { validatePrivateKey, getPublicKeyFromPrivate, normalizePubkey } from "./nostr-key-utils.js";
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

describe("validatePrivateKey", () => {
  describe("validatePrivateKey hex format", () => {
    it("accepts valid 64-char hex key", () => {
      const result = validatePrivateKey(TEST_HEX_PRIVATE_KEY);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    });

    it("accepts mixed case hex", () => {
      const mixed = "0123456789ABCdef0123456789abcDEF0123456789abcdef0123456789ABCDEF";
      const result = validatePrivateKey(mixed);
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("trims newlines", () => {
      const result = validatePrivateKey(`${TEST_HEX_PRIVATE_KEY}\n`);
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it("rejects 63-char hex (too short)", () => {
      expect(() => validatePrivateKey(TEST_HEX_PRIVATE_KEY.slice(0, 63))).toThrow(
        "Private key must be 64 hex characters",
      );
    });

    it("rejects 65-char hex (too long)", () => {
      expect(() => validatePrivateKey(TEST_HEX_PRIVATE_KEY + "0")).toThrow(
        "Private key must be 64 hex characters",
      );
    });

    it("rejects whitespace-only string", () => {
      expect(() => validatePrivateKey("   ")).toThrow("Private key must be 64 hex characters");
    });

    it("rejects key with 0x prefix", () => {
      expect(() => validatePrivateKey("0x" + TEST_HEX_PRIVATE_KEY)).toThrow(
        "Private key must be 64 hex characters",
      );
    });
  });

  describe("nsec format", () => {
    it("accepts uppercase bech32 private keys", () => {
      const nsec = nip19.nsecEncode(Buffer.from(TEST_HEX_PRIVATE_KEY, "hex"));

      expect(validatePrivateKey(nsec.toUpperCase())).toEqual(validatePrivateKey(nsec));
    });

    it("rejects mixed-case bech32 private keys", () => {
      const nsec = nip19.nsecEncode(Buffer.from(TEST_HEX_PRIVATE_KEY, "hex"));

      expectThrowsError(() => validatePrivateKey(`N${nsec.slice(1)}`));
    });

    it.each([
      "nsec1not-a-real-secret",
      (() => {
        const nsec = nip19.nsecEncode(Buffer.from(TEST_HEX_PRIVATE_KEY, "hex"));
        return `${nsec.slice(0, -1)}${nsec.endsWith("q") ? "p" : "q"}`;
      })(),
    ])("rejects invalid nsec without including it in the error", (badNsec) => {
      let error: unknown;
      try {
        validatePrivateKey(badNsec);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(badNsec);
    });

    it("rejects npub (wrong type)", () => {
      const npub = "npub1qypqxpq9qtpqscx7peytzfwtdjmcv0mrz5rjpej8vjppfkqfqy8s5epk55";
      expectThrowsError(() => validatePrivateKey(npub));
    });
  });
});

describe("normalizePubkey", () => {
  describe("normalizePubkey hex format", () => {
    it("lowercases hex pubkey", () => {
      const upper = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
      const result = normalizePubkey(upper);
      expect(result).toBe(upper.toLowerCase());
    });

    it("rejects invalid hex", () => {
      expect(() => normalizePubkey("invalid")).toThrow("Pubkey must be 64 hex characters");
    });

    it("trims surrounding whitespace", () => {
      expect(normalizePubkey(`  ${TEST_HEX_PRIVATE_KEY}  `)).toBe(TEST_HEX_PRIVATE_KEY);
    });
  });

  describe("normalizePubkey npub format", () => {
    // Regression: pre-fix this returned a 128-char garbage string because the
    // implementation treated nip19.decode(npub).data as a Uint8Array, but
    // nostr-tools >=2.0 returns it as the hex string directly. allowFrom
    // entries written as npubs therefore never matched any hex sender pubkey.
    const HEX = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const NPUB = nip19.npubEncode(HEX);

    it("decodes npub to the original 64-char hex pubkey", () => {
      const result = normalizePubkey(NPUB);
      expect(result).toBe(HEX);
      expect(result).toMatch(/^[0-9a-f]{64}$/);
      expect(result.length).toBe(64);
    });

    it("trims surrounding whitespace before decoding", () => {
      expect(normalizePubkey(`  ${NPUB}  `)).toBe(HEX);
    });

    it("decodes uppercase bech32 public keys", () => {
      expect(normalizePubkey(NPUB.toUpperCase())).toBe(HEX);
    });

    it("rejects mixed-case bech32 public keys", () => {
      expectThrowsError(() => normalizePubkey(`N${NPUB.slice(1)}`));
    });
  });
});

describe("getPublicKeyFromPrivate", () => {
  it("derives public key from hex private key", () => {
    const pubkey = getPublicKeyFromPrivate(TEST_HEX_PRIVATE_KEY);
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(pubkey.length).toBe(64);
    expect(getPublicKeyFromPrivate(TEST_HEX_PRIVATE_KEY)).toBe(pubkey);
  });

  it("throws for invalid private key", () => {
    expectThrowsError(() => getPublicKeyFromPrivate("invalid"));
  });
});

describe("validatePrivateKey malformed inputs", () => {
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

describe("normalizePubkey malformed inputs", () => {
  describe("prototype pollution attempts", () => {
    it("throws for prototype property names", () => {
      for (const value of ["__proto__", "constructor", "prototype"]) {
        expectThrowsError(() => normalizePubkey(value));
      }
    });
  });

  describe("case sensitivity", () => {
    it("normalizes mixed case to lowercase", () => {
      const mixed = "0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf";
      expect(normalizePubkey(mixed)).toBe(TEST_HEX_PRIVATE_KEY);
    });
  });
});
