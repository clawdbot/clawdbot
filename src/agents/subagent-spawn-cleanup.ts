import { promises as fs } from "node:fs";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../config/sessions/lifecycle.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { callGateway } from "../gateway/call.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import type { ProvisionalSessionCleanupIdentity } from "./subagent-spawn-cleanup-types.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";

const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
const RESERVED_SESSION_DELETE_MAX_ATTEMPTS = 3;
const RESERVED_SESSION_DELETE_MAX_ELAPSED_MS = 30_000;

export type ProvisionalSessionDeletionOutcome = "deleted" | "not_deleted" | "indeterminate";

type GatewayCall = (options: Parameters<typeof callGateway>[0]) => Promise<unknown>;
type ProvisionalSessionCleanupProof = "missing" | "original" | "replacement";
type SessionCleanupOutcome = "deleted" | "changed" | "failed";

type WaitForSessionDeletionOptions =
  | boolean
  | {
      maxAttempts?: number;
      maxElapsedMs?: number;
      retryDelayMs?: number;
    };

type SessionCleanupOptions = {
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
  expectedIdentity?: ProvisionalSessionCleanupIdentity;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  expectedSessionUpdatedAt?: number;
  callGateway?: GatewayCall;
  timeoutMs?: number;
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

function normalizeCleanupOptionsIdentity(
  options?: SessionCleanupOptions,
): ProvisionalSessionCleanupIdentity | undefined {
  return normalizeProvisionalSessionCleanupIdentity(
    options?.expectedIdentity ?? {
      expectedSessionId: options?.expectedSessionId,
      expectedLifecycleRevision: options?.expectedLifecycleRevision,
      expectedSessionUpdatedAt: options?.expectedSessionUpdatedAt,
    },
  );
}

function hasDeletionGuard(identity?: ProvisionalSessionCleanupIdentity): boolean {
  return Boolean(identity?.expectedSessionId && identity.expectedLifecycleRevision);
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

function isSessionLifecycleChangedGatewayError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return false;
  }
  const requestError = error as Error & { gatewayCode?: unknown; details?: unknown };
  const details = requestError.details;
  return (
    requestError.gatewayCode === "INVALID_REQUEST" &&
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === SESSION_LIFECYCLE_CHANGED_ERROR_REASON
  );
}

function isMatchingAbortResponse(response: unknown, gatewayRunId: string): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const result = response as { aborted?: unknown; runIds?: unknown };
  return (
    result.aborted === true &&
    Array.isArray(result.runIds) &&
    result.runIds.some((runId) => runId === gatewayRunId)
  );
}

export async function retrySubagentCleanup(
  attempt: () => boolean | Promise<boolean>,
  options?: {
    shouldRetry?: () => boolean;
    onError?: (error: unknown) => void;
    retryDelayMs?: number;
  },
): Promise<boolean> {
  for (;;) {
    try {
      if (await attempt()) {
        return true;
      }
    } catch (error) {
      options?.onError?.(error);
    }
    if (options?.shouldRetry?.() === false) {
      return false;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        resolve,
        options?.retryDelayMs ?? (isFastTestRuntimeEnv() ? 1 : 1_000),
      );
      timer.unref?.();
    });
  }
}

async function requestProvisionalSessionCleanup(
  childSessionKey: string,
  options?: SessionCleanupOptions,
): Promise<SessionCleanupOutcome> {
  const expectedIdentity = normalizeCleanupOptionsIdentity(options);
  const expectedSessionId = expectedIdentity?.expectedSessionId;
  const expectedLifecycleRevision = expectedIdentity?.expectedLifecycleRevision;
  if (!expectedSessionId || !expectedLifecycleRevision) {
    return "failed";
  }
  try {
    await (options?.callGateway ?? callSubagentGateway)({
      method: "sessions.delete",
      params: {
        key: childSessionKey,
        emitLifecycleHooks: options?.emitLifecycleHooks === true,
        deleteTranscript: options?.deleteTranscript === true,
        expectedSessionId,
        expectedLifecycleRevision,
        ...(typeof expectedIdentity.expectedSessionUpdatedAt === "number"
          ? { expectedSessionUpdatedAt: expectedIdentity.expectedSessionUpdatedAt }
          : {}),
      },
      timeoutMs: options?.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
    });
    return "deleted";
  } catch (error) {
    if (isSessionLifecycleChangedGatewayError(error)) {
      return "changed";
    }
    return "failed";
  }
}

export async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: SessionCleanupOptions,
): Promise<boolean> {
  return (await requestProvisionalSessionCleanup(childSessionKey, options)) === "deleted";
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
  cleanupOptions?: SessionCleanupOptions;
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
    const outcome = await requestProvisionalSessionCleanup(params.childSessionKey, {
      ...params.cleanupOptions,
      timeoutMs: attemptTimeoutMs,
    });
    if (outcome === "deleted") {
      return "deleted";
    }
    if (outcome === "changed") {
      return "not_deleted";
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
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  expectedSessionUpdatedAt?: number;
  waitForSessionDeletion?: WaitForSessionDeletionOptions;
}): Promise<{
  attachmentsRemoved: boolean;
  sessionDeleted: boolean;
  sessionDeletion: ProvisionalSessionDeletionOutcome;
}> {
  const expectedIdentity = normalizeCleanupOptionsIdentity(params);
  const guardedDeletion = hasDeletionGuard(expectedIdentity);
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
  let attachmentsRemoved = true;
  if (!guardedDeletion) {
    attachmentsRemoved = await removeAttachments();
  }
  let sessionDeletion: ProvisionalSessionDeletionOutcome;
  if (waitOptions.enabled) {
    sessionDeletion = await deleteProvisionalSessionWithBound({
      childSessionKey: params.childSessionKey,
      cleanupOptions: sessionCleanupOptions,
      waitOptions,
    });
  } else {
    const outcome = await requestProvisionalSessionCleanup(
      params.childSessionKey,
      sessionCleanupOptions,
    );
    sessionDeletion =
      outcome === "deleted" ? "deleted" : outcome === "changed" ? "not_deleted" : "not_deleted";
  }
  const sessionDeleted = sessionDeletion === "deleted";
  if (guardedDeletion) {
    attachmentsRemoved = sessionDeleted ? await removeAttachments() : false;
  }
  return {
    attachmentsRemoved,
    sessionDeleted,
    sessionDeletion,
  };
}

export async function terminateAcceptedCollectorRun(params: {
  childSessionKey: string;
  gatewayRunId: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  callGateway?: GatewayCall;
  timeoutMs?: number;
}): Promise<void> {
  const call = params.callGateway ?? callSubagentGateway;
  const timeoutMs = params.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS;
  await retrySubagentCleanup(async () => {
    try {
      const response = await call({
        method: "chat.abort",
        params: { sessionKey: params.childSessionKey, runId: params.gatewayRunId },
        timeoutMs,
      });
      if (isMatchingAbortResponse(response, params.gatewayRunId)) {
        return true;
      }
    } catch {
      // Fall through to exact-session deletion.
    }
    const cleanup = await requestProvisionalSessionCleanup(params.childSessionKey, {
      deleteTranscript: true,
      expectedSessionId: params.expectedSessionId,
      expectedLifecycleRevision: params.expectedLifecycleRevision,
      callGateway: call,
      timeoutMs,
    });
    // A changed lifecycle proves the accepted run no longer owns this session.
    return cleanup !== "failed";
  });
}
