import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import type { createSubagentRegistryLifecycleCleanupBase } from "./subagent-registry-lifecycle-cleanup-base.js";
import type { createSubagentRegistryLifecycleCleanup } from "./subagent-registry-lifecycle-cleanup.js";
import type { createSubagentRegistryLifecycleCommon } from "./subagent-registry-lifecycle-common.js";
import { loadCleanupBrowserSessionsForLifecycleEnd } from "./subagent-registry-lifecycle-completion-support.js";
import type { SubagentRegistryLifecycleParams } from "./subagent-registry-lifecycle-contracts.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

export function createSubagentRegistryLifecycleTerminalCleanup(
  params: SubagentRegistryLifecycleParams,
  common: ReturnType<typeof createSubagentRegistryLifecycleCommon>,
  cleanupBase: ReturnType<typeof createSubagentRegistryLifecycleCleanupBase>,
  cleanup: ReturnType<typeof createSubagentRegistryLifecycleCleanup>,
) {
  const { buildSafeLifecycleErrorMeta, maskRunId, maskSessionKey, newerGenerationOwnsSession } =
    common;
  const { isTerminalCallbackCurrent } = cleanupBase;
  const { retireRunModeBundleMcpRuntime, startSubagentAnnounceCleanupFlow } = cleanup;

  const complete = async (args: {
    completeParams: SubagentCompletionRequest;
    entry: SubagentRunRecord;
    isProvisionalKill: boolean;
    retireSupersededSession: (entry: SubagentRunRecord) => Promise<void>;
    suppressedForSteerRestart: boolean;
    suppressSessionEffects: boolean;
    terminalGeneration: number;
  }) => {
    const {
      completeParams,
      entry,
      isProvisionalKill,
      retireSupersededSession,
      suppressedForSteerRestart,
      terminalGeneration,
    } = args;
    let { suppressSessionEffects } = args;
    // Session cleanup belongs to the exact registry row and child generation.
    // A replacement may reuse either the run id or the child session key.
    const isSessionEffectsOwnerCurrent = () =>
      isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration) &&
      !newerGenerationOwnsSession(entry);
    const refreshSessionEffectsSuppression = () => {
      if (
        suppressSessionEffects ||
        !isSessionEffectsOwnerCurrent() ||
        !shouldSuppressSubagentRecoverySessionEffects(entry)
      ) {
        return suppressSessionEffects;
      }
      const previousExecution = entry.execution;
      entry.execution = {
        ...previousExecution,
        suppressSessionEffects: true,
      };
      try {
        params.persistOrThrow(completeParams.runId);
      } catch (error) {
        entry.execution = previousExecution;
        throw error;
      }
      suppressSessionEffects = true;
      return true;
    };
    if (!completeParams.triggerCleanup || suppressedForSteerRestart) {
      return;
    }
    refreshSessionEffectsSuppression();
    if (!isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
      return;
    }
    if (newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }

    // registerSubagentRun fires both an in-process listener and a gateway
    // waitForSubagentCompletion RPC; both can reach this point for the same
    // runId in embedded mode. Dedupe only the browser driver tab-close IPC
    // with a sync check-then-set. The retire + announce tail below must still
    // run for every caller, so a slow or held first browser cleanup cannot
    // strand a duplicate caller's completion behind it.
    if (!suppressSessionEffects && entry.browserCleanupDispatchedAt === undefined) {
      let dispatchedBrowserCleanup = false;
      let cleanupBrowserSessions = params.cleanupBrowserSessionsForLifecycleEnd;
      try {
        cleanupBrowserSessions ??= await loadCleanupBrowserSessionsForLifecycleEnd();
      } catch (error) {
        params.warn("failed to load browser cleanup for completed subagent", {
          error: buildSafeLifecycleErrorMeta(error),
          runId: maskRunId(completeParams.runId),
          childSessionKey: maskSessionKey(entry.childSessionKey),
        });
      }
      if (cleanupBrowserSessions) {
        if (!isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
          return;
        }
        if (newerGenerationOwnsSession(entry)) {
          await retireSupersededSession(entry);
          return;
        }
        if (refreshSessionEffectsSuppression()) {
          return;
        }
        // Claim only when this caller is about to dispatch. A concurrent caller
        // may have claimed while the lazy browser module was loading.
        if (entry.browserCleanupDispatchedAt === undefined) {
          entry.browserCleanupDispatchedAt = Date.now();
          dispatchedBrowserCleanup = true;
          try {
            await cleanupBrowserSessions({
              sessionKeys: [entry.childSessionKey],
              onWarn: (msg) => params.warn(msg, { runId: entry.runId }),
            });
          } catch (error) {
            params.warn("failed to cleanup browser sessions for completed subagent", {
              error: buildSafeLifecycleErrorMeta(error),
              runId: maskRunId(completeParams.runId),
              childSessionKey: maskSessionKey(entry.childSessionKey),
            });
          }
        }
      }
      if (dispatchedBrowserCleanup) {
        if (!isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
          return;
        }
        refreshSessionEffectsSuppression();
        if (newerGenerationOwnsSession(entry)) {
          await retireSupersededSession(entry);
          return;
        }
      }
    }

    if (!suppressSessionEffects) {
      if (!isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
        return;
      }
      if (newerGenerationOwnsSession(entry)) {
        await retireSupersededSession(entry);
        return;
      }
      try {
        await retireRunModeBundleMcpRuntime({
          runId: completeParams.runId,
          entry,
          reason: "subagent-run-complete",
        });
      } catch (error) {
        params.warn("failed to retire subagent bundle MCP runtime after completion", {
          error: buildSafeLifecycleErrorMeta(error),
          runId: maskRunId(completeParams.runId),
          childSessionKey: maskSessionKey(entry.childSessionKey),
        });
      }
      if (!isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
        return;
      }
      refreshSessionEffectsSuppression();
      if (newerGenerationOwnsSession(entry)) {
        await retireSupersededSession(entry);
        return;
      }
    }

    if (isProvisionalKill) {
      // Browser and MCP resources can close immediately, but completion delivery
      // waits for the provider result or the killed tombstone reconciliation.
      return;
    }

    refreshSessionEffectsSuppression();
    startSubagentAnnounceCleanupFlow(completeParams.runId, entry);
  };

  return { complete };
}
