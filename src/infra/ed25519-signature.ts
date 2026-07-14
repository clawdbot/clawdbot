import crypto from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

// Ed25519 public keys and signatures are fixed-size (<= ~86 base64url chars),
// so a caller passing far larger input is almost certainly malformed or abusive.
// Bound the decoded buffer to keep a single request from allocating arbitrary memory.
const MAX_BASE64URL_DECODE_INPUT_LENGTH = 4096;

export function base64UrlDecode(input: string): Buffer {
  if (input.length > MAX_BASE64URL_DECODE_INPUT_LENGTH) {
    throw new Error("base64url input exceeds the maximum allowed length");
  }
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function pemEncode(label: "PUBLIC KEY" | "PRIVATE KEY", der: Buffer): string {
  const body =
    der
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export function ed25519PublicKeyPemFromRaw(publicKeyRaw: Buffer): string {
  return pemEncode("PUBLIC KEY", Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]));
}

export function ed25519PrivateKeyPemFromRaw(privateKeyRaw: Buffer): string {
  return pemEncode("PRIVATE KEY", Buffer.concat([ED25519_PKCS8_PRIVATE_PREFIX, privateKeyRaw]));
}

export function deriveEd25519PublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

export function publicKeyRawBase64UrlFromEd25519Pem(publicKeyPem: string): string {
  return base64UrlEncode(deriveEd25519PublicKeyRaw(publicKeyPem));
}

export function normalizeEd25519PublicKeyBase64Url(publicKey: string): string | null {
  try {
    if (publicKey.includes("BEGIN")) {
      return publicKeyRawBase64UrlFromEd25519Pem(publicKey);
    }
    const raw = base64UrlDecode(publicKey);
    if (raw.length === 0) {
      return null;
    }
    return base64UrlEncode(raw);
  } catch {
    return null;
  }
}

export function signEd25519Payload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function createEd25519PublicKey(publicKey: string): crypto.KeyObject {
  return publicKey.includes("BEGIN")
    ? crypto.createPublicKey(publicKey)
    : crypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, base64UrlDecode(publicKey)]),
        type: "spki",
        format: "der",
      });
}

export function verifyEd25519Signature(params: {
  publicKey: string;
  payload: string;
  signatureBase64Url: string;
}): boolean {
  return verifyEd25519SignatureBytes({
    publicKey: params.publicKey,
    payload: Buffer.from(params.payload, "utf8"),
    signatureBase64Url: params.signatureBase64Url,
  });
}

export function verifyEd25519SignatureBytes(params: {
  publicKey: string;
  payload: Buffer;
  signatureBase64Url: string;
}): boolean {
  try {
    const key = createEd25519PublicKey(params.publicKey);
    const sig = base64UrlDecode(params.signatureBase64Url);
    return crypto.verify(null, params.payload, key, sig);
  } catch {
    return false;
  }
}
