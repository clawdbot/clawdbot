import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { privateFileStoreSync } from "./private-file-store.js";

export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type StoredIdentity = {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
};

type StoredSwiftIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
};

function resolveDefaultIdentityPath(): string {
  return path.join(resolveStateDir(), "identity", "device.json");
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
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

function publicKeyPemFromRaw(publicKeyRaw: Buffer): string {
  return pemEncode("PUBLIC KEY", Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]));
}

function privateKeyPemFromRaw(privateKeyRaw: Buffer): string {
  return pemEncode("PRIVATE KEY", Buffer.concat([ED25519_PKCS8_PRIVATE_PREFIX, privateKeyRaw]));
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
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

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function tryFingerprintPublicKey(publicKeyPem: string): string | null {
  try {
    return fingerprintPublicKey(publicKeyPem);
  } catch {
    return null;
  }
}

function keyPairMatches(publicKeyPem: string, privateKeyPem: string): boolean {
  try {
    const payload = Buffer.from("openclaw-device-identity-self-check", "utf8");
    const signature = crypto.sign(null, payload, crypto.createPrivateKey(privateKeyPem));
    return crypto.verify(null, payload, crypto.createPublicKey(publicKeyPem), signature);
  } catch {
    return false;
  }
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

type NormalizedStoredIdentity =
  | {
      kind: "identity";
      identity: DeviceIdentity;
      stored?: StoredIdentity;
      validForReadOnly: boolean;
    }
  | { kind: "recognized-invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function hasRecognizedIdentityShape(parsed: unknown): boolean {
  return (
    isRecord(parsed) &&
    ("publicKeyPem" in parsed ||
      "privateKeyPem" in parsed ||
      "publicKey" in parsed ||
      "privateKey" in parsed)
  );
}

function normalizeStoredIdentity(parsed: unknown): NormalizedStoredIdentity | null {
  if (
    isRecord(parsed) &&
    "version" in parsed &&
    parsed.version === 1 &&
    "deviceId" in parsed &&
    typeof parsed.deviceId === "string" &&
    "publicKeyPem" in parsed &&
    typeof parsed.publicKeyPem === "string" &&
    "privateKeyPem" in parsed &&
    typeof parsed.privateKeyPem === "string"
  ) {
    const stored = parsed as StoredIdentity;
    const derivedId = tryFingerprintPublicKey(stored.publicKeyPem);
    if (!derivedId || !keyPairMatches(stored.publicKeyPem, stored.privateKeyPem)) {
      return { kind: "recognized-invalid" };
    }
    const identity = {
      deviceId: derivedId,
      publicKeyPem: stored.publicKeyPem,
      privateKeyPem: stored.privateKeyPem,
    };
    return derivedId === stored.deviceId
      ? { kind: "identity", identity, validForReadOnly: true }
      : {
          kind: "identity",
          identity,
          validForReadOnly: false,
          stored: {
            ...stored,
            deviceId: derivedId,
          },
        };
  }

  if (
    isRecord(parsed) &&
    !("version" in parsed) &&
    "deviceId" in parsed &&
    typeof parsed.deviceId === "string" &&
    "publicKey" in parsed &&
    typeof parsed.publicKey === "string" &&
    "privateKey" in parsed &&
    typeof parsed.privateKey === "string"
  ) {
    const stored = parsed as StoredSwiftIdentity;
    const publicKeyRaw = base64UrlDecode(stored.publicKey);
    const privateKeyRaw = base64UrlDecode(stored.privateKey);
    if (publicKeyRaw.length !== 32 || privateKeyRaw.length !== 32) {
      return { kind: "recognized-invalid" };
    }
    const publicKeyPem = publicKeyPemFromRaw(publicKeyRaw);
    const privateKeyPem = privateKeyPemFromRaw(privateKeyRaw);
    if (!keyPairMatches(publicKeyPem, privateKeyPem)) {
      return { kind: "recognized-invalid" };
    }
    const derivedId = fingerprintPublicKey(publicKeyPem);
    const validForReadOnly = derivedId === stored.deviceId;
    const migrated: StoredIdentity = {
      version: 1,
      deviceId: derivedId,
      publicKeyPem,
      privateKeyPem,
      createdAtMs:
        typeof stored.createdAtMs === "number" && Number.isFinite(stored.createdAtMs)
          ? stored.createdAtMs
          : Date.now(),
    };
    return {
      kind: "identity",
      identity: {
        deviceId: derivedId,
        publicKeyPem,
        privateKeyPem,
      },
      validForReadOnly,
      stored: migrated,
    };
  }

  return hasRecognizedIdentityShape(parsed) ? { kind: "recognized-invalid" } : null;
}

function identityFileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function loadOrCreateDeviceIdentity(
  filePath: string = resolveDefaultIdentityPath(),
): DeviceIdentity {
  try {
    const store = privateFileStoreSync(path.dirname(filePath));
    const parsed = store.readJsonIfExists(path.basename(filePath));
    const normalized = normalizeStoredIdentity(parsed);
    if (normalized?.kind === "identity") {
      if (normalized.stored) {
        try {
          store.writeJson(path.basename(filePath), normalized.stored, {
            trailingNewline: true,
          });
        } catch {
          // Keep using recognized OpenClaw key material even if best-effort normalization fails.
        }
      }
      return normalized.identity;
    }
    if (normalized?.kind === "recognized-invalid") {
      return generateIdentity();
    }
  } catch {
    if (identityFileExists(filePath)) {
      return generateIdentity();
    }
  }

  const identity = generateIdentity();
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  privateFileStoreSync(path.dirname(filePath)).writeJson(path.basename(filePath), stored, {
    trailingNewline: true,
  });
  return identity;
}

export function loadDeviceIdentityIfPresent(
  filePath: string = resolveDefaultIdentityPath(),
): DeviceIdentity | null {
  try {
    const parsed = privateFileStoreSync(path.dirname(filePath)).readJsonIfExists(
      path.basename(filePath),
    );
    const normalized = normalizeStoredIdentity(parsed);
    if (normalized?.kind !== "identity" || !normalized.validForReadOnly) {
      return null;
    }
    return normalized.identity;
  } catch {
    return null;
  }
}

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

export function normalizeDevicePublicKeyBase64Url(publicKey: string): string | null {
  try {
    if (publicKey.includes("BEGIN")) {
      return base64UrlEncode(derivePublicKeyRaw(publicKey));
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

export function deriveDeviceIdFromPublicKey(publicKey: string): string | null {
  try {
    const raw = publicKey.includes("BEGIN")
      ? derivePublicKeyRaw(publicKey)
      : base64UrlDecode(publicKey);
    if (raw.length === 0) {
      return null;
    }
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function verifyDeviceSignature(
  publicKey: string,
  payload: string,
  signatureBase64Url: string,
): boolean {
  try {
    const key = publicKey.includes("BEGIN")
      ? crypto.createPublicKey(publicKey)
      : crypto.createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, base64UrlDecode(publicKey)]),
          type: "spki",
          format: "der",
        });
    const sig = (() => {
      try {
        return base64UrlDecode(signatureBase64Url);
      } catch {
        return Buffer.from(signatureBase64Url, "base64");
      }
    })();
    return crypto.verify(null, Buffer.from(payload, "utf8"), key, sig);
  } catch {
    return false;
  }
}
