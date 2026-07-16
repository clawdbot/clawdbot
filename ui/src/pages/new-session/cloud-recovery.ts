import type { SessionCreateParams } from "../../lib/sessions/create.ts";

export type CloudSessionCreateParams = SessionCreateParams & {
  key: string;
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
const STORAGE_PREFIX = "openclaw.new-session.cloud-recovery.v1:";

function storageKey(gatewayUrl: string, recoveryScope: string): string {
  return `${STORAGE_PREFIX}${gatewayUrl}:${recoveryScope}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const CLOUD_CREATE_STRING_FIELDS = [
  "model",
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
    ...CLOUD_CREATE_STRING_FIELDS,
  ]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    record.key !== sessionKey ||
    record.agentId !== agentId ||
    record.message !== "" ||
    record.worktree !== true ||
    CLOUD_CREATE_STRING_FIELDS.some(
      (key) => record[key] !== undefined && !isNonEmptyString(record[key]),
    )
  ) {
    return null;
  }
  return record as CloudSessionCreateParams;
}

export function readCloudSessionRecovery(
  gatewayUrl: string,
  recoveryScope: string,
): CloudSessionRecovery | null {
  if (!gatewayUrl || !recoveryScope) {
    return null;
  }
  try {
    const raw = globalThis.sessionStorage?.getItem(storageKey(gatewayUrl, recoveryScope));
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<CloudSessionRecovery>;
    if (
      !isNonEmptyString(value.sessionKey) ||
      !isNonEmptyString(value.messageId) ||
      typeof value.message !== "string" ||
      (!isNonEmptyString(value.message) && !value.attachments?.length) ||
      (value.attachments !== undefined && !Array.isArray(value.attachments)) ||
      !isNonEmptyString(value.profileId) ||
      !isNonEmptyString(value.agentId) ||
      value.gatewayUrl !== gatewayUrl ||
      value.recoveryScope !== recoveryScope ||
      (value.phase !== "creating" && value.phase !== "dispatching" && value.phase !== "sending") ||
      (value.phase === "creating" &&
        !parseCloudSessionCreateParams(value.createParams, value.sessionKey, value.agentId))
    ) {
      globalThis.sessionStorage?.removeItem(storageKey(gatewayUrl, recoveryScope));
      return null;
    }
    return value as CloudSessionRecovery;
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
    if (!recovery.gatewayUrl || !recovery.recoveryScope) {
      return false;
    }
    storage.setItem(
      storageKey(recovery.gatewayUrl, recovery.recoveryScope),
      JSON.stringify(recovery),
    );
    return storage.getItem(storageKey(recovery.gatewayUrl, recovery.recoveryScope)) !== null;
  } catch {
    return false;
  }
}

export function writeCloudSessionRecoveryIfAvailable(recovery: CloudSessionRecovery): boolean {
  const existing = readCloudSessionRecovery(recovery.gatewayUrl, recovery.recoveryScope);
  if (existing && existing.sessionKey !== recovery.sessionKey) {
    return false;
  }
  return writeCloudSessionRecovery(recovery);
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
    const key = storageKey(gatewayUrl, recoveryScope);
    if (expectedSessionKey) {
      const raw = storage?.getItem(key);
      if (!raw) {
        return;
      }
      const value = JSON.parse(raw) as Partial<CloudSessionRecovery>;
      if (value.sessionKey !== expectedSessionKey) {
        return;
      }
    }
    storage?.removeItem(key);
  } catch {
    // Recovery state is best-effort to remove after the durable operation completes.
  }
}
