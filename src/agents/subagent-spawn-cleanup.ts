import { promises as fs } from "node:fs";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../config/sessions/lifecycle.js";
import type { callGateway } from "../gateway/call.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";

const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
type GatewayCall = (options: Parameters<typeof callGateway>[0]) => Promise<unknown>;
type SessionCleanupOutcome = "deleted" | "changed" | "failed";

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
  options?: { shouldRetry?: () => boolean; onError?: (error: unknown) => void },
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
      const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
      timer.unref?.();
    });
  }
}

type SessionCleanupOptions = {
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  callGateway?: GatewayCall;
  timeoutMs?: number;
};

async function requestProvisionalSessionCleanup(
  childSessionKey: string,
  options?: SessionCleanupOptions,
): Promise<SessionCleanupOutcome> {
  if (!options?.expectedSessionId || !options.expectedLifecycleRevision) {
    return "failed";
  }
  try {
    await (options?.callGateway ?? callSubagentGateway)({
      method: "sessions.delete",
      params: {
        key: childSessionKey,
        emitLifecycleHooks: options?.emitLifecycleHooks === true,
        deleteTranscript: options?.deleteTranscript === true,
        ...(options?.expectedSessionId ? { expectedSessionId: options.expectedSessionId } : {}),
        ...(options?.expectedLifecycleRevision
          ? { expectedLifecycleRevision: options.expectedLifecycleRevision }
          : {}),
      },
      timeoutMs: options?.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
    });
    return "deleted";
  } catch (error) {
    if (isSessionLifecycleChangedGatewayError(error)) {
      return "changed";
    }
    // Best-effort cleanup only.
    return "failed";
  }
}

export async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: SessionCleanupOptions,
): Promise<boolean> {
  return (await requestProvisionalSessionCleanup(childSessionKey, options)) === "deleted";
}

async function waitForProvisionalSessionDeletion(
  childSessionKey: string,
  options?: SessionCleanupOptions,
): Promise<boolean> {
  let deleted = false;
  await retrySubagentCleanup(async () => {
    const outcome = await requestProvisionalSessionCleanup(childSessionKey, options);
    deleted = outcome === "deleted";
    return outcome !== "failed";
  });
  return deleted;
}

export async function cleanupFailedSpawnBeforeAgentStart(params: {
  childSessionKey: string;
  attachmentAbsDir?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
  waitForSessionDeletion?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
}): Promise<{ attachmentsRemoved: boolean; sessionDeleted: boolean }> {
  let attachmentsRemoved = true;
  if (params.attachmentAbsDir) {
    try {
      await fs.rm(params.attachmentAbsDir, { recursive: true, force: true });
    } catch {
      attachmentsRemoved = false;
    }
  }
  const sessionCleanupOptions = {
    emitLifecycleHooks: params.emitLifecycleHooks,
    deleteTranscript: params.deleteTranscript,
    expectedSessionId: params.expectedSessionId,
    expectedLifecycleRevision: params.expectedLifecycleRevision,
  };
  if (params.waitForSessionDeletion) {
    const sessionDeleted = await waitForProvisionalSessionDeletion(
      params.childSessionKey,
      sessionCleanupOptions,
    );
    return { attachmentsRemoved, sessionDeleted };
  }
  return {
    attachmentsRemoved,
    sessionDeleted: await cleanupProvisionalSession(params.childSessionKey, sessionCleanupOptions),
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
