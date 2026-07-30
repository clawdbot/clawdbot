import { promises as fs } from "node:fs";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";

const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
const RESERVED_SESSION_DELETE_MAX_ATTEMPTS = 3;
const RESERVED_SESSION_DELETE_MAX_ELAPSED_MS = 30_000;

export type ProvisionalSessionDeletionOutcome = "deleted" | "not_deleted" | "indeterminate";

type WaitForSessionDeletionOptions =
  | boolean
  | {
      maxAttempts?: number;
      maxElapsedMs?: number;
      retryDelayMs?: number;
    };

export async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: {
    emitLifecycleHooks?: boolean;
    deleteTranscript?: boolean;
    timeoutMs?: number;
  },
): Promise<boolean> {
  try {
    await callSubagentGateway({
      method: "sessions.delete",
      params: {
        key: childSessionKey,
        emitLifecycleHooks: options?.emitLifecycleHooks === true,
        deleteTranscript: options?.deleteTranscript === true,
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
  waitForSessionDeletion?: WaitForSessionDeletionOptions;
}): Promise<{
  attachmentsRemoved: boolean;
  sessionDeleted: boolean;
  sessionDeletion: ProvisionalSessionDeletionOutcome;
}> {
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
  };
  const waitOptions = normalizeSessionDeletionWaitOptions(params.waitForSessionDeletion);
  if (waitOptions.enabled) {
    const sessionDeletion = await deleteProvisionalSessionWithBound({
      childSessionKey: params.childSessionKey,
      cleanupOptions: sessionCleanupOptions,
      waitOptions,
    });
    return { attachmentsRemoved, sessionDeleted: sessionDeletion === "deleted", sessionDeletion };
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
