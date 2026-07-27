import { promises as fs } from "node:fs";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { callSubagentGateway } from "./subagent-spawn-gateway.js";

const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;

export async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: {
    emitLifecycleHooks?: boolean;
    deleteTranscript?: boolean;
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
      timeoutMs: SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
    });
    return true;
  } catch {
    // Best-effort cleanup only.
    return false;
  }
}

async function waitForProvisionalSessionDeletion(
  childSessionKey: string,
  options?: {
    emitLifecycleHooks?: boolean;
    deleteTranscript?: boolean;
  },
): Promise<void> {
  for (;;) {
    if (await cleanupProvisionalSession(childSessionKey, options)) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
      timer.unref?.();
    });
  }
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
