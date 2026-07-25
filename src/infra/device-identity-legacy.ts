// Canonicalizes retired Node and Swift identity payloads for Doctor import.
import { createHash } from "node:crypto";
import {
  validateStoredDeviceIdentity,
  type StoredDeviceIdentity,
} from "./device-identity-store.js";
import {
  decodeCanonicalBase64OrBase64Url,
  deriveEd25519PrivateKeyRaw,
  deriveEd25519PublicKeyRaw,
  ed25519PrivateKeyPemFromRaw,
  ed25519PublicKeyPemFromRaw,
} from "./ed25519-signature.js";

export type NormalizedLegacyDeviceIdentity = StoredDeviceIdentity;

function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash("sha256").update(deriveEd25519PublicKeyRaw(publicKeyPem)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidCreatedAtMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeLegacyCreatedAtMs(value: unknown): number {
  // Shipped file readers accepted valid keypairs even when this metadata was
  // missing or invalid. Doctor preserves that upgrade path without weakening SQLite.
  return isValidCreatedAtMs(value) ? value : Date.now();
}

function normalizeLegacyKeyPair(params: {
  createdAtMs: number;
  privateKeyPem: string;
  publicKeyPem: string;
}): NormalizedLegacyDeviceIdentity | null {
  try {
    const publicKeyRaw = deriveEd25519PublicKeyRaw(params.publicKeyPem);
    const privateKeyRaw = deriveEd25519PrivateKeyRaw(params.privateKeyPem);
    const publicKeyPem = ed25519PublicKeyPemFromRaw(publicKeyRaw);
    const privateKeyPem = ed25519PrivateKeyPemFromRaw(privateKeyRaw);
    // Legacy deviceId was derived metadata. Preserve the authoritative key bytes and
    // recompute the fingerprint so stale metadata never rotates a shipped identity.
    const normalized = {
      deviceId: fingerprintPublicKey(publicKeyPem),
      publicKeyPem,
      privateKeyPem,
      createdAtMs: params.createdAtMs,
    };
    validateStoredDeviceIdentity(normalized);
    return normalized;
  } catch {
    return null;
  }
}

/** Normalize a retired Node PEM or Swift raw-key payload for Doctor import. */
export function normalizeLegacyDeviceIdentity(
  value: unknown,
): NormalizedLegacyDeviceIdentity | null {
  if (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.deviceId === "string" &&
    typeof value.publicKeyPem === "string" &&
    typeof value.privateKeyPem === "string"
  ) {
    return normalizeLegacyKeyPair({
      createdAtMs: normalizeLegacyCreatedAtMs(value.createdAtMs),
      privateKeyPem: value.privateKeyPem,
      publicKeyPem: value.publicKeyPem,
    });
  }
  if (
    isRecord(value) &&
    !("version" in value) &&
    typeof value.deviceId === "string" &&
    typeof value.publicKey === "string" &&
    typeof value.privateKey === "string"
  ) {
    try {
      const publicKeyRaw = decodeCanonicalBase64OrBase64Url(value.publicKey);
      const privateKeyRaw = decodeCanonicalBase64OrBase64Url(value.privateKey);
      return normalizeLegacyKeyPair({
        createdAtMs: normalizeLegacyCreatedAtMs(value.createdAtMs),
        privateKeyPem: ed25519PrivateKeyPemFromRaw(privateKeyRaw),
        publicKeyPem: ed25519PublicKeyPemFromRaw(publicKeyRaw),
      });
    } catch {
      return null;
    }
  }
  return null;
}
