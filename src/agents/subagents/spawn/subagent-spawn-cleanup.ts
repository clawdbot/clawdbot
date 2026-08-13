import type { callGateway } from "../../../gateway/call.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { deleteSubagentSessionForCleanup } from "../registry/subagent-session-cleanup.js";
import { cleanupMaterializedSubagentAttachments } from "./subagent-attachments.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";

const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
type GatewayCall = (options: Parameters<typeof callGateway>[0]) => Promise<unknown>;
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

function requestProvisionalSessionCleanup(
  childSessionKey: string,
  options?: SessionCleanupOptions,
) {
  return deleteSubagentSessionForCleanup({
    ...options,
    childSessionKey,
    callGateway: options?.callGateway ?? callSubagentGateway,
    deleteTranscript: options?.deleteTranscript === true,
    timeoutMs: options?.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
  });
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
  attachmentWorkspaceDir?: string;
  attachmentRelDir?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
  waitForSessionDeletion?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
}): Promise<{ attachmentsRemoved: boolean; sessionDeleted: boolean }> {
  const {
    childSessionKey,
    attachmentWorkspaceDir,
    attachmentRelDir,
    waitForSessionDeletion,
    ...sessionCleanupOptions
  } = params;
  let attachmentsRemoved = true;
  if (attachmentWorkspaceDir && attachmentRelDir) {
    try {
      await cleanupMaterializedSubagentAttachments({
        workspaceDir: attachmentWorkspaceDir,
        relDir: attachmentRelDir,
      });
    } catch {
      attachmentsRemoved = false;
    }
  }
  return {
    attachmentsRemoved,
    sessionDeleted: await (
      waitForSessionDeletion ? waitForProvisionalSessionDeletion : cleanupProvisionalSession
    )(childSessionKey, sessionCleanupOptions),
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
