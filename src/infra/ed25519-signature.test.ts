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
  // Verification runs before authentication, so both inputs are attacker-chosen
  // and unbudgeted: a handshake buys a key parse plus a verify. These assert the
  // guard through the public API — the shape checks are internal on purpose.
  function keyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    return {
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    };
  }

  it("still verifies a genuine signature", () => {
    const { publicKeyPem, privateKeyPem } = keyPair();
    const signatureBase64Url = signEd25519Payload(privateKeyPem, "payload");
    expect(
      verifyEd25519Signature({ publicKey: publicKeyPem, payload: "payload", signatureBase64Url }),
    ).toBe(true);
  });

  it("rejects an oversized public key even when it would otherwise parse", () => {
    // The behavioural edge of the bound. Node accepts a valid PEM padded with
    // trailing whitespace, so without a cap this verifies — and the PEM path
    // never passes through base64UrlDecode's existing 4096-char limit, leaving
    // crypto.createPublicKey to absorb attacker-chosen length pre-auth.
    const { publicKeyPem, privateKeyPem } = keyPair();
    const signatureBase64Url = signEd25519Payload(privateKeyPem, "payload");
    const paddedPem = `${publicKeyPem}${"\n".repeat(1200)}`;

    expect(paddedPem.length).toBeGreaterThan(1024);
    expect(
      verifyEd25519Signature({ publicKey: paddedPem, payload: "payload", signatureBase64Url }),
    ).toBe(false);
  });

  it("rejects a junk PEM far larger than any real key", () => {
    const { privateKeyPem } = keyPair();
    const signatureBase64Url = signEd25519Payload(privateKeyPem, "payload");
    const junkPem = `-----BEGIN PUBLIC KEY-----\n${"A".repeat(512 * 1024)}\n-----END PUBLIC KEY-----\n`;
    expect(
      verifyEd25519Signature({ publicKey: junkPem, payload: "payload", signatureBase64Url }),
    ).toBe(false);
  });

  it("rejects an oversized signature", () => {
    const { publicKeyPem } = keyPair();
    expect(
      verifyEd25519Signature({
        publicKey: publicKeyPem,
        payload: "payload",
        signatureBase64Url: "A".repeat(512 * 1024),
      }),
    ).toBe(false);
  });

  it("still accepts a standard-base64 signature encoding", () => {
    // The verify path tolerates base64 as well as base64url; the pre-check must
    // not be stricter than the path it guards.
    const { publicKeyPem, privateKeyPem } = keyPair();
    const base64url = signEd25519Payload(privateKeyPem, "payload");
    const standardBase64 = Buffer.from(base64url, "base64url").toString("base64");
    expect(
      verifyEd25519Signature({
        publicKey: publicKeyPem,
        payload: "payload",
        signatureBase64Url: standardBase64,
      }),
    ).toBe(true);
  });

  it("keeps the normalize contract for short non-key values", () => {
    // normalize deliberately normalises any non-empty decode, not only 32-byte
    // keys, so it takes the length bound only.
    expect(normalizeEd25519PublicKeyBase64Url("-_8B")).toBe("-_8B");
    expect(normalizeEd25519PublicKeyBase64Url("A".repeat(4096))).toBeNull();
  });
});
