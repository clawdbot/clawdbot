import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { defaultRuntime } from "../runtime.js";
import { retireSessionMcpRuntimeForSessionKey } from "./agent-bundle-mcp-tools.js";
import { removeInternalSessionEffectsSession } from "./internal-session-effects.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
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
  const { buildSafeLifecycleErrorMeta, maskRunId, maskSessionKey, newerGenerationOwnsSession } =
    common;
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
    const suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(
      cleanupParams.entry,
    );
    const runCleanupTail = (label: string, run: () => Promise<unknown>) => {
      // These best-effort tails can outlive the durable registry transition,
      // but they still mutate session-owned resources and must block snapshots.
      void runWithGatewayIndependentRootWorkAdmission(run).catch((error: unknown) => {
        defaultRuntime.log(
          `[warn] subagent ${label} failed (${cleanupParams.runId}): ${String(error)}`,
        );
      });
    };
    const scheduleCleanupTails = (options: {
      allowRetiredRow: boolean;
      isDeleteCleanup: boolean;
    }) => {
      // Retained bookkeeping requires the exact row. Immediate retirement
      // removes it first, so absence remains ownership only while no newer
      // child generation exists; any replacement blocks the stale cleanup.
      const postBookkeepingEffectsAllowed = () => {
        const current = params.runs.get(cleanupParams.runId);
        const rowOwnershipMatches =
          current === cleanupParams.entry || (options.allowRetiredRow && current === undefined);
        return (
          rowOwnershipMatches &&
          !newerGenerationOwnsSession(cleanupParams.entry) &&
          !shouldSuppressSubagentRecoverySessionEffects(cleanupParams.entry)
        );
      };
      if (postBookkeepingEffectsAllowed() && !cleanupParams.preserveTranscript) {
        runCleanupTail("session cleanup", async () => {
          if (!postBookkeepingEffectsAllowed()) {
            return;
          }
          await removeInternalSessionEffectsSession(cleanupParams.entry.execution.transcriptTarget);
        });
      }
      if (postBookkeepingEffectsAllowed() && cleanupParams.entry.spawnMode !== "session") {
        runCleanupTail("bundle MCP cleanup", async () => {
          if (!postBookkeepingEffectsAllowed()) {
            return;
          }
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
      if (
        !cleanupParams.provisionalKill &&
        postBookkeepingEffectsAllowed() &&
        (options.isDeleteCleanup || !cleanupParams.entry.collect)
      ) {
        runCleanupTail("context-engine cleanup", async () => {
          if (!postBookkeepingEffectsAllowed()) {
            return;
          }
          await params.notifyContextEngineSubagentEnded(
            {
              childSessionKey: cleanupParams.entry.childSessionKey,
              reason: options.isDeleteCleanup ? "deleted" : "completed",
              agentDir: cleanupParams.entry.agentDir,
              workspaceDir: cleanupParams.entry.workspaceDir,
            },
            { isCurrent: postBookkeepingEffectsAllowed },
          );
        });
      }
    };
    if (cleanupParams.provisionalKill) {
      // The provider result or bounded kill reconciliation owns terminal settle.
      // Its kill marker was committed by the caller before reaching this tail.
      scheduleCleanupTails({ allowRetiredRow: false, isDeleteCleanup: false });
      return;
    }
    const isDeleteCleanup = cleanupParams.cleanup === "delete";
    if (isDeleteCleanup) {
      params.clearPendingLifecycleError(cleanupParams.runId);
    }
    if (cleanupParams.entry.collect) {
      // Delete-mode session cleanup already ran before this durable bookkeeping.
      // Preserve only the collector result tombstone for waits and group caps.
      const previousCleanupCompletedAt = cleanupParams.entry.cleanupCompletedAt;
      const previousExecution = cleanupParams.entry.execution;
      const previousRequesterSettleWake = cleanupParams.entry.requesterSettleWake;
      const previousTerminalOwner = cleanupParams.entry.terminalOwner;
      cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
      cleanupParams.entry.requesterSettleWake = undefined;
      if (suppressSessionEffects) {
        cleanupParams.entry.execution = {
          ...cleanupParams.entry.execution,
          restartRecovery: undefined,
          suppressSessionEffects: true,
        };
        cleanupParams.entry.terminalOwner = undefined;
      }
      try {
        params.persistOrThrow(cleanupParams.runId);
      } catch (error) {
        cleanupParams.entry.cleanupCompletedAt = previousCleanupCompletedAt;
        cleanupParams.entry.execution = previousExecution;
        cleanupParams.entry.requesterSettleWake = previousRequesterSettleWake;
        cleanupParams.entry.terminalOwner = previousTerminalOwner;
        throw error;
      }
      scheduleCleanupTails({ allowRetiredRow: false, isDeleteCleanup });
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      return;
    }
    const retireAfterSettle =
      isDeleteCleanup ||
      (cleanupParams.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
        cleanupParams.entry.suppressAnnounceReason !== "killed");
    if (retireAfterSettle) {
      // Reconciled keep-mode kills retire the registry row, not the child session.
      if (!isDeleteCleanup) {
        params.clearPendingLifecycleError(cleanupParams.runId);
      }
      if (cleanupParams.skipRequesterSettleWake) {
        params.runs.delete(cleanupParams.runId);
        try {
          params.persistOrThrow(cleanupParams.runId);
        } catch (error) {
          params.runs.set(cleanupParams.runId, cleanupParams.entry);
          throw error;
        }
        scheduleCleanupTails({ allowRetiredRow: true, isDeleteCleanup });
        retryDeferredCompletedAnnounces(cleanupParams.runId);
        return;
      }
      persistRequesterSettleWakePending(cleanupParams.entry, {
        cleanupCompletedAt: cleanupParams.completedAt,
        retireAfterSettle: true,
        retireInterruptedRecovery: suppressSessionEffects,
      });
      // The settle wake may synchronously retire this durably marked row before
      // the detached tails start. Absence is still stale-safe because any
      // replacement row or newer child generation rejects the cleanup.
      scheduleCleanupTails({ allowRetiredRow: true, isDeleteCleanup });
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      scheduleRequesterSettleWake(cleanupParams.runId, cleanupParams.entry);
      return;
    }
    if (!cleanupParams.skipRequesterSettleWake) {
      persistRequesterSettleWakePending(cleanupParams.entry, {
        cleanupCompletedAt: cleanupParams.completedAt,
        retireInterruptedRecovery: suppressSessionEffects,
      });
    } else {
      const previousCleanupCompletedAt = cleanupParams.entry.cleanupCompletedAt;
      const previousExecution = cleanupParams.entry.execution;
      const previousTerminalOwner = cleanupParams.entry.terminalOwner;
      cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
      if (suppressSessionEffects) {
        cleanupParams.entry.execution = {
          ...cleanupParams.entry.execution,
          restartRecovery: undefined,
          suppressSessionEffects: true,
        };
        cleanupParams.entry.terminalOwner = undefined;
      }
      try {
        params.persistOrThrow(cleanupParams.runId);
      } catch (error) {
        cleanupParams.entry.cleanupCompletedAt = previousCleanupCompletedAt;
        cleanupParams.entry.execution = previousExecution;
        cleanupParams.entry.terminalOwner = previousTerminalOwner;
        throw error;
      }
    }
    scheduleCleanupTails({ allowRetiredRow: false, isDeleteCleanup });
    retryDeferredCompletedAnnounces(cleanupParams.runId);
    if (!cleanupParams.skipRequesterSettleWake) {
      scheduleRequesterSettleWake(cleanupParams.runId, cleanupParams.entry);
    }
  };
  return { completeCleanupBookkeeping };
}
