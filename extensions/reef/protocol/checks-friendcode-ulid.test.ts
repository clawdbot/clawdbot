import { describe, expect, it } from "vitest";
import { deterministicChecks } from "./checks.js";
import { mintFriendCode, verifyFriendCode } from "./friendcode.js";
import { createMonotonicUlidFactory } from "./ulid.js";

// Secret-shaped fixtures are assembled at runtime so the source never contains
// scanner-matching literals (GitHub push protection, review bundlers, trufflehog).
const fake = (...parts: string[]) => parts.join("");

describe("deterministic checks", () => {
  it.each([
    fake("-----BEGIN PRIVATE", " KEY-----"),
    fake("sk-", "abcdefghijklmnopqrstuvwxyz123456"),
    fake("ghp", "_abcdefghijklmnopqrstuvwxyz123456"),
    fake("gho", "_abcdefghijklmnopqrstuvwxyz123456"),
    fake("AKIA", "IOSFODNN7EXAMPLE"),
    fake("xoxb", "-123456789012-abcdefghijklmnop"),
    fake("eyJ", "abcdefghij.abcdefghijkl.abcdefghijkl"),
    fake("4f9e8d7c6b5a4321", "0f9e8d7c6b5a4321", "4f9e8d7c6b5a4321", "0f9e8d7c6b5a4321"),
    fake("Q7vN2kLm9Pz4Rxa8", "CwT5Yb3Hj6Uf1Ds0GeKqVnM2LX8"),
  ])("denies secret corpus item without a model call: %s", (text) => {
    expect(deterministicChecks(text)).toMatchObject({ allowed: false });
  });

  it.each([
    "meeting at ten",
    "the quick brown fox jumps over the lazy dog",
    "00000000000000000000000000000000",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "issue-1234567890-is-not-a-secret",
    "Donaudampfschifffahrtsgesellschaft",
    "https://github.com/steipete/reallylongreponame",
    "The pneumonoultramicroscopicsilicovolcanoconiosis example is benign.",
  ])("allows benign corpus item: %s", (text) => {
    expect(deterministicChecks(text)).toEqual({ allowed: true, text, findings: [] });
  });

  it("rejects invalid UTF-8 and oversize input", () => {
    expect(deterministicChecks(Uint8Array.of(0xc3, 0x28)).findings[0]?.code).toBe("invalid_utf8");
    expect(deterministicChecks("x".repeat(32 * 1024 + 1)).findings[0]?.code).toBe("too_large");
  });
});

describe("friend codes", () => {
  it("mints deterministic Crockford codes and enforces expiry", () => {
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nonce = Uint8Array.from({ length: 16 }, (_, index) => index + 16);
    const code = mintFriendCode(secret, { expiry: 2_000, nonce });
    expect(code.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(verifyFriendCode(code, secret, { now: 2_000 })).toBe(true);
    expect(verifyFriendCode(code, secret, { now: 2_001 })).toBe(false);
    expect(
      verifyFriendCode({ ...code, code: `Z${code.code.slice(1)}` }, secret, { now: 2_000 }),
    ).toBe(false);
  });

  it.each([0, 16])("rejects a %i-byte device secret", (length) => {
    const shortSecret = new Uint8Array(length);
    const validSecret = new Uint8Array(32);
    const nonce = new Uint8Array(16);
    const code = mintFriendCode(validSecret, { expiry: 2_000, nonce });
    expect(() => mintFriendCode(shortSecret, { expiry: 2_000, nonce })).toThrow(
      "invalid friend code input",
    );
    expect(verifyFriendCode(code, shortSecret, { now: 2_000 })).toBe(false);
  });
});

describe("monotonic ULIDs", () => {
  it("is deterministic and monotonic with injected clock and rng", () => {
    const make = createMonotonicUlidFactory({ clock: () => 1_000, rng: () => new Uint8Array(10) });
    const first = make();
    const second = make();
    expect(first).toBe("00000000Z80000000000000000");
    expect(second).toBe("00000000Z80000000000000001");
    expect(second > first).toBe(true);
  });
});
