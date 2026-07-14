// Nostr tests cover nostr bus plugin behavior.
import { nip19 } from "nostr-tools";
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

    it("survives a hex→npub→normalizePubkey roundtrip", () => {
      expect(normalizePubkey(nip19.npubEncode(HEX))).toBe(HEX);
    });

    it("trims surrounding whitespace before decoding", () => {
      expect(normalizePubkey(`  ${NPUB}  `)).toBe(HEX);
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
