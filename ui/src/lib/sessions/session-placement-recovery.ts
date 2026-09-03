import {
  SessionsCreateParamsSchema,
  SessionPermissionModeSchema,
  SessionToolOverridesSchema,
} from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString as isNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";
import type { HumanMention } from "../chat/chat-types.ts";
import { readHumanMentions } from "../chat/human-mentions.ts";
import { formatUiError } from "../format-error.ts";
import type { SessionCreateParams } from "./create.ts";
import {
  listSessionPlacementRecoveryStorageKeys,
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

type SessionPlacementSubmission = {
  sessionKey: string;
  messageId: string;
  message: string;
  mentions?: readonly HumanMention[];
  attachments?: unknown[];
  target: SessionPlacementTarget;
  agentId: string;
  gatewayUrl: string;
  recoveryScope: string;
  createParams?: SessionPlacementCreateParams;
};

export type SessionPlacementPendingRecovery = SessionPlacementSubmission & {
  phase: "creating" | "dispatching" | "sending";
};
export type SessionPlacementPausedRecovery = SessionPlacementSubmission & {
  phase: "paused";
  reason: "not-sent" | "rejected" | "unconfirmed";
  error: string;
};
export type SessionPlacementRecovery =
  | SessionPlacementPendingRecovery
  | SessionPlacementPausedRecovery;

const SESSION_PLACEMENT_ERROR_MAX_LENGTH = 4096;

// Keep the create -> dispatch -> first-send handoff recoverable across reloads,
// while scoping it to this tab, Gateway, and authenticated credential.
const PLACEMENT_CREATE_STRING_FIELDS = [
  "category",
  "model",
  "contextWindow",
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
  "permissionMode",
  "fastMode",
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
    (record.fastMode !== undefined &&
      !Value.Check(SessionsCreateParamsSchema.properties.fastMode, record.fastMode)) ||
    (record.permissionMode !== undefined &&
      !Value.Check(SessionPermissionModeSchema, record.permissionMode)) ||
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
    (value.phase !== "creating" &&
      value.phase !== "dispatching" &&
      value.phase !== "sending" &&
      value.phase !== "paused") ||
    (value.phase === "paused" &&
      ((value.reason !== "not-sent" &&
        value.reason !== "rejected" &&
        value.reason !== "unconfirmed") ||
        !isNonEmptyString(value.error) ||
        value.error.length > SESSION_PLACEMENT_ERROR_MAX_LENGTH)) ||
    (value.phase === "creating" &&
      !parseSessionPlacementCreateParams(value.createParams, value.sessionKey, value.agentId))
  ) {
    return null;
  }
  const { mentions: storedMentions, ...recovery } = value;
  const mentions = readHumanMentions(value.message, storedMentions);
  if (
    storedMentions !== undefined &&
    (!Array.isArray(storedMentions) || (mentions?.length ?? 0) !== storedMentions.length)
  ) {
    return null;
  }
  // SAFETY: every required recovery field and nested closed target was validated above.
  return { ...recovery, ...(mentions ? { mentions } : {}) } as SessionPlacementRecovery;
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
    const recoveries = new Map<string, SessionPlacementRecovery>();
    for (const key of listSessionPlacementRecoveryStorageKeys(gatewayUrl, recoveryScope)) {
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
      clearSessionPlacementRecovery(
        gatewayUrl,
        sourceScope,
        recovery.sessionKey,
        recovery.messageId,
      );
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
  const { gatewayUrl, recoveryScope, sessionKey } = recovery;
  const normalized = validateSessionPlacementRecovery(
    recovery,
    gatewayUrl,
    recoveryScope,
    sessionKey,
  );
  if (!gatewayUrl || !recoveryScope || !normalized) {
    return false;
  }
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) {
      return false;
    }
    const key = sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, sessionKey);
    storage.setItem(key, JSON.stringify(normalized));
    return Boolean(
      readOwnedSessionPlacementRecovery(storage, key, gatewayUrl, recoveryScope, sessionKey),
    );
  } catch {
    return false;
  }
}

export function writeSessionPlacementRecoveryIfAvailable(
  recovery: SessionPlacementRecovery,
  expectedMessageId = recovery.messageId,
): boolean {
  const existing = readSessionPlacementRecovery(
    recovery.gatewayUrl,
    recovery.recoveryScope,
    recovery.sessionKey,
  );
  if (existing && existing.messageId !== expectedMessageId) {
    return false;
  }
  return writeSessionPlacementRecovery(recovery);
}

export function promoteSessionPlacementRecovery(
  previousSessionKey: string,
  recovery: SessionPlacementRecovery,
): boolean {
  if (previousSessionKey === recovery.sessionKey) {
    return writeSessionPlacementRecoveryIfAvailable(recovery);
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
      return writeSessionPlacementRecoveryIfAvailable(recovery);
    }
    if (previous.messageId !== recovery.messageId) {
      return false;
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
  expectedMessageId?: string,
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
      // Async completion may belong to an older submission at this session key.
      // Unconditional session/scope retirement remains available to intentional deletion.
      if (
        expectedMessageId &&
        parseStoredSessionPlacementRecovery(storage.getItem(key) ?? "")?.messageId !==
          expectedMessageId
      ) {
        return;
      }
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

/** Paused records cannot be executed by older readers, which reject unknown phases. */
export function pauseSessionPlacementRecovery(
  recovery: SessionPlacementRecovery,
  error: string,
  persistent: boolean,
  reason: SessionPlacementPausedRecovery["reason"] = recovery.phase === "paused"
    ? recovery.reason
    : recovery.phase === "sending"
      ? "unconfirmed"
      : "not-sent",
): SessionPlacementPausedRecovery {
  const paused: SessionPlacementPausedRecovery = {
    ...recovery,
    phase: "paused",
    reason,
    error: formatUiError(error).slice(0, SESSION_PLACEMENT_ERROR_MAX_LENGTH),
  };
  if (persistent && !writeSessionPlacementRecoveryIfAvailable(paused)) {
    // Preserve input in memory without leaving an executable pending row when
    // storage refuses the paused replacement. Never retire a newer submission.
    const stored = readSessionPlacementRecovery(
      recovery.gatewayUrl,
      recovery.recoveryScope,
      recovery.sessionKey,
    );
    if (stored?.phase !== "paused") {
      clearSessionPlacementRecovery(
        recovery.gatewayUrl,
        recovery.recoveryScope,
        recovery.sessionKey,
        recovery.messageId,
      );
    }
    paused.error =
      `Recovery could not be saved in this tab. Keep this page open.\n${paused.error}`.slice(
        0,
        SESSION_PLACEMENT_ERROR_MAX_LENGTH,
      );
  }
  return paused;
}
