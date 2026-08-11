import { hasNonEmptyString as isNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import {
  cloudSessionRecoveryExactStorageKey,
  cloudSessionRecoveryLegacyStorageKey,
  cloudSessionRecoveryScopeStoragePrefix,
} from "./cloud-recovery-storage-key.ts";
import type { SessionCreateParams } from "./create.ts";

export type CloudSessionCreateParams = SessionCreateParams & {
  key?: string;
  agentId: string;
  message: "";
  worktree: true;
};

export type CloudSessionRecovery = {
  sessionKey: string;
  messageId: string;
  message: string;
  attachments?: unknown[];
  profileId: string;
  agentId: string;
  gatewayUrl: string;
  recoveryScope: string;
  phase: "creating" | "dispatching" | "sending";
  createParams?: CloudSessionCreateParams;
};

// Keep the create -> dispatch -> first-send handoff recoverable across reloads,
// while scoping it to this tab, Gateway, and authenticated credential.
const CLOUD_CREATE_STRING_FIELDS = [
  "model",
  "thinkingLevel",
  "worktreeBaseRef",
  "worktreeName",
  "cwd",
  "execNode",
  "catalogId",
] as const;

export function parseCloudSessionCreateParams(
  value: unknown,
  sessionKey: string,
  agentId: string,
): CloudSessionCreateParams | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>([
    "key",
    "agentId",
    "message",
    "worktree",
    "incognito",
    ...CLOUD_CREATE_STRING_FIELDS,
  ]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    record.key !== sessionKey ||
    record.agentId !== agentId ||
    record.message !== "" ||
    record.worktree !== true ||
    (record.incognito !== undefined && record.incognito !== true) ||
    CLOUD_CREATE_STRING_FIELDS.some(
      (key) => record[key] !== undefined && !isNonEmptyString(record[key]),
    )
  ) {
    return null;
  }
  return record as CloudSessionCreateParams;
}

function parseStoredCloudSessionRecovery(raw: string): Partial<CloudSessionRecovery> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<CloudSessionRecovery>)
      : null;
  } catch {
    return null;
  }
}

function cloudSessionRecoveryClaimsScope(
  value: Partial<CloudSessionRecovery>,
  gatewayUrl: string,
  recoveryScope: string,
): boolean {
  return value.gatewayUrl === gatewayUrl && value.recoveryScope === recoveryScope;
}

function validateCloudSessionRecovery(
  value: Partial<CloudSessionRecovery>,
  gatewayUrl: string,
  recoveryScope: string,
  expectedSessionKey?: string,
): CloudSessionRecovery | null {
  if (
    value.createParams?.incognito === true ||
    !isNonEmptyString(value.sessionKey) ||
    (expectedSessionKey !== undefined && value.sessionKey !== expectedSessionKey) ||
    !isNonEmptyString(value.messageId) ||
    typeof value.message !== "string" ||
    (!isNonEmptyString(value.message) && !value.attachments?.length) ||
    (value.attachments !== undefined && !Array.isArray(value.attachments)) ||
    !isNonEmptyString(value.profileId) ||
    !isNonEmptyString(value.agentId) ||
    !cloudSessionRecoveryClaimsScope(value, gatewayUrl, recoveryScope) ||
    (value.phase !== "creating" && value.phase !== "dispatching" && value.phase !== "sending") ||
    (value.phase === "creating" &&
      !parseCloudSessionCreateParams(value.createParams, value.sessionKey, value.agentId))
  ) {
    return null;
  }
  return value as CloudSessionRecovery;
}

function removeCloudSessionRecoveryRow(storage: Storage, key: string): boolean {
  try {
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    // Recovery state is best-effort to remove after completion or validation failure.
    return false;
  }
}

function readOwnedCloudSessionRecovery(
  storage: Storage,
  key: string,
  gatewayUrl: string,
  recoveryScope: string,
  expectedSessionKey?: string,
): CloudSessionRecovery | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) {
      return null;
    }
    const value = parseStoredCloudSessionRecovery(raw);
    const recovery = value
      ? validateCloudSessionRecovery(value, gatewayUrl, recoveryScope, expectedSessionKey)
      : null;
    if (
      !recovery ||
      key !== cloudSessionRecoveryExactStorageKey(gatewayUrl, recoveryScope, recovery.sessionKey)
    ) {
      // Every row below a framed v2 scope prefix belongs to that exact scope.
      // A bad row can therefore be removed without touching another namespace.
      removeCloudSessionRecoveryRow(storage, key);
      return null;
    }
    return recovery;
  } catch {
    return null;
  }
}

type LegacyCloudSessionRecovery = {
  raw: string;
  recovery: CloudSessionRecovery;
};

function readLegacyCloudSessionRecovery(
  storage: Storage,
  key: string,
  gatewayUrl: string,
  recoveryScope: string,
): LegacyCloudSessionRecovery | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return null;
    }
    const value = parseStoredCloudSessionRecovery(raw);
    if (!value || !cloudSessionRecoveryClaimsScope(value, gatewayUrl, recoveryScope)) {
      // The shipped v1 key is unframed and can equal another tuple's key.
      // Only the payload can prove that this scope owns the legacy row.
      return null;
    }
    const recovery = validateCloudSessionRecovery(value, gatewayUrl, recoveryScope);
    if (!recovery) {
      removeCloudSessionRecoveryRow(storage, key);
      return null;
    }
    return { raw, recovery };
  } catch {
    return null;
  }
}

function relocateCloudSessionRecoveryRow(
  storage: Storage,
  sourceKey: string,
  sourceRaw: string,
  recovery: CloudSessionRecovery,
): CloudSessionRecovery | null {
  const key = cloudSessionRecoveryExactStorageKey(
    recovery.gatewayUrl,
    recovery.recoveryScope,
    recovery.sessionKey,
  );
  const serialized = JSON.stringify(recovery);
  try {
    // Relocate instead of copying so a full store needs no duplicate capacity.
    storage.removeItem(sourceKey);
    if (storage.getItem(sourceKey) !== null) {
      return null;
    }
    storage.setItem(key, serialized);
    const relocated = readOwnedCloudSessionRecovery(
      storage,
      key,
      recovery.gatewayUrl,
      recovery.recoveryScope,
      recovery.sessionKey,
    );
    if (relocated) {
      return relocated;
    }
  } catch {
    // The original bytes are restored below so a later attempt can retry.
  }
  removeCloudSessionRecoveryRow(storage, key);
  try {
    storage.setItem(sourceKey, sourceRaw);
  } catch {
    // Fail closed if even the original bytes no longer fit.
  }
  return null;
}

function relocateLegacyCloudSessionRecovery(
  storage: Storage,
  legacyKey: string,
  legacy: LegacyCloudSessionRecovery,
): CloudSessionRecovery | null {
  const recovery = legacy.recovery;
  const key = cloudSessionRecoveryExactStorageKey(
    recovery.gatewayUrl,
    recovery.recoveryScope,
    recovery.sessionKey,
  );
  const existing = readOwnedCloudSessionRecovery(
    storage,
    key,
    recovery.gatewayUrl,
    recovery.recoveryScope,
    recovery.sessionKey,
  );
  if (existing) {
    removeCloudSessionRecoveryRow(storage, legacyKey);
    return existing;
  }
  return relocateCloudSessionRecoveryRow(storage, legacyKey, legacy.raw, recovery);
}

export function listCloudSessionRecoveries(
  gatewayUrl: string,
  recoveryScope: string,
): CloudSessionRecovery[] {
  if (!gatewayUrl || !recoveryScope) {
    return [];
  }
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) {
      return [];
    }
    const scopePrefix = cloudSessionRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope);
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(scopePrefix)) {
        keys.push(key);
      }
    }
    const sortedKeys = keys.toSorted();

    const recoveries = new Map<string, CloudSessionRecovery>();
    for (const key of sortedKeys) {
      const recovery = readOwnedCloudSessionRecovery(storage, key, gatewayUrl, recoveryScope);
      if (!recovery) {
        continue;
      }
      recoveries.set(recovery.sessionKey, recovery);
    }

    const legacyKey = cloudSessionRecoveryLegacyStorageKey(gatewayUrl, recoveryScope);
    const legacy = readLegacyCloudSessionRecovery(storage, legacyKey, gatewayUrl, recoveryScope);
    if (legacy) {
      const migrated = relocateLegacyCloudSessionRecovery(storage, legacyKey, legacy);
      if (migrated) {
        recoveries.set(migrated.sessionKey, migrated);
      }
    }
    return [...recoveries.values()].toSorted((left, right) =>
      left.sessionKey.localeCompare(right.sessionKey),
    );
  } catch {
    return [];
  }
}

export function migrateCloudSessionRecoveryScope(
  gatewayUrl: string,
  sourceScope: string,
  destinationScope: string,
): void {
  for (const recovery of listCloudSessionRecoveries(gatewayUrl, sourceScope)) {
    const destination = { ...recovery, recoveryScope: destinationScope };
    if (writeCloudSessionRecoveryIfAvailable(destination)) {
      clearCloudSessionRecovery(gatewayUrl, sourceScope, recovery.sessionKey);
    }
  }
}

export function readCloudSessionRecovery(
  gatewayUrl: string,
  recoveryScope: string,
  sessionKey: string,
): CloudSessionRecovery | null {
  if (!gatewayUrl || !recoveryScope || !sessionKey) {
    return null;
  }
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) {
      return null;
    }
    const key = cloudSessionRecoveryExactStorageKey(gatewayUrl, recoveryScope, sessionKey);
    const recovery = readOwnedCloudSessionRecovery(
      storage,
      key,
      gatewayUrl,
      recoveryScope,
      sessionKey,
    );
    if (recovery) {
      const legacyKey = cloudSessionRecoveryLegacyStorageKey(gatewayUrl, recoveryScope);
      const legacy = readLegacyCloudSessionRecovery(storage, legacyKey, gatewayUrl, recoveryScope);
      if (legacy?.recovery.sessionKey === sessionKey) {
        removeCloudSessionRecoveryRow(storage, legacyKey);
      }
      return recovery;
    }
    const legacyKey = cloudSessionRecoveryLegacyStorageKey(gatewayUrl, recoveryScope);
    const legacy = readLegacyCloudSessionRecovery(storage, legacyKey, gatewayUrl, recoveryScope);
    if (!legacy || legacy.recovery.sessionKey !== sessionKey) {
      return null;
    }
    return relocateLegacyCloudSessionRecovery(storage, legacyKey, legacy);
  } catch {
    return null;
  }
}

export function writeCloudSessionRecovery(recovery: CloudSessionRecovery): boolean {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) {
      return false;
    }
    if (!recovery.gatewayUrl || !recovery.recoveryScope || !recovery.sessionKey) {
      return false;
    }
    const key = cloudSessionRecoveryExactStorageKey(
      recovery.gatewayUrl,
      recovery.recoveryScope,
      recovery.sessionKey,
    );
    storage.setItem(key, JSON.stringify(recovery));
    return Boolean(
      readOwnedCloudSessionRecovery(
        storage,
        key,
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
      ),
    );
  } catch {
    return false;
  }
}

export function writeCloudSessionRecoveryIfAvailable(recovery: CloudSessionRecovery): boolean {
  const existing = readCloudSessionRecovery(
    recovery.gatewayUrl,
    recovery.recoveryScope,
    recovery.sessionKey,
  );
  if (existing && existing.messageId !== recovery.messageId) {
    return false;
  }
  return writeCloudSessionRecovery(recovery);
}

export function promoteCloudSessionRecovery(
  previousSessionKey: string,
  recovery: CloudSessionRecovery,
): boolean {
  if (previousSessionKey === recovery.sessionKey) {
    return writeCloudSessionRecovery(recovery);
  }
  try {
    const storage = globalThis.sessionStorage;
    if (!storage || !previousSessionKey) {
      return false;
    }
    const previousKey = cloudSessionRecoveryExactStorageKey(
      recovery.gatewayUrl,
      recovery.recoveryScope,
      previousSessionKey,
    );
    const previousRaw = storage.getItem(previousKey);
    const previous = readOwnedCloudSessionRecovery(
      storage,
      previousKey,
      recovery.gatewayUrl,
      recovery.recoveryScope,
      previousSessionKey,
    );
    if (!previousRaw || !previous) {
      return writeCloudSessionRecovery(recovery);
    }
    const key = cloudSessionRecoveryExactStorageKey(
      recovery.gatewayUrl,
      recovery.recoveryScope,
      recovery.sessionKey,
    );
    const existing = readOwnedCloudSessionRecovery(
      storage,
      key,
      recovery.gatewayUrl,
      recovery.recoveryScope,
      recovery.sessionKey,
    );
    if (existing) {
      if (existing.messageId !== recovery.messageId) {
        return false;
      }
      return removeCloudSessionRecoveryRow(storage, previousKey);
    }
    return Boolean(relocateCloudSessionRecoveryRow(storage, previousKey, previousRaw, recovery));
  } catch {
    return false;
  }
}

export function clearCloudSessionRecovery(
  gatewayUrl: string,
  recoveryScope: string,
  expectedSessionKey?: string,
): void {
  if (!gatewayUrl || !recoveryScope) {
    return;
  }
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) {
      return;
    }
    const legacyKey = cloudSessionRecoveryLegacyStorageKey(gatewayUrl, recoveryScope);
    if (expectedSessionKey) {
      const key = cloudSessionRecoveryExactStorageKey(
        gatewayUrl,
        recoveryScope,
        expectedSessionKey,
      );
      removeCloudSessionRecoveryRow(storage, key);
      const raw = storage.getItem(legacyKey);
      if (raw) {
        const legacy = parseStoredCloudSessionRecovery(raw);
        if (
          legacy &&
          cloudSessionRecoveryClaimsScope(legacy, gatewayUrl, recoveryScope) &&
          legacy.sessionKey === expectedSessionKey
        ) {
          removeCloudSessionRecoveryRow(storage, legacyKey);
        }
      }
      return;
    }
    const scopePrefix = cloudSessionRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope);
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (!key?.startsWith(scopePrefix)) {
        continue;
      }
      removeCloudSessionRecoveryRow(storage, key);
    }
    const legacy = parseStoredCloudSessionRecovery(storage.getItem(legacyKey) ?? "");
    if (legacy && cloudSessionRecoveryClaimsScope(legacy, gatewayUrl, recoveryScope)) {
      removeCloudSessionRecoveryRow(storage, legacyKey);
    }
  } catch {
    // Recovery state is best-effort to remove after the durable operation completes.
  }
}
