import crypto from "node:crypto";

const ED25519_RAW_KEY_LENGTH = 32;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

// Ed25519 public keys and signatures are fixed-size (<= ~86 base64url chars),
// so a caller passing far larger input is almost certainly malformed or abusive.
// Bound the decoded buffer to keep a single request from allocating arbitrary memory.
const MAX_BASE64URL_DECODE_INPUT_LENGTH = 4096;

function assertBoundedBase64Input(input: string): void {
  if (input.length > MAX_BASE64URL_DECODE_INPUT_LENGTH) {
    throw new Error("base64url input exceeds the maximum allowed length");
  }
  if (input.length === 0) {
    throw new Error("base64 input must not be empty");
  }
}

/** Decode the existing permissive base64url wire shape. */
export function base64UrlDecode(input: string): Buffer {
  if (input.length > MAX_BASE64URL_DECODE_INPUT_LENGTH) {
    throw new Error("base64url input exceeds the maximum allowed length");
  }
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/** Decode a canonical standard-base64 or unpadded-base64url value. */
export function decodeCanonicalBase64OrBase64Url(input: string): Buffer {
  assertBoundedBase64Input(input);
  if (/^[A-Za-z0-9_-]+$/.test(input)) {
    const decoded = Buffer.from(input, "base64url");
    if (base64UrlEncode(decoded) !== input) {
      throw new Error("invalid canonical base64url input");
    }
    return decoded;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input) || input.length % 4 !== 0) {
    throw new Error("invalid canonical base64 input");
  }
  const decoded = Buffer.from(input, "base64");
  if (decoded.toString("base64") !== input) {
    throw new Error("invalid canonical base64 input");
  }
  return decoded;
}

function pemEncode(label: "PUBLIC KEY" | "PRIVATE KEY", der: Buffer): string {
  const body =
    der
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function decodeCanonicalPem(label: "PUBLIC KEY" | "PRIVATE KEY", pem: string): Buffer {
  const header = `-----BEGIN ${label}-----\n`;
  const footer = `\n-----END ${label}-----\n`;
  if (!pem.startsWith(header) || !pem.endsWith(footer)) {
    throw new Error(`${label} must use canonical PEM framing`);
  }
  const body = pem.slice(header.length, -footer.length);
  if (!body || !/^[A-Za-z0-9+/=\n]+$/.test(body)) {
    throw new Error(`${label} contains invalid PEM body bytes`);
  }
  const der = Buffer.from(body.replaceAll("\n", ""), "base64");
  if (pemEncode(label, der) !== pem) {
    throw new Error(`${label} must use canonical PEM base64 encoding`);
  }
  return der;
}

function assertRawKeyLength(raw: Buffer, label: string): void {
  if (raw.length !== ED25519_RAW_KEY_LENGTH) {
    throw new Error(`${label} must contain exactly ${ED25519_RAW_KEY_LENGTH} bytes`);
  }
}

export function ed25519PublicKeyPemFromRaw(publicKeyRaw: Buffer): string {
  assertRawKeyLength(publicKeyRaw, "Ed25519 public key");
  return pemEncode("PUBLIC KEY", Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]));
}

export function ed25519PrivateKeyPemFromRaw(privateKeyRaw: Buffer): string {
  assertRawKeyLength(privateKeyRaw, "Ed25519 private key");
  return pemEncode("PRIVATE KEY", Buffer.concat([ED25519_PKCS8_PRIVATE_PREFIX, privateKeyRaw]));
}

function assertEd25519KeyType(key: crypto.KeyObject, label: string): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} must be an Ed25519 key`);
  }
}

function deriveRawKeyFromDer(params: { der: Buffer; label: string; prefix: Buffer }): Buffer {
  const expectedLength = params.prefix.length + ED25519_RAW_KEY_LENGTH;
  if (
    params.der.length !== expectedLength ||
    !params.der.subarray(0, params.prefix.length).equals(params.prefix)
  ) {
    throw new Error(`${params.label} has a noncanonical Ed25519 encoding`);
  }
  return params.der.subarray(params.prefix.length);
}

export function deriveCanonicalEd25519PublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = decodeCanonicalPem("PUBLIC KEY", publicKeyPem);
  const key = crypto.createPublicKey({ key: spki, type: "spki", format: "der" });
  assertEd25519KeyType(key, "public key");
  return deriveRawKeyFromDer({ der: spki, label: "public key", prefix: ED25519_SPKI_PREFIX });
}

export function deriveCanonicalEd25519PrivateKeyRaw(privateKeyPem: string): Buffer {
  const pkcs8 = decodeCanonicalPem("PRIVATE KEY", privateKeyPem);
  const key = crypto.createPrivateKey({ key: pkcs8, type: "pkcs8", format: "der" });
  assertEd25519KeyType(key, "private key");
  return deriveRawKeyFromDer({
    der: pkcs8,
    label: "private key",
    prefix: ED25519_PKCS8_PRIVATE_PREFIX,
  });
}

/** Parse any Node-compatible Ed25519 PEM and return its canonical raw public key. */
export function deriveEd25519PublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  assertEd25519KeyType(key, "public key");
  const spki = key.export({ type: "spki", format: "der" });
  return deriveRawKeyFromDer({ der: spki, label: "public key", prefix: ED25519_SPKI_PREFIX });
}

/** Parse any Node-compatible Ed25519 PEM and return its canonical raw private key. */
export function deriveEd25519PrivateKeyRaw(privateKeyPem: string): Buffer {
  const key = crypto.createPrivateKey(privateKeyPem);
  assertEd25519KeyType(key, "private key");
  const pkcs8 = key.export({ type: "pkcs8", format: "der" });
  return deriveRawKeyFromDer({
    der: pkcs8,
    label: "private key",
    prefix: ED25519_PKCS8_PRIVATE_PREFIX,
  });
}

export function publicKeyRawBase64UrlFromEd25519Pem(publicKeyPem: string): string {
  return base64UrlEncode(deriveEd25519PublicKeyRaw(publicKeyPem));
}

export function normalizeEd25519PublicKeyBase64Url(publicKey: string): string | null {
  try {
    const raw = publicKey.includes("BEGIN")
      ? deriveEd25519PublicKeyRaw(publicKey)
      : base64UrlDecode(publicKey);
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
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(signature);
}

function createEd25519PublicKey(publicKey: string): crypto.KeyObject {
  if (publicKey.includes("BEGIN")) {
    return crypto.createPublicKey(publicKey);
  }
  return crypto.createPublicKey({
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
    const signature = base64UrlDecode(params.signatureBase64Url);
    return crypto.verify(null, params.payload, key, signature);
  } catch {
    return false;
  }
}
