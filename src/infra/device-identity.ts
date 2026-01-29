import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const DEFAULT_DIR = path.join(os.homedir(), ".moltbot", "identity");
const DEFAULT_FILE = path.join(DEFAULT_DIR, "device.json");

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
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

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

export function loadOrCreateDeviceIdentity(filePath: string = DEFAULT_FILE): DeviceIdentity {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as StoredIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
        if (derivedId && derivedId !== parsed.deviceId) {
          const updated: StoredIdentity = {
            ...parsed,
            deviceId: derivedId,
          };
          fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
          try {
            fs.chmodSync(filePath, 0o600);
          } catch {
            // best-effort
          }
          return {
            deviceId: derivedId,
            publicKeyPem: parsed.publicKeyPem,
            privateKeyPem: parsed.privateKeyPem,
          };
        }
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch {
    // fall through to regenerate
  }

  const identity = generateIdentity();
  ensureDir(filePath);
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
  return identity;
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
