import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeCanonicalBase64OrBase64Url,
  deriveCanonicalEd25519PrivateKeyRaw,
  deriveCanonicalEd25519PublicKeyRaw,
  deriveEd25519PrivateKeyRaw,
  deriveEd25519PublicKeyRaw,
  ed25519PrivateKeyPemFromRaw,
  ed25519PublicKeyPemFromRaw,
  isPlausibleEd25519PublicKeyInput,
  isPlausibleEd25519SignatureInput,
  normalizeEd25519PublicKeyBase64Url,
  signEd25519Payload,
  verifyEd25519Signature,
} from "./ed25519-signature.js";

describe("strict base64 decoding", () => {
  it("accepts canonical unpadded base64url", () => {
    expect(normalizeEd25519PublicKeyBase64Url("-_8B")).toBe("-_8B");
  });

  it("accepts canonical standard base64 through the strict mixed decoder", () => {
    const raw = Buffer.from([0xfb, 0xff, 0x01]);
    expect(decodeCanonicalBase64OrBase64Url("+/8B")).toEqual(raw);
  });

  it.each(["", "A", "AB==", "AA=", "AA===", "AA==junk", "-_8B="])(
    "rejects noncanonical input %j",
    (input) => {
      expect(() => decodeCanonicalBase64OrBase64Url(input)).toThrow();
    },
  );

  it("throws on input exceeding the maximum allowed length", () => {
    expect(() => decodeCanonicalBase64OrBase64Url("A".repeat(5000))).toThrow(
      /maximum allowed length/,
    );
  });
});

describe("strict Ed25519 keys", () => {
  it("round-trips exact 32-byte raw keys", () => {
    const raw = Buffer.alloc(32, 7);
    const publicKeyPem = ed25519PublicKeyPemFromRaw(raw);
    const privateKeyPem = ed25519PrivateKeyPemFromRaw(raw);

    expect(deriveEd25519PublicKeyRaw(publicKeyPem)).toEqual(raw);
    expect(deriveEd25519PrivateKeyRaw(privateKeyPem)).toEqual(raw);
  });

  it.each([31, 33])("rejects %i-byte raw keys", (length) => {
    const raw = Buffer.alloc(length);
    expect(() => ed25519PublicKeyPemFromRaw(raw)).toThrow(/exactly 32 bytes/);
    expect(() => ed25519PrivateKeyPemFromRaw(raw)).toThrow(/exactly 32 bytes/);
  });

  it("rejects non-Ed25519 key types", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });

    expect(() => deriveEd25519PublicKeyRaw(publicKeyPem)).toThrow(/Ed25519/);
    expect(() => deriveEd25519PrivateKeyRaw(privateKeyPem)).toThrow(/Ed25519/);
    expect(normalizeEd25519PublicKeyBase64Url(publicKeyPem)).toBeNull();
  });

  it("rejects alternate PEM formatting even when crypto can parse it", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const variants = [
      publicKeyPem.trimEnd(),
      publicKeyPem.replaceAll("\n", "\r\n"),
      publicKeyPem.replace(/\n([A-Za-z0-9+/=]{30})/, "\n$1\n"),
    ];

    for (const pem of variants) {
      expect(() => crypto.createPublicKey(pem)).not.toThrow();
      expect(() => deriveCanonicalEd25519PublicKeyRaw(pem)).toThrow(/canonical PEM/);
      expect(deriveEd25519PublicKeyRaw(pem)).toHaveLength(32);
      expect(normalizeEd25519PublicKeyBase64Url(pem)).not.toBeNull();
    }
    expect(() => deriveCanonicalEd25519PrivateKeyRaw(privateKeyPem.trimEnd())).toThrow(
      /canonical PEM/,
    );
    expect(deriveEd25519PrivateKeyRaw(privateKeyPem.trimEnd())).toHaveLength(32);
  });
});

describe("pre-auth input bounds", () => {
  // Verification runs before authentication, so every one of these inputs is
  // attacker-chosen and unbudgeted: a handshake buys a key parse plus a verify.
  function keyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    return {
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
  }

  it("still verifies a genuine signature", () => {
    const { publicKeyPem, privateKeyPem } = keyPair();
    const signatureBase64Url = signEd25519Payload(privateKeyPem, "payload");
    expect(
      verifyEd25519Signature({ publicKey: publicKeyPem, payload: "payload", signatureBase64Url }),
    ).toBe(true);
  });

  it("rejects an oversized PEM public key without parsing it", () => {
    // The PEM path never passes through base64UrlDecode, so the existing
    // MAX_BASE64URL_DECODE_INPUT_LENGTH bound does not cover it.
    const { privateKeyPem } = keyPair();
    const signatureBase64Url = signEd25519Payload(privateKeyPem, "payload");
    const oversizedPem = `-----BEGIN PUBLIC KEY-----\n${"A".repeat(512 * 1024)}\n-----END PUBLIC KEY-----\n`;

    // Deterministic rather than timing-based: assert the shape check rejects it,
    // so the key never reaches crypto.createPublicKey. (Measured on the
    // unpatched path, parsing a 512KB junk PEM costs ~8.6ms against ~0.009ms
    // for a real key — a wall-clock threshold would be flaky in CI, so the
    // amplification numbers live in the PR body and the guard is asserted here.)
    expect(isPlausibleEd25519PublicKeyInput(oversizedPem)).toBe(false);
    expect(
      verifyEd25519Signature({
        publicKey: oversizedPem,
        payload: "payload",
        signatureBase64Url,
      }),
    ).toBe(false);
  });

  it("rejects an oversized signature without parsing the key", () => {
    const { publicKeyPem } = keyPair();
    expect(
      verifyEd25519Signature({
        publicKey: publicKeyPem,
        payload: "payload",
        signatureBase64Url: "A".repeat(512 * 1024),
      }),
    ).toBe(false);
  });

  it("rejects a raw public key that is not 32 bytes", () => {
    expect(isPlausibleEd25519PublicKeyInput("-_8B")).toBe(false);
    expect(isPlausibleEd25519PublicKeyInput(Buffer.alloc(32).toString("base64url"))).toBe(true);
  });

  it("accepts every signature encoding the verify path tolerates", () => {
    const raw = Buffer.alloc(64, 7);
    expect(isPlausibleEd25519SignatureInput(raw.toString("base64url"))).toBe(true);
    expect(isPlausibleEd25519SignatureInput(raw.toString("base64"))).toBe(true);
    expect(isPlausibleEd25519SignatureInput(Buffer.alloc(63).toString("base64url"))).toBe(false);
  });

  it("rejects empty and non-string input", () => {
    for (const bad of ["", null, undefined, 42, {}]) {
      expect(isPlausibleEd25519PublicKeyInput(bad)).toBe(false);
      expect(isPlausibleEd25519SignatureInput(bad)).toBe(false);
    }
  });

  it("still normalises a short non-key value (contract unchanged)", () => {
    // normalize deliberately accepts any non-empty decode; only length is bounded.
    expect(normalizeEd25519PublicKeyBase64Url("-_8B")).toBe("-_8B");
    expect(normalizeEd25519PublicKeyBase64Url("A".repeat(4096))).toBeNull();
  });
});
