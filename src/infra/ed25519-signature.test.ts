import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  decodeCanonicalBase64OrBase64Url,
  deriveCanonicalEd25519PrivateKeyRaw,
  deriveCanonicalEd25519PublicKeyRaw,
  deriveEd25519PrivateKeyRaw,
  deriveEd25519PublicKeyRaw,
  ed25519PrivateKeyPemFromRaw,
  ed25519PublicKeyPemFromRaw,
  normalizeEd25519PublicKeyBase64Url,
} from "./ed25519-signature.js";

describe("strict base64 decoding", () => {
  it("accepts canonical unpadded base64url", () => {
    const raw = Buffer.from([0xfb, 0xff, 0x01]);
    expect(base64UrlDecode("-_8B")).toEqual(raw);
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
    expect(() => base64UrlDecode("A".repeat(5000))).toThrow(/maximum allowed length/);
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
