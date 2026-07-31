import type { createSubagentRegistryLifecycleCleanupBase } from "./subagent-registry-lifecycle-cleanup-base.js";
import type { createSubagentRegistryLifecycleCleanup } from "./subagent-registry-lifecycle-cleanup.js";
import type { createSubagentRegistryLifecycleCommon } from "./subagent-registry-lifecycle-common.js";
import { loadCleanupBrowserSessionsForLifecycleEnd } from "./subagent-registry-lifecycle-completion-support.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
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
    if (!completeParams.triggerCleanup || suppressedForSteerRestart) {
      return;
    }

    // Browser tab close is best-effort and may wait for a real browser service.
    // Keep it on its own admitted continuation so MCP retirement and completion
    // delivery do not inherit that external latency.
    if (entry.browserCleanupDispatchedAt === undefined) {
      entry.browserCleanupDispatchedAt = Date.now();
      void runWithGatewayIndependentRootWorkContinuation(async () => {
        try {
          const cleanupBrowserSessions =
            params.cleanupBrowserSessionsForLifecycleEnd ??
            (await loadCleanupBrowserSessionsForLifecycleEnd());
          await cleanupBrowserSessions({
            sessionKeys: [entry.childSessionKey],
            ownerId: completeParams.runId,
            onWarn: (msg) => params.warn(msg, { runId: entry.runId }),
          });
        } catch (error) {
          params.warn("failed to cleanup browser sessions for completed subagent", {
            error: buildSafeLifecycleErrorMeta(error),
            runId: maskRunId(completeParams.runId),
            childSessionKey: maskSessionKey(entry.childSessionKey),
          });
        }
      }).catch((error: unknown) => {
        params.warn("failed to admit browser cleanup for completed subagent", {
          error: buildSafeLifecycleErrorMeta(error),
          runId: maskRunId(completeParams.runId),
          childSessionKey: maskSessionKey(entry.childSessionKey),
        });
      });
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
    if (newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }

    if (isProvisionalKill) {
      // Browser and MCP resources can close immediately, but completion delivery
      // waits for the provider result or the killed tombstone reconciliation.
      return;
    }

    startSubagentAnnounceCleanupFlow(completeParams.runId, entry);
  };

  return { complete };
}
