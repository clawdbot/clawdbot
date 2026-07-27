import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { defaultRuntime } from "../runtime.js";
import { retireSessionMcpRuntimeForSessionKey } from "./agent-bundle-mcp-tools.js";
import { removeInternalSessionEffectsSession } from "./internal-session-effects.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { createSubagentRegistryLifecycleCommon } from "./subagent-registry-lifecycle-common.js";
import type { SubagentRegistryLifecycleParams } from "./subagent-registry-lifecycle-contracts.js";
import type { createSubagentRegistryLifecycleRequesterWake } from "./subagent-registry-lifecycle-requester-wake.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function createSubagentRegistryLifecycleBookkeeping(
  params: SubagentRegistryLifecycleParams,
  common: ReturnType<typeof createSubagentRegistryLifecycleCommon>,
  requesterWake: ReturnType<typeof createSubagentRegistryLifecycleRequesterWake>,
  retryDeferredCompletedAnnounces: (excludeRunId?: string) => void,
) {
  const { buildSafeLifecycleErrorMeta, maskRunId, maskSessionKey } = common;
  const { persistRequesterSettleWakePending, scheduleRequesterSettleWake } = requesterWake;

  const completeCleanupBookkeeping = (cleanupParams: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
    preserveTranscript?: boolean;
    provisionalKill?: boolean;
    // Set by the suspended-delivery discard path: the settle wake already ran
    // when the delivery was suspended, so a discard hours later must not
    // re-evaluate the requester drain.
    skipRequesterSettleWake?: boolean;
  }) => {
    const runCleanupTail = (label: string, run: () => Promise<unknown>) => {
      // These best-effort tails can outlive the durable registry transition,
      // but they still mutate session-owned resources and must block snapshots.
      void runWithGatewayIndependentRootWorkAdmission(run).catch((error: unknown) => {
        defaultRuntime.log(
          `[warn] subagent ${label} failed (${cleanupParams.runId}): ${String(error)}`,
        );
      });
    };
    if (!cleanupParams.preserveTranscript) {
      runCleanupTail("session cleanup", async () => {
        await removeInternalSessionEffectsSession(cleanupParams.entry.execution?.transcriptTarget);
      });
    }
    if (cleanupParams.entry.spawnMode !== "session") {
      runCleanupTail("bundle MCP cleanup", async () => {
        await retireSessionMcpRuntimeForSessionKey({
          sessionKey: cleanupParams.entry.childSessionKey,
          reason: "subagent-run-cleanup",
          preserveActiveLeases: true,
          onError: (error, sessionId) => {
            params.warn("failed to retire subagent bundle MCP runtime", {
              error: buildSafeLifecycleErrorMeta(error),
              sessionId,
              runId: maskRunId(cleanupParams.runId),
              childSessionKey: maskSessionKey(cleanupParams.entry.childSessionKey),
            });
          },
        });
      });
    }
    if (cleanupParams.provisionalKill) {
      // The provider result or bounded kill reconciliation owns terminal settle.
      // Waking here could tell the requester to finalize while the child still runs.
      return;
    }
    if (cleanupParams.entry.collect) {
      // Delete-mode session cleanup already ran before this durable bookkeeping.
      // Preserve only the collector result tombstone for waits and group caps.
      if (cleanupParams.cleanup === "delete") {
        params.clearPendingLifecycleError(cleanupParams.runId);
        runCleanupTail("context-engine cleanup", async () => {
          await params.notifyContextEngineSubagentEnded({
            childSessionKey: cleanupParams.entry.childSessionKey,
            reason: "deleted",
            agentDir: cleanupParams.entry.agentDir,
            workspaceDir: cleanupParams.entry.workspaceDir,
          });
        });
      }
      cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
      cleanupParams.entry.requesterSettleWake = undefined;
      params.persist();
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      return;
    }
    if (cleanupParams.cleanup === "delete") {
      params.clearPendingLifecycleError(cleanupParams.runId);
      runCleanupTail("context-engine cleanup", async () => {
        await params.notifyContextEngineSubagentEnded({
          childSessionKey: cleanupParams.entry.childSessionKey,
          reason: "deleted",
          agentDir: cleanupParams.entry.agentDir,
          workspaceDir: cleanupParams.entry.workspaceDir,
        });
      });
      if (cleanupParams.skipRequesterSettleWake) {
        params.runs.delete(cleanupParams.runId);
        params.persist();
        retryDeferredCompletedAnnounces(cleanupParams.runId);
        return;
      }
      persistRequesterSettleWakePending(cleanupParams.entry, {
        cleanupCompletedAt: cleanupParams.completedAt,
        retireAfterSettle: true,
      });
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      scheduleRequesterSettleWake(cleanupParams.runId, cleanupParams.entry);
      return;
    }
    runCleanupTail("context-engine cleanup", async () => {
      await params.notifyContextEngineSubagentEnded({
        childSessionKey: cleanupParams.entry.childSessionKey,
        reason: "completed",
        agentDir: cleanupParams.entry.agentDir,
        workspaceDir: cleanupParams.entry.workspaceDir,
      });
    });
    if (
      cleanupParams.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      cleanupParams.entry.suppressAnnounceReason !== "killed"
    ) {
      // A reconciled killed row has served its tombstone purpose. Retire only
      // the registry record; keep-mode still preserves the child session.
      params.clearPendingLifecycleError(cleanupParams.runId);
      if (cleanupParams.skipRequesterSettleWake) {
        params.runs.delete(cleanupParams.runId);
        params.persist();
        retryDeferredCompletedAnnounces(cleanupParams.runId);
        return;
      }
      persistRequesterSettleWakePending(cleanupParams.entry, {
        cleanupCompletedAt: cleanupParams.completedAt,
        retireAfterSettle: true,
      });
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      scheduleRequesterSettleWake(cleanupParams.runId, cleanupParams.entry);
      return;
    }
    if (!cleanupParams.skipRequesterSettleWake) {
      persistRequesterSettleWakePending(cleanupParams.entry, {
        cleanupCompletedAt: cleanupParams.completedAt,
      });
    } else {
      cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
      params.persist();
    }
    retryDeferredCompletedAnnounces(cleanupParams.runId);
    if (!cleanupParams.skipRequesterSettleWake) {
      scheduleRequesterSettleWake(cleanupParams.runId, cleanupParams.entry);
    }
  };
  return { completeCleanupBookkeeping };
}
