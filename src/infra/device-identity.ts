// Gateway/device Ed25519 identity API backed by canonical shared SQLite state.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { acquireDeviceIdentityCoordinator } from "./device-identity-coordinator.js";
import {
  generateStoredDeviceIdentity,
  insertStoredDeviceIdentityIfAbsent,
  PRIMARY_DEVICE_IDENTITY_KEY,
  readStoredDeviceIdentity,
  readStoredDeviceIdentityReadOnly,
  resolveDeviceIdentityStore,
  type DeviceIdentity,
  type DeviceIdentityStoreOptions,
  type StoredDeviceIdentity,
} from "./device-identity-store.js";
import {
  normalizeEd25519PublicKeyBase64Url,
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
  verifyEd25519Signature,
} from "./ed25519-signature.js";

export type { DeviceIdentity } from "./device-identity-store.js";

const LEGACY_DEVICE_IDENTITY_RELATIVE_PATH = path.join("identity", "device.json");
const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const NATIVE_CLAIM_SUFFIX = ".native-importing";

class DeviceIdentityMigrationRequiredError extends Error {
  constructor(filePath: string) {
    super(
      `Legacy device identity exists at ${filePath}. Run "openclaw doctor --fix" before starting the gateway or connecting this client.`,
    );
    this.name = "DeviceIdentityMigrationRequiredError";
  }
}

function toDeviceIdentity(stored: StoredDeviceIdentity): DeviceIdentity {
  return {
    deviceId: stored.deviceId,
    publicKeyPem: stored.publicKeyPem,
    privateKeyPem: stored.privateKeyPem,
  };
}

function pathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function resolveLegacyStateDir(options: DeviceIdentityStoreOptions): string {
  if (options.env?.OPENCLAW_STATE_DIR?.trim()) {
    return resolveStateDir(options.env);
  }
  if (options.path) {
    const databaseDir = path.dirname(path.resolve(options.path));
    return path.basename(databaseDir) === "state" ? path.dirname(databaseDir) : databaseDir;
  }
  return resolveStateDir(options.env ?? process.env);
}

/** Exact retired file owned by Doctor migration code. */
function resolveLegacyDeviceIdentityPath(options: DeviceIdentityStoreOptions = {}): string {
  return path.join(resolveLegacyStateDir(options), LEGACY_DEVICE_IDENTITY_RELATIVE_PATH);
}

function assertNoPendingLegacyIdentity(options: DeviceIdentityStoreOptions): void {
  const { identityKey } = resolveDeviceIdentityStore(options);
  if (identityKey !== PRIMARY_DEVICE_IDENTITY_KEY) {
    return;
  }
  const legacyPath = resolveLegacyDeviceIdentityPath(options);
  if (
    // Claims first, source last: both migration owners restore claim -> source atomically.
    pathMayExist(`${legacyPath}${DOCTOR_CLAIM_SUFFIX}`) ||
    pathMayExist(`${legacyPath}${NATIVE_CLAIM_SUFFIX}`) ||
    pathMayExist(legacyPath)
  ) {
    throw new DeviceIdentityMigrationRequiredError(legacyPath);
  }
}

function withDeviceIdentityCoordinator<T>(
  options: DeviceIdentityStoreOptions,
  operation: (
    resolved: ReturnType<typeof resolveDeviceIdentityStore>,
    resolvedOptions: DeviceIdentityStoreOptions,
  ) => T,
): T {
  const resolved = resolveDeviceIdentityStore(options);
  const resolvedOptions: DeviceIdentityStoreOptions = {
    ...options,
    path: resolved.databasePath,
    identityKey: resolved.identityKey,
  };
  const coordinator = acquireDeviceIdentityCoordinator({ databasePath: resolved.databasePath });
  let result: T;
  try {
    result = operation(resolved, resolvedOptions);
  } catch (operationError) {
    try {
      coordinator.release();
    } catch (releaseError) {
      const aggregateError = new AggregateError(
        [operationError, releaseError],
        "device identity operation and coordinator release both failed",
        { cause: releaseError },
      );
      throw aggregateError;
    }
    throw operationError;
  }
  coordinator.release();
  return result;
}

function loadOrCreateDeviceIdentityOwned(options: DeviceIdentityStoreOptions): DeviceIdentity {
  assertNoPendingLegacyIdentity(options);
  const existing = readStoredDeviceIdentity(options);
  if (existing) {
    return toDeviceIdentity(existing);
  }

  // Generate outside the write transaction. The transaction rereads the row
  // before inserting so concurrent runtimes converge on one authoritative key.
  const candidate = generateStoredDeviceIdentity();
  return toDeviceIdentity(insertStoredDeviceIdentityIfAbsent(candidate, options));
}

/** Load a valid canonical identity or atomically create its SQLite row. */
export function loadOrCreateDeviceIdentity(
  options: DeviceIdentityStoreOptions = {},
): DeviceIdentity {
  return withDeviceIdentityCoordinator(options, (_resolved, resolvedOptions) =>
    loadOrCreateDeviceIdentityOwned(resolvedOptions),
  );
}

const processDeviceIdentities = new Map<string, DeviceIdentity>();
const MAX_PROCESS_DEVICE_IDENTITIES = 32;

/** Keep one authoritative identity stable for the lifetime of a state-dir process. */
export function loadOrCreateProcessDeviceIdentity(
  options: DeviceIdentityStoreOptions = {},
): DeviceIdentity {
  return withDeviceIdentityCoordinator(options, (resolved, resolvedOptions) => {
    assertNoPendingLegacyIdentity(resolvedOptions);
    const cacheKey = `${resolved.databasePath}\0${resolved.identityKey}`;
    const cached = processDeviceIdentities.get(cacheKey);
    if (cached) {
      return cached;
    }
    const identity = loadOrCreateDeviceIdentityOwned(resolvedOptions);
    if (processDeviceIdentities.size >= MAX_PROCESS_DEVICE_IDENTITIES) {
      const oldestKey = processDeviceIdentities.keys().next().value;
      if (oldestKey !== undefined) {
        processDeviceIdentities.delete(oldestKey);
      }
    }
    processDeviceIdentities.set(cacheKey, identity);
    return identity;
  });
}

/** Load a valid persisted identity without creating or mutating SQLite state. */
export function loadDeviceIdentityIfPresent(
  options: DeviceIdentityStoreOptions = {},
): DeviceIdentity | null {
  return withDeviceIdentityCoordinator(options, (_resolved, resolvedOptions) => {
    assertNoPendingLegacyIdentity(resolvedOptions);
    const stored = readStoredDeviceIdentityReadOnly(resolvedOptions);
    return stored ? toDeviceIdentity(stored) : null;
  });
}

/** Sign a UTF-8 payload with a PEM Ed25519 private key and return base64url bytes. */
export function signDevicePayload(privateKeyPem: string, payload: string): string {
  return signEd25519Payload(privateKeyPem, payload);
}

/** Normalize PEM or raw base64/base64url public keys to canonical raw base64url bytes. */
export function normalizeDevicePublicKeyBase64Url(publicKey: string): string | null {
  return normalizeEd25519PublicKeyBase64Url(publicKey);
}

/** Derive the stable device id from PEM or raw base64/base64url public key material. */
export function deriveDeviceIdFromPublicKey(publicKey: string): string | null {
  try {
    const normalized = normalizeEd25519PublicKeyBase64Url(publicKey);
    if (!normalized) {
      return null;
    }
    const raw = Buffer.from(normalized, "base64url");
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

/** Export a PEM Ed25519 public key as canonical raw base64url bytes. */
export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return publicKeyRawBase64UrlFromEd25519Pem(publicKeyPem);
}

/** Verify a UTF-8 payload signature against PEM or raw base64/base64url public key material. */
export function verifyDeviceSignature(
  publicKey: string,
  payload: string,
  signatureBase64Url: string,
): boolean {
  return verifyEd25519Signature({ publicKey, payload, signatureBase64Url });
}
