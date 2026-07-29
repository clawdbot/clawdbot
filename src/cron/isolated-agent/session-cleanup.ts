import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../config/sessions/lifecycle.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronJob } from "../types.js";

const gatewayCallRuntimeLoader = createLazyImportLoader(
  () => import("../../gateway/call.runtime.js"),
);

async function loadGatewayCallRuntime(): Promise<typeof import("../../gateway/call.runtime.js")> {
  return await gatewayCallRuntimeLoader.load();
}

export type CronRunSessionCleanupOutcome =
  | "not-requested"
  | "deleted"
  | "retired"
  | "survived"
  | "changed";

export async function cleanupCronRunSessionAfterRun(params: {
  job: Pick<CronJob, "deleteAfterRun" | "sessionTarget">;
  agentSessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  sessionUpdatedAt: number;
  beforeDelete?: () => void;
  reason: string;
}): Promise<CronRunSessionCleanupOutcome> {
  if (!shouldDeleteCronRunSessionAfterRun(params)) {
    return "not-requested";
  }
  params.beforeDelete?.();
  try {
    const { callGateway } = await loadGatewayCallRuntime();
    const result = await callGateway<{ deleted?: boolean }>({
      method: "sessions.delete",
      params: {
        key: params.agentSessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: params.sessionId,
        expectedLifecycleRevision: params.lifecycleRevision,
        expectedSessionUpdatedAt: params.sessionUpdatedAt,
      },
      timeoutMs: 10_000,
    });
    return result.deleted === true ? "deleted" : "changed";
  } catch (error) {
    if (isSessionChangedGatewayError(error)) {
      return "changed";
    }
    if (params.job.sessionTarget === "isolated") {
      await retireSessionMcpRuntime({
        sessionId: params.sessionId,
        reason: params.reason,
      });
      return "retired";
    }
    // Persistent custom targets survive transport failures. The caller may
    // restore delivery state with the same lifecycle revision as an atomic guard.
    return "survived";
  }
}

function shouldDeleteCronRunSessionAfterRun(params: {
  job: Pick<CronJob, "deleteAfterRun" | "sessionTarget">;
  agentSessionKey: string;
}): boolean {
  return params.job.deleteAfterRun === true && isCronSessionKey(params.agentSessionKey);
}

function isSessionChangedGatewayError(error: unknown): boolean {
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
