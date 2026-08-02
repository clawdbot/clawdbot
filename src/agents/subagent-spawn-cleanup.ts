import { promises as fs } from "node:fs";
import type { SessionEntry } from "../config/sessions/types.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import type { ProvisionalSessionCleanupIdentity } from "./subagent-spawn-cleanup-types.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";

const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
const RESERVED_SESSION_DELETE_MAX_ATTEMPTS = 3;
const RESERVED_SESSION_DELETE_MAX_ELAPSED_MS = 30_000;

export type ProvisionalSessionDeletionOutcome = "deleted" | "not_deleted" | "indeterminate";

type ProvisionalSessionCleanupProof = "missing" | "original" | "replacement";

type WaitForSessionDeletionOptions =
  | boolean
  | {
      maxAttempts?: number;
      maxElapsedMs?: number;
      retryDelayMs?: number;
    };

function normalizeProvisionalSessionCleanupIdentity(
  identity?: ProvisionalSessionCleanupIdentity,
): ProvisionalSessionCleanupIdentity | undefined {
  const expectedSessionId = identity?.expectedSessionId?.trim();
  const expectedLifecycleRevision = identity?.expectedLifecycleRevision?.trim();
  const expectedSessionUpdatedAt = identity?.expectedSessionUpdatedAt;
  if (!expectedSessionId && !expectedLifecycleRevision) {
    return undefined;
  }
  const normalized: ProvisionalSessionCleanupIdentity = {
    ...(expectedSessionId ? { expectedSessionId } : {}),
    ...(expectedLifecycleRevision ? { expectedLifecycleRevision } : {}),
    ...(typeof expectedSessionUpdatedAt === "number" && Number.isFinite(expectedSessionUpdatedAt)
      ? { expectedSessionUpdatedAt }
      : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function captureProvisionalSessionCleanupIdentity(
  entry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "updatedAt">,
): ProvisionalSessionCleanupIdentity | undefined {
  return normalizeProvisionalSessionCleanupIdentity({
    expectedSessionId: entry?.sessionId,
    expectedLifecycleRevision: entry?.lifecycleRevision,
    expectedSessionUpdatedAt: entry?.updatedAt,
  });
}

export function refreshProvisionalSessionCleanupIdentity(
  current: ProvisionalSessionCleanupIdentity | undefined,
  entry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "updatedAt">,
): ProvisionalSessionCleanupIdentity | undefined {
  return captureProvisionalSessionCleanupIdentity(entry) ?? current;
}

function provisionalSessionCleanupIdentityMatches(
  entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "updatedAt"> | undefined,
  identity?: ProvisionalSessionCleanupIdentity,
): boolean {
  const expected = normalizeProvisionalSessionCleanupIdentity(identity);
  if (!expected) {
    return true;
  }
  if (!entry) {
    return false;
  }
  return (
    (expected.expectedSessionId === undefined || entry.sessionId === expected.expectedSessionId) &&
    (expected.expectedLifecycleRevision === undefined ||
      entry.lifecycleRevision === expected.expectedLifecycleRevision) &&
    (expected.expectedSessionUpdatedAt === undefined ||
      entry.updatedAt === expected.expectedSessionUpdatedAt)
  );
}

export function resolveProvisionalSessionCleanupProof(
  entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "updatedAt"> | undefined,
  identity?: ProvisionalSessionCleanupIdentity,
): ProvisionalSessionCleanupProof {
  if (!entry) {
    return "missing";
  }
  return provisionalSessionCleanupIdentityMatches(entry, identity) ? "original" : "replacement";
}

export function cleanupIdentityOption(identity?: ProvisionalSessionCleanupIdentity): {
  expectedIdentity?: ProvisionalSessionCleanupIdentity;
} {
  return identity ? { expectedIdentity: identity } : {};
}

function reservedCleanupState(
  sessionDeletion: ProvisionalSessionDeletionOutcome,
  identity?: ProvisionalSessionCleanupIdentity,
): {
  sessionDeletion: ProvisionalSessionDeletionOutcome;
  sessionIdentity?: ProvisionalSessionCleanupIdentity;
} {
  return {
    sessionDeletion,
    ...(identity ? { sessionIdentity: identity } : {}),
  };
}

export function applyReservedCleanupState<T extends { status: string }>(
  result: T,
  sessionDeletion?: ProvisionalSessionDeletionOutcome,
  identity?: ProvisionalSessionCleanupIdentity,
): T {
  return sessionDeletion && result.status !== "accepted"
    ? { ...result, reservedCleanup: reservedCleanupState(sessionDeletion, identity) }
    : result;
}

export async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: {
    emitLifecycleHooks?: boolean;
    deleteTranscript?: boolean;
    timeoutMs?: number;
    expectedIdentity?: ProvisionalSessionCleanupIdentity;
  },
): Promise<boolean> {
  const expectedIdentity = normalizeProvisionalSessionCleanupIdentity(options?.expectedIdentity);
  try {
    await callSubagentGateway({
      method: "sessions.delete",
      params: {
        key: childSessionKey,
        emitLifecycleHooks: options?.emitLifecycleHooks === true,
        deleteTranscript: options?.deleteTranscript === true,
        ...expectedIdentity,
      },
      timeoutMs: options?.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
    });
    return true;
  } catch {
    // Best-effort cleanup only.
    return false;
  }
}

function normalizeSessionDeletionWaitOptions(options?: WaitForSessionDeletionOptions): {
  enabled: boolean;
  maxAttempts: number;
  maxElapsedMs: number;
  retryDelayMs: number;
} {
  const configured = typeof options === "object" && options !== null ? options : {};
  return {
    enabled: options === true || typeof options === "object",
    maxAttempts: Math.max(
      1,
      Math.floor(configured.maxAttempts ?? RESERVED_SESSION_DELETE_MAX_ATTEMPTS),
    ),
    maxElapsedMs: Math.max(
      0,
      Math.floor(configured.maxElapsedMs ?? RESERVED_SESSION_DELETE_MAX_ELAPSED_MS),
    ),
    retryDelayMs: Math.max(
      0,
      Math.floor(configured.retryDelayMs ?? (isFastTestRuntimeEnv() ? 1 : 1_000)),
    ),
  };
}

async function deleteProvisionalSessionWithBound(params: {
  childSessionKey: string;
  cleanupOptions?: {
    emitLifecycleHooks?: boolean;
    deleteTranscript?: boolean;
    expectedIdentity?: ProvisionalSessionCleanupIdentity;
  };
  waitOptions: ReturnType<typeof normalizeSessionDeletionWaitOptions>;
}): Promise<ProvisionalSessionDeletionOutcome> {
  const startedAt = Date.now();
  for (let attempts = 1; attempts <= params.waitOptions.maxAttempts; attempts += 1) {
    const elapsedMs = Date.now() - startedAt;
    const remainingElapsedMs = params.waitOptions.maxElapsedMs - elapsedMs;
    const attemptTimeoutMs = Math.max(
      1,
      Math.min(
        SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
        params.waitOptions.maxElapsedMs === 0 ? 1 : Math.max(1, remainingElapsedMs),
      ),
    );
    if (
      await cleanupProvisionalSession(params.childSessionKey, {
        ...params.cleanupOptions,
        timeoutMs: attemptTimeoutMs,
      })
    ) {
      return "deleted";
    }
    if (
      attempts >= params.waitOptions.maxAttempts ||
      Date.now() - startedAt >= params.waitOptions.maxElapsedMs
    ) {
      return "indeterminate";
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, params.waitOptions.retryDelayMs);
      timer.unref?.();
    });
  }
  return "indeterminate";
}

export async function cleanupFailedSpawnBeforeAgentStart(params: {
  childSessionKey: string;
  attachmentAbsDir?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
  expectedIdentity?: ProvisionalSessionCleanupIdentity;
  waitForSessionDeletion?: WaitForSessionDeletionOptions;
}): Promise<{
  attachmentsRemoved: boolean;
  sessionDeleted: boolean;
  sessionDeletion: ProvisionalSessionDeletionOutcome;
}> {
  const expectedIdentity = normalizeProvisionalSessionCleanupIdentity(params.expectedIdentity);
  const removeAttachments = async (): Promise<boolean> => {
    if (!params.attachmentAbsDir) {
      return true;
    }
    try {
      await fs.rm(params.attachmentAbsDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
  const sessionCleanupOptions = {
    emitLifecycleHooks: params.emitLifecycleHooks,
    deleteTranscript: params.deleteTranscript,
    expectedIdentity,
  };
  const waitOptions = normalizeSessionDeletionWaitOptions(params.waitForSessionDeletion);
  if (!expectedIdentity) {
    const attachmentsRemoved = await removeAttachments();
    if (waitOptions.enabled) {
      const sessionDeletion = await deleteProvisionalSessionWithBound({
        childSessionKey: params.childSessionKey,
        cleanupOptions: sessionCleanupOptions,
        waitOptions,
      });
      return {
        attachmentsRemoved,
        sessionDeleted: sessionDeletion === "deleted",
        sessionDeletion,
      };
    }
    const sessionDeleted = await cleanupProvisionalSession(
      params.childSessionKey,
      sessionCleanupOptions,
    );
    return {
      attachmentsRemoved,
      sessionDeleted,
      sessionDeletion: sessionDeleted ? "deleted" : "not_deleted",
    };
  }
  if (waitOptions.enabled) {
    const sessionDeletion = await deleteProvisionalSessionWithBound({
      childSessionKey: params.childSessionKey,
      cleanupOptions: sessionCleanupOptions,
      waitOptions,
    });
    const sessionDeleted = sessionDeletion === "deleted";
    return {
      attachmentsRemoved: sessionDeleted ? await removeAttachments() : false,
      sessionDeleted,
      sessionDeletion,
    };
  }
  const sessionDeleted = await cleanupProvisionalSession(
    params.childSessionKey,
    sessionCleanupOptions,
  );
  return {
    attachmentsRemoved: sessionDeleted ? await removeAttachments() : false,
    sessionDeleted,
    sessionDeletion: sessionDeleted ? "deleted" : "not_deleted",
  };
}

export async function terminateAcceptedCollectorRun(params: {
  childSessionKey: string;
  gatewayRunId: string;
}): Promise<void> {
  for (;;) {
    try {
      await callSubagentGateway({
        method: "chat.abort",
        params: { sessionKey: params.childSessionKey, runId: params.gatewayRunId },
        timeoutMs: SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
      });
      return;
    } catch {
      if (
        await cleanupProvisionalSession(params.childSessionKey, {
          deleteTranscript: true,
        })
      ) {
        return;
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
      timer.unref?.();
    });
  }
}
