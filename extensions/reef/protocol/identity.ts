import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBytes } from "./canonical.js";
import { base64url, fromBase64url, hex } from "./encoding.js";

export interface SigningKeyPair {
  publicKey: string;
  secretKey: string;
}

export interface EncryptionKeyPair {
  publicKey: string;
  secretKey: string;
}

export interface IdentityKeyPair {
  signing: SigningKeyPair;
  encryption: EncryptionKeyPair;
}

export interface RotationStatement {
  newEd25519Pub: string;
  newX25519Pub: string;
  newEpoch: number;
}

export interface SignedRotation extends RotationStatement {
  signature: string;
}

export function generateIdentity(): IdentityKeyPair {
  const signing = ed25519.keygen();
  const encryption = x25519.keygen();
  return {
    signing: { publicKey: base64url(signing.publicKey), secretKey: base64url(signing.secretKey) },
    encryption: {
      publicKey: base64url(encryption.publicKey),
      secretKey: base64url(encryption.secretKey),
    },
  };
}

export interface DeviceRequestSignatureInput {
  method: string;
  path: string;
  ts: number;
  bodySha256: string;
}

export function signDeviceRequest(
  input: DeviceRequestSignatureInput,
  signingSecretKey: string,
): string {
  if (
    !/^[A-Z]+$/.test(input.method) ||
    !input.path.startsWith("/") ||
    !Number.isSafeInteger(input.ts) ||
    input.ts < 0 ||
    !/^[0-9a-f]{64}$/.test(input.bodySha256)
  ) {
    throw new Error("invalid device request signature input");
  }
  return base64url(ed25519.sign(canonicalBytes(input), fromBase64url(signingSecretKey)));
}

export function fingerprint(ed25519PublicKey: string, x25519PublicKey?: string): string {
  const material = x25519PublicKey
    ? canonicalBytes({ ed25519: ed25519PublicKey, x25519: x25519PublicKey })
    : fromBase64url(ed25519PublicKey);
  return hex(sha256(material))
    .match(/.{1,4}/g)!
    .join(" ");
}

export function formatHandleEpoch(handle: string, keyEpoch: number): string {
  if (
    !/^[a-z0-9](?:[a-z0-9_-]{0,62})$/i.test(handle) ||
    !Number.isSafeInteger(keyEpoch) ||
    keyEpoch < 1
  ) {
    throw new Error("invalid handle or key epoch");
  }
  return `${handle}#${keyEpoch}`;
}

export function parseHandleEpoch(value: string): { handle: string; keyEpoch: number } {
  const match = /^([a-z0-9](?:[a-z0-9_-]{0,62}))#([1-9][0-9]*)$/i.exec(value);
  if (!match) {
    throw new Error("invalid handle#key_epoch");
  }
  const keyEpoch = Number(match[2]);
  if (!Number.isSafeInteger(keyEpoch)) {
    throw new Error("invalid key epoch");
  }
  return { handle: match[1]!, keyEpoch };
}

export function signRotation(statement: RotationStatement, oldSecretKey: string): SignedRotation {
  validateRotation(statement);
  return {
    ...statement,
    signature: base64url(ed25519.sign(rotationBytes(statement), fromBase64url(oldSecretKey))),
  };
}

export function verifyRotation(rotation: SignedRotation, oldPublicKey: string): boolean {
  const { signature, ...statement } = rotation;
  try {
    validateRotation(statement);
    return ed25519.verify(
      fromBase64url(signature),
      rotationBytes(statement),
      fromBase64url(oldPublicKey),
    );
  } catch {
    return false;
  }
}

function rotationBytes(statement: RotationStatement): Uint8Array {
  return canonicalBytes({ ...statement, domain: "reef-rotation-v1" });
}

function validateRotation(statement: RotationStatement): void {
  if (
    statement === null ||
    typeof statement !== "object" ||
    Array.isArray(statement) ||
    Object.keys(statement).length !== 3 ||
    !["newEd25519Pub", "newX25519Pub", "newEpoch"].every((key) => Object.hasOwn(statement, key))
  ) {
    throw new Error("invalid rotation statement");
  }
  if (!Number.isSafeInteger(statement.newEpoch) || statement.newEpoch < 1) {
    throw new Error("invalid new epoch");
  }
  if (
    fromBase64url(statement.newEd25519Pub).length !== 32 ||
    fromBase64url(statement.newX25519Pub).length !== 32
  ) {
    throw new Error("invalid rotation public key");
  }
}
