import { SessionToolOverridesSchema } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString as isNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";
import type { SessionCreateParams } from "./create.ts";
import {
  sessionPlacementRecoveryExactStorageKey,
  sessionPlacementRecoveryScopeStoragePrefix,
} from "./session-placement-recovery-storage-key.ts";

export type SessionPlacementTarget =
  | { kind: "profile"; profileId: string; machineClass?: string }
  | { kind: "device"; deviceId: string }
  | { kind: "auto-device" };

export type SessionPlacementCreateParams = Omit<SessionCreateParams, "execNode"> & {
  key?: string;
  agentId: string;
  message: "";
  projectId?: string;
  visibility?: "draft";
  worktree: true;
};

export type SessionPlacementRecovery = {
  sessionKey: string;
  messageId: string;
  message: string;
  attachments?: unknown[];
  target: SessionPlacementTarget;
  agentId: string;
  gatewayUrl: string;
  recoveryScope: string;
  phase: "creating" | "dispatching" | "sending";
  createParams?: SessionPlacementCreateParams;
};

// Keep the create -> dispatch -> first-send handoff recoverable across reloads,
// while scoping it to this tab, Gateway, and authenticated credential.
const PLACEMENT_CREATE_STRING_FIELDS = [
  "category",
  "model",
  "thinkingLevel",
  "worktreeBaseRef",
  "worktreeName",
  "cwd",
  "catalogId",
  "projectId",
] as const;
const PLACEMENT_CREATE_FIELDS = new Set<string>([
  "key",
  "agentId",
  "message",
  "worktree",
  "incognito",
  "visibility",
  "toolOverrides",
  ...PLACEMENT_CREATE_STRING_FIELDS,
]);

export function parseSessionPlacementCreateParams(
  value: unknown,
  sessionKey: string,
  agentId: string,
): SessionPlacementCreateParams | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  if (
    Object.keys(record).some((key) => !PLACEMENT_CREATE_FIELDS.has(key)) ||
    record.key !== sessionKey ||
    record.agentId !== agentId ||
    record.message !== "" ||
    record.worktree !== true ||
    (record.incognito !== undefined && record.incognito !== true) ||
    (record.visibility !== undefined && record.visibility !== "draft") ||
    (record.toolOverrides !== undefined &&
      !Value.Check(SessionToolOverridesSchema, record.toolOverrides)) ||
    (record.projectId !== undefined && record.cwd !== undefined) ||
    PLACEMENT_CREATE_STRING_FIELDS.some(
      (key) => record[key] !== undefined && !isNonEmptyString(record[key]),
    )
  ) {
    return null;
  }
  // SAFETY: the closed field set and value checks above establish every create parameter.
  return record as SessionPlacementCreateParams;
}

function parseStoredSessionPlacementRecovery(
  raw: string,
): Partial<SessionPlacementRecovery> | null {
  try {
    const value: unknown = JSON.parse(raw);
    // SAFETY: fields remain optional until validateSessionPlacementRecovery checks their values.
    return isRecord(value) ? (value as Partial<SessionPlacementRecovery>) : null;
  } catch {
    return null;
  }
}

function sessionPlacementRecoveryClaimsScope(
  value: Partial<SessionPlacementRecovery>,
  gatewayUrl: string,
  recoveryScope: string,
): boolean {
  return value.gatewayUrl === gatewayUrl && value.recoveryScope === recoveryScope;
}

function parseSessionPlacementTarget(value: unknown): SessionPlacementTarget | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.kind === "profile" &&
    Object.keys(value).every(
      (key) => key === "kind" || key === "profileId" || key === "machineClass",
    ) &&
    isNonEmptyString(value.profileId) &&
    (value.machineClass === undefined ||
      (isNonEmptyString(value.machineClass) && value.machineClass.length <= 128))
  ) {
    // SAFETY: the profile discriminator, exact keys, and field values are validated above.
    return value as SessionPlacementTarget;
  }
  if (
    value.kind === "device" &&
    Object.keys(value).every((key) => key === "kind" || key === "deviceId") &&
    isNonEmptyString(value.deviceId)
  ) {
    // SAFETY: the device discriminator, exact keys, and device id are validated above.
    return value as SessionPlacementTarget;
  }
  if (value.kind === "auto-device" && Object.keys(value).every((key) => key === "kind")) {
    return { kind: "auto-device" };
  }
  return null;
}

function validateSessionPlacementRecovery(
  value: Partial<SessionPlacementRecovery>,
  gatewayUrl: string,
  recoveryScope: string,
  expectedSessionKey?: string,
): SessionPlacementRecovery | null {
  if (
    value.createParams?.incognito === true ||
    !isNonEmptyString(value.sessionKey) ||
    (expectedSessionKey !== undefined && value.sessionKey !== expectedSessionKey) ||
    !isNonEmptyString(value.messageId) ||
    typeof value.message !== "string" ||
    (!isNonEmptyString(value.message) && !value.attachments?.length) ||
    (value.attachments !== undefined && !Array.isArray(value.attachments)) ||
    !parseSessionPlacementTarget(value.target) ||
    !isNonEmptyString(value.agentId) ||
    !sessionPlacementRecoveryClaimsScope(value, gatewayUrl, recoveryScope) ||
    (value.phase !== "creating" && value.phase !== "dispatching" && value.phase !== "sending") ||
    (value.phase === "creating" &&
      !parseSessionPlacementCreateParams(value.createParams, value.sessionKey, value.agentId))
  ) {
    return null;
  }
  // SAFETY: every required recovery field and nested closed target was validated above.
  return value as SessionPlacementRecovery;
}

function removeSessionPlacementRecoveryRow(storage: Storage, key: string): boolean {
  try {
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    // Recovery state is best-effort to remove after completion or validation failure.
    return false;
  }
}

function readOwnedSessionPlacementRecovery(
  storage: Storage,
  key: string,
  gatewayUrl: string,
  recoveryScope: string,
  expectedSessionKey?: string,
): SessionPlacementRecovery | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) {
      return null;
    }
    const value = parseStoredSessionPlacementRecovery(raw);
    const recovery = value
      ? validateSessionPlacementRecovery(value, gatewayUrl, recoveryScope, expectedSessionKey)
      : null;
    if (
      !recovery ||
      key !==
        sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, recovery.sessionKey)
    ) {
      // Every row below a framed scope prefix belongs to that exact scope.
      // A bad row can therefore be removed without touching another namespace.
      removeSessionPlacementRecoveryRow(storage, key);
      return null;
    }
    return recovery;
  } catch {
    return null;
  }
}

function relocateSessionPlacementRecoveryRow(
  storage: Storage,
  sourceKey: string,
  sourceRaw: string,
  recovery: SessionPlacementRecovery,
): SessionPlacementRecovery | null {
  const key = sessionPlacementRecoveryExactStorageKey(
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
    const relocated = readOwnedSessionPlacementRecovery(
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
  removeSessionPlacementRecoveryRow(storage, key);
  try {
    storage.setItem(sourceKey, sourceRaw);
  } catch {
    // Fail closed if even the original bytes no longer fit.
  }
  return null;
}

export function listSessionPlacementRecoveries(
  gatewayUrl: string,
  recoveryScope: string,
): SessionPlacementRecovery[] {
  if (!gatewayUrl || !recoveryScope) {
    return [];
  }
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) {
      return [];
    }
    const scopePrefix = sessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope);
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(scopePrefix)) {
        keys.push(key);
      }
    }
    const sortedKeys = keys.toSorted();

    const recoveries = new Map<string, SessionPlacementRecovery>();
    for (const key of sortedKeys) {
      const recovery = readOwnedSessionPlacementRecovery(storage, key, gatewayUrl, recoveryScope);
      if (!recovery) {
        continue;
      }
      recoveries.set(recovery.sessionKey, recovery);
    }

    return [...recoveries.values()].toSorted((left, right) =>
      left.sessionKey.localeCompare(right.sessionKey),
    );
  } catch {
    return [];
  }
}

export function migrateSessionPlacementRecoveryScope(
  gatewayUrl: string,
  sourceScope: string,
  destinationScope: string,
): void {
  for (const recovery of listSessionPlacementRecoveries(gatewayUrl, sourceScope)) {
    const destination = { ...recovery, recoveryScope: destinationScope };
    if (writeSessionPlacementRecoveryIfAvailable(destination)) {
      clearSessionPlacementRecovery(gatewayUrl, sourceScope, recovery.sessionKey);
    }
  }
}

export function readSessionPlacementRecovery(
  gatewayUrl: string,
  recoveryScope: string,
  sessionKey: string,
): SessionPlacementRecovery | null {
  if (!gatewayUrl || !recoveryScope || !sessionKey) {
    return null;
  }
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) {
      return null;
    }
    const key = sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, sessionKey);
    return readOwnedSessionPlacementRecovery(storage, key, gatewayUrl, recoveryScope, sessionKey);
  } catch {
    return null;
  }
}

export function writeSessionPlacementRecovery(recovery: SessionPlacementRecovery): boolean {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) {
      return false;
    }
    if (!recovery.gatewayUrl || !recovery.recoveryScope || !recovery.sessionKey) {
      return false;
    }
    const key = sessionPlacementRecoveryExactStorageKey(
      recovery.gatewayUrl,
      recovery.recoveryScope,
      recovery.sessionKey,
    );
    storage.setItem(key, JSON.stringify(recovery));
    return Boolean(
      readOwnedSessionPlacementRecovery(
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

export function writeSessionPlacementRecoveryIfAvailable(
  recovery: SessionPlacementRecovery,
): boolean {
  const existing = readSessionPlacementRecovery(
    recovery.gatewayUrl,
    recovery.recoveryScope,
    recovery.sessionKey,
  );
  if (existing && existing.messageId !== recovery.messageId) {
    return false;
  }
  return writeSessionPlacementRecovery(recovery);
}

export function promoteSessionPlacementRecovery(
  previousSessionKey: string,
  recovery: SessionPlacementRecovery,
): boolean {
  if (previousSessionKey === recovery.sessionKey) {
    return writeSessionPlacementRecovery(recovery);
  }
  try {
    const storage = globalThis.sessionStorage;
    if (!storage || !previousSessionKey) {
      return false;
    }
    const previousKey = sessionPlacementRecoveryExactStorageKey(
      recovery.gatewayUrl,
      recovery.recoveryScope,
      previousSessionKey,
    );
    const previousRaw = storage.getItem(previousKey);
    const previous = readOwnedSessionPlacementRecovery(
      storage,
      previousKey,
      recovery.gatewayUrl,
      recovery.recoveryScope,
      previousSessionKey,
    );
    if (!previousRaw || !previous) {
      return writeSessionPlacementRecovery(recovery);
    }
    const key = sessionPlacementRecoveryExactStorageKey(
      recovery.gatewayUrl,
      recovery.recoveryScope,
      recovery.sessionKey,
    );
    const existing = readOwnedSessionPlacementRecovery(
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
      return removeSessionPlacementRecoveryRow(storage, previousKey);
    }
    return Boolean(
      relocateSessionPlacementRecoveryRow(storage, previousKey, previousRaw, recovery),
    );
  } catch {
    return false;
  }
}

export function clearSessionPlacementRecovery(
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
    if (expectedSessionKey) {
      const key = sessionPlacementRecoveryExactStorageKey(
        gatewayUrl,
        recoveryScope,
        expectedSessionKey,
      );
      removeSessionPlacementRecoveryRow(storage, key);
      return;
    }
    const scopePrefix = sessionPlacementRecoveryScopeStoragePrefix(gatewayUrl, recoveryScope);
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (!key?.startsWith(scopePrefix)) {
        continue;
      }
      removeSessionPlacementRecoveryRow(storage, key);
    }
  } catch {
    // Recovery state is best-effort to remove after the durable operation completes.
  }
}
