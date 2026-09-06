/** Cleanup helpers for failed ACP spawn flows. */
import {
  callInProcessGatewayTool,
  getInProcessGatewayToolContext,
  runWithGatewayToolCleanupContext,
} from "../../agents/tools/in-process-gateway.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { isAcpOwnerRepairRequired } from "./manager.runtime-owner.js";

/** Roll back only the provisional session owned by this failed spawn. */
export async function cleanupFailedAcpSpawn(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  sessionEntry?: SessionEntry;
  deleteTranscript: boolean;
  closeRuntimeOnFailure?: () => Promise<void>;
}): Promise<void> {
  if (!params.sessionEntry) {
    return;
  }
  const { sessionId, lifecycleRevision } = params.sessionEntry;
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const assertCurrent = () => {
    const current = loadSessionEntry({
      storePath,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      clone: false,
    });
    if (current?.sessionId !== sessionId || current?.lifecycleRevision !== lifecycleRevision) {
      throw new Error(`ACP provisional session ${params.sessionKey} changed before cleanup.`);
    }
  };
  let deletionStarted = false;
  const cancellation = new AbortController();
  try {
    await runWithGatewayToolCleanupContext(async () => {
      assertCurrent();
      const context = getInProcessGatewayToolContext();
      if (!context) {
        throw new Error("ACP provisional cleanup Gateway is unavailable.");
      }
      await callInProcessGatewayTool(
        "sessions.delete",
        {
          key: params.sessionKey,
          agentId: params.agentId,
          expectedSessionId: sessionId,
          ...(lifecycleRevision ? { expectedLifecycleRevision: lifecycleRevision } : {}),
          deleteTranscript: params.deleteTranscript,
          emitLifecycleHooks: false,
        },
        // New /acp rows can have no revision yet. The private guard preserves
        // exact absence as well as recorded revisions throughout deletion.
        {
          sessionMutationCommitGuard: () => {
            cancellation.signal.throwIfAborted();
            context.requestEntryLifetime?.signal.throwIfAborted();
            assertCurrent();
            // The router calls this after lazy preparation, before handler entry.
            deletionStarted = true;
          },
          signal: cancellation.signal,
          timeoutMs: 10_000,
        },
      );
    });
  } catch (error) {
    // A retired owner cannot dispatch cleanup. Retain its existing local handle
    // release, but never repeat a close after canonical deletion has started.
    if (!deletionStarted) {
      // A timed-out preparation may still settle; fence its late handler entry.
      cancellation.abort(error);
    }
    if (!deletionStarted && params.closeRuntimeOnFailure) {
      await runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [params.sessionKey, sessionId],
        run: async () => {
          assertCurrent();
          await params.closeRuntimeOnFailure!();
        },
      }).catch((releaseError: unknown) => {
        if (isAcpOwnerRepairRequired(releaseError)) {
          throw releaseError;
        }
        logVerbose(`acp-spawn: provisional runtime cleanup failed: ${String(releaseError)}`);
      });
    }
    logVerbose(`acp-spawn: provisional session cleanup failed: ${String(error)}`);
  }
}
