import type { callGateway } from "../../../gateway/call.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.types.js";
import { deleteSubagentSessionForCleanup } from "../registry/subagent-session-cleanup.js";
import { removeSubagentAttachmentsDir } from "./subagent-attachments.js";
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

function isClosedAbortResponse(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const result = response as { aborted?: unknown; runIds?: unknown };
  return result.aborted === false && Array.isArray(result.runIds);
}

export async function retrySubagentCleanup(
  attempt: () => boolean | Promise<boolean>,
  options: { shouldRetry: () => boolean; onError?: (error: unknown) => void },
): Promise<boolean> {
  for (;;) {
    try {
      if (await attempt()) {
        return true;
      }
    } catch (error) {
      options.onError?.(error);
    }
    if (!options.shouldRetry()) {
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
  allowSessionDelete?: boolean;
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

export async function cleanupFailedSpawnBeforeAgentStart(params: {
  childSessionKey: string;
  attachmentAbsDir?: string;
  attachmentRootDir?: string;
  attachmentSandboxFsBridge?: SandboxFsBridge;
  attachmentSandboxDir?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  priorSessionCleanup?: "deleted" | "changed";
}): Promise<{
  attachmentsRemoved: boolean;
  sessionCleanupComplete: boolean;
  sessionDeleted: boolean;
}> {
  const {
    childSessionKey,
    attachmentAbsDir,
    attachmentRootDir,
    attachmentSandboxFsBridge,
    attachmentSandboxDir,
    priorSessionCleanup,
    ...sessionCleanupOptions
  } = params;
  let attachmentsRemoved = true;
  if (attachmentAbsDir && attachmentRootDir) {
    attachmentsRemoved = await removeSubagentAttachmentsDir({
      rootDir: attachmentRootDir,
      absDir: attachmentAbsDir,
      sandboxFsBridge: attachmentSandboxFsBridge,
      sandboxDir: attachmentSandboxDir,
    });
  }
  const sessionCleanup =
    priorSessionCleanup ??
    (await requestProvisionalSessionCleanup(childSessionKey, sessionCleanupOptions));
  return {
    attachmentsRemoved,
    sessionCleanupComplete: sessionCleanup !== "failed",
    sessionDeleted: sessionCleanup === "deleted",
  };
}

export async function terminateAcceptedSubagentRun(params: {
  childSessionKey: string;
  gatewayRunId: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  allowSessionDelete: boolean;
  callGateway?: GatewayCall;
  timeoutMs?: number;
  shouldRetry: () => boolean;
  onSessionCleanup?: (outcome: "deleted" | "changed") => void;
}): Promise<boolean> {
  const call = params.callGateway ?? callSubagentGateway;
  const timeoutMs = params.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS;
  return await retrySubagentCleanup(
    async () => {
      try {
        const response = await call({
          method: "chat.abort",
          params: { sessionKey: params.childSessionKey, runId: params.gatewayRunId },
          timeoutMs,
        });
        if (isMatchingAbortResponse(response, params.gatewayRunId)) {
          return true;
        }
        if (!params.allowSessionDelete && isClosedAbortResponse(response)) {
          return true;
        }
      } catch {
        // Fall through to exact-session deletion.
      }
      if (!params.allowSessionDelete) {
        return false;
      }
      const cleanup = await requestProvisionalSessionCleanup(params.childSessionKey, {
        deleteTranscript: true,
        expectedSessionId: params.expectedSessionId,
        expectedLifecycleRevision: params.expectedLifecycleRevision,
        callGateway: call,
        timeoutMs,
      });
      // A changed lifecycle proves the accepted run no longer owns this session.
      if (cleanup !== "failed") {
        params.onSessionCleanup?.(cleanup);
      }
      return cleanup !== "failed";
    },
    { shouldRetry: params.shouldRetry },
  );
}

/** Terminate once under a durable owner and hand failures to its scheduler. */
export async function terminateClaimedAcceptedSubagentRun(params: {
  childSessionKey: string;
  callGateway?: GatewayCall;
  timeoutMs?: number;
  claimed: {
    kind: "launch" | "steer" | "descendant-wake";
    phase: "attempted" | "termination-pending";
    gatewayRunId: string;
    lifecycleGeneration: string;
    expectedSessionId?: string;
    expectedLifecycleRevision?: string;
  };
  markPending: () => boolean | Promise<boolean>;
  complete: (sessionCleanupOutcome?: "deleted" | "changed") => void | Promise<void>;
  schedule: () => void | Promise<void>;
}): Promise<boolean> {
  if (!(await params.markPending())) {
    await params.schedule();
    return false;
  }
  let sessionCleanupOutcome: "deleted" | "changed" | undefined;
  if (
    await terminateAcceptedSubagentRun({
      childSessionKey: params.childSessionKey,
      gatewayRunId: params.claimed.gatewayRunId,
      expectedSessionId: params.claimed.expectedSessionId,
      expectedLifecycleRevision: params.claimed.expectedLifecycleRevision,
      callGateway: params.callGateway,
      timeoutMs: params.timeoutMs,
      allowSessionDelete:
        params.claimed.kind === "launch" &&
        Boolean(params.claimed.expectedSessionId && params.claimed.expectedLifecycleRevision),
      shouldRetry: () => false,
      onSessionCleanup: (outcome) => {
        sessionCleanupOutcome = outcome;
      },
    })
  ) {
    try {
      await params.complete(sessionCleanupOutcome);
      return true;
    } catch {
      await params.schedule();
      return false;
    }
  }
  await params.schedule();
  return false;
}
