import { describe, expect, it } from "vitest";
import {
  validatePrivateKey,
  getPublicKeyFromPrivate,
  isValidPubkey,
  normalizePubkey,
  pubkeyToNpub,
} from "./nostr-key-utils.js";
import { TEST_HEX_PRIVATE_KEY, TEST_NSEC } from "./test-fixtures.js";

const UPPERCASE_HEX = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
const INVALID_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg";

function expectThrowsError(run: () => unknown): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
}

const uppercaseHexAcceptanceCases = [
  {
    name: "validatePrivateKey",
    assert: () => {
      const result = validatePrivateKey(TEST_HEX_PRIVATE_KEY.toUpperCase());
      expect(result).toBeInstanceOf(Uint8Array);
    },
  },
  {
    name: "isValidPubkey",
    assert: () => {
      expect(isValidPubkey(UPPERCASE_HEX)).toBe(true);
    },
  },
];

const invalidHexRejectionCases = [
  {
    name: "validatePrivateKey",
    assert: (input: string) => {
      expect(() => validatePrivateKey(input)).toThrow("Private key must be 64 hex characters");
    },
  },
  {
    name: "isValidPubkey",
    assert: (input: string) => {
      expect(isValidPubkey(input)).toBe(false);
    },
  },
];

const whitespaceNormalizationCases = [
  {
    name: "validatePrivateKey",
    assert: () => {
      const result = validatePrivateKey(`  ${TEST_HEX_PRIVATE_KEY}  `);
      expect(result).toBeInstanceOf(Uint8Array);
    },
  },
  {
    name: "normalizePubkey",
    assert: () => {
      expect(normalizePubkey(`  ${TEST_HEX_PRIVATE_KEY}  `)).toBe(TEST_HEX_PRIVATE_KEY);
    },
  },
];

describe("hex key helper contracts", () => {
  it.each(uppercaseHexAcceptanceCases)("$name accepts uppercase hex", ({ assert }) => {
    assert();
  });

  it.each(invalidHexRejectionCases)("$name rejects non-hex characters", ({ assert }) => {
    assert(INVALID_HEX);
  });

  it.each(invalidHexRejectionCases)("$name rejects empty string", ({ assert }) => {
    assert("");
  });

  it.each(whitespaceNormalizationCases)("$name trims whitespace", ({ assert }) => {
    assert();
  });
});

describe("validatePrivateKey", () => {
  describe("validatePrivateKey hex format", () => {
    it("accepts valid 64-char hex key", () => {
      const result = validatePrivateKey(TEST_HEX_PRIVATE_KEY);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    });

    it("accepts lowercase hex", () => {
      const result = validatePrivateKey(TEST_HEX_PRIVATE_KEY.toLowerCase());
      expect(result).toBeInstanceOf(Uint8Array);
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
    it("rejects invalid nsec (wrong checksum)", () => {
      const badNsec = "nsec1invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid";
      expectThrowsError(() => validatePrivateKey(badNsec));
    });

    it("rejects npub (wrong type)", () => {
      const npub = "npub1qypqxpq9qtpqscx7peytzfwtdjmcv0mrz5rjpej8vjppfkqfqy8s5epk55";
      expectThrowsError(() => validatePrivateKey(npub));
    });
  });
});

describe("isValidPubkey", () => {
  describe("isValidPubkey hex format", () => {
    it("accepts valid 64-char hex pubkey", () => {
      expect(isValidPubkey(TEST_HEX_PRIVATE_KEY)).toBe(true);
    });

    it("rejects 63-char hex", () => {
      const shortHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde";
      expect(isValidPubkey(shortHex)).toBe(false);
    });

    it("rejects 65-char hex", () => {
      const longHex = `${TEST_HEX_PRIVATE_KEY}0`;
      expect(isValidPubkey(longHex)).toBe(false);
    });
  });

  describe("npub format", () => {
    it("rejects invalid npub", () => {
      expect(isValidPubkey("npub1invalid")).toBe(false);
    });

    it("rejects nsec (wrong type)", () => {
      expect(isValidPubkey(TEST_NSEC)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles whitespace-padded input", () => {
      expect(isValidPubkey(`  ${TEST_HEX_PRIVATE_KEY}  `)).toBe(true);
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
  });
});

describe("getPublicKeyFromPrivate", () => {
  it("derives public key from hex private key", () => {
    const pubkey = getPublicKeyFromPrivate(TEST_HEX_PRIVATE_KEY);
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(pubkey.length).toBe(64);
  });

  it("derives consistent public key", () => {
    const pubkey1 = getPublicKeyFromPrivate(TEST_HEX_PRIVATE_KEY);
    const pubkey2 = getPublicKeyFromPrivate(TEST_HEX_PRIVATE_KEY);
    expect(pubkey1).toBe(pubkey2);
  });

  it("throws for invalid private key", () => {
    expectThrowsError(() => getPublicKeyFromPrivate("invalid"));
  });
});

describe("pubkeyToNpub", () => {
  it("converts hex pubkey to npub format", () => {
    const npub = pubkeyToNpub(TEST_HEX_PRIVATE_KEY);
    expect(npub).toMatch(/^npub1[a-z0-9]+$/);
  });

  it("produces consistent output", () => {
    const npub1 = pubkeyToNpub(TEST_HEX_PRIVATE_KEY);
    const npub2 = pubkeyToNpub(TEST_HEX_PRIVATE_KEY);
    expect(npub1).toBe(npub2);
  });

  it("normalizes uppercase hex first", () => {
    const upper = TEST_HEX_PRIVATE_KEY.toUpperCase();
    expect(pubkeyToNpub(TEST_HEX_PRIVATE_KEY)).toBe(pubkeyToNpub(upper));
  });
});
