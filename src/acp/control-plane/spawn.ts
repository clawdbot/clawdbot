import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { getAcpSessionManager } from "./manager.js";

export type AcpSpawnRuntimeCloseHandle = {
  runtime: {
    close: (params: {
      handle: { sessionKey: string; backend: string; runtimeSessionName: string };
      reason: string;
    }) => Promise<void>;
  };
  handle: { sessionKey: string; backend: string; runtimeSessionName: string };
};

export async function cleanupFailedAcpSpawn(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  shouldDeleteSession: boolean;
  deleteTranscript: boolean;
  runtimeCloseHandle?: AcpSpawnRuntimeCloseHandle;
}): Promise<void> {
  if (params.runtimeCloseHandle) {
    await params.runtimeCloseHandle.runtime
      .close({
        handle: params.runtimeCloseHandle.handle,
        reason: "spawn-failed",
      })
      .catch((err) => {
        logVerbose(
          `acp-spawn: runtime cleanup close failed for ${params.sessionKey}: ${String(err)}`,
        );
      });
  }

  const acpManager = getAcpSessionManager();
  await acpManager
    .closeSession({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      reason: "spawn-failed",
      allowBackendUnavailable: true,
      requireAcpSession: false,
    })
    .catch((err) => {
      logVerbose(
        `acp-spawn: manager cleanup close failed for ${params.sessionKey}: ${String(err)}`,
      );
    });

  await getSessionBindingService()
    .unbind({
      targetSessionKey: params.sessionKey,
      reason: "spawn-failed",
    })
    .catch((err) => {
      logVerbose(
        `acp-spawn: binding cleanup unbind failed for ${params.sessionKey}: ${String(err)}`,
      );
    });

  if (!params.shouldDeleteSession) {
    return;
  }
  await callGateway({
    method: "sessions.delete",
    params: {
      key: params.sessionKey,
      deleteTranscript: params.deleteTranscript,
      emitLifecycleHooks: false,
    },
    timeoutMs: 10_000,
  }).catch(() => {
    // Best-effort cleanup only.
  });
}
