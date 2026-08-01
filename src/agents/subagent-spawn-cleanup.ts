import { promises as fs } from "node:fs";
import type { callGateway } from "../gateway/call.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";

const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
type GatewayCall = (options: Parameters<typeof callGateway>[0]) => Promise<unknown>;

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
  callGateway?: GatewayCall;
  timeoutMs?: number;
};

export async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: SessionCleanupOptions,
): Promise<boolean> {
  try {
    await (options?.callGateway ?? callSubagentGateway)({
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

async function waitForProvisionalSessionDeletion(
  childSessionKey: string,
  options?: SessionCleanupOptions,
): Promise<void> {
  await retrySubagentCleanup(() => cleanupProvisionalSession(childSessionKey, options));
}

export async function cleanupFailedSpawnBeforeAgentStart(params: {
  childSessionKey: string;
  attachmentAbsDir?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
  waitForSessionDeletion?: boolean;
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
  };
  if (params.waitForSessionDeletion) {
    await waitForProvisionalSessionDeletion(params.childSessionKey, sessionCleanupOptions);
    return { attachmentsRemoved, sessionDeleted: true };
  }
  return {
    attachmentsRemoved,
    sessionDeleted: await cleanupProvisionalSession(params.childSessionKey, sessionCleanupOptions),
  };
}

export async function terminateAcceptedCollectorRun(params: {
  childSessionKey: string;
  gatewayRunId: string;
  callGateway?: GatewayCall;
  timeoutMs?: number;
}): Promise<void> {
  const call = params.callGateway ?? callSubagentGateway;
  const timeoutMs = params.timeoutMs ?? SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS;
  await retrySubagentCleanup(async () => {
    try {
      await call({
        method: "chat.abort",
        params: { sessionKey: params.childSessionKey, runId: params.gatewayRunId },
        timeoutMs,
      });
      return true;
    } catch {
      return await cleanupProvisionalSession(params.childSessionKey, {
        deleteTranscript: true,
        callGateway: call,
        timeoutMs,
      });
    }
  });
}
