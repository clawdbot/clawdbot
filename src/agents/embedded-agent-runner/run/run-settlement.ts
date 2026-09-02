/** Publishes committed run accounting before retiring its runtime resources. */
import { incrementCompactionCount } from "../../../auto-reply/reply/session-updates.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { getAdmittedRunDelegatedAuthority } from "../../admitted-run-context.js";
import {
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "../../agent-bundle-mcp-tools.js";
import type { ContextEngineLogicalTurnLease } from "../../harness/context-engine-logical-turn.js";
import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";
import { log } from "../logger.js";
import { clearProviderPromptState } from "../provider-prompt-state.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import type { EmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { CompactionAccountingFact } from "./internal-params.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

type SessionPromptState = ReturnType<typeof createEmbeddedRunSessionPromptState>;

export async function settleEmbeddedRun(input: {
  runInput: Pick<PreparedEmbeddedRunInput, "runParams" | "progressController">;
  runtime: Pick<
    Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>,
    "admittedRunContext" | "stopRuntimeAuthRefreshTimer"
  >;
  compaction: {
    state: Pick<EmbeddedRunContextRecoveryState, "autoCompactionCount" | "currentContextSnapshot">;
    session: Pick<SessionPromptState, "committedCompactionSuccessor" | "sessionWriterFence">;
    originalTarget: NonNullable<SessionPromptState["sessionTarget"]>;
    durable: boolean;
    authority: ReturnType<typeof getAdmittedRunDelegatedAuthority>;
  };
  ownedContextEngineLease?: Pick<ContextEngineLogicalTurnLease, "dispose">;
}): Promise<void> {
  const { runInput, runtime, compaction, ownedContextEngineLease } = input;
  const params = runInput.runParams;
  // Publish committed bookkeeping before cleanup can throw or cancellation closes the caller.
  // A returned model/session id is never a substitute for the accepted host target.
  const committed = compaction.session.committedCompactionSuccessor;
  const originalWriter = compaction.session.sessionWriterFence;
  const target = committed?.sessionTarget ?? compaction.originalTarget;
  const counts = {
    count: compaction.state.autoCompactionCount,
    currentContextSnapshot:
      compaction.state.currentContextSnapshot ??
      (compaction.state.autoCompactionCount > 0 ? { tokens: undefined } : undefined),
  };
  // Native runtimes can return usage without ordered context events. Carry their
  // claimed writer without inventing a context observation that would override it.
  const fact: CompactionAccountingFact | undefined =
    compaction.durable &&
    (committed || originalWriter) &&
    target.agentId &&
    target.sessionId &&
    target.sessionKey &&
    target.storePath
      ? {
          kind: "durable",
          ...counts,
          ...(committed?.previousSessionId !== undefined
            ? { previousSessionId: committed.previousSessionId }
            : {}),
          target: {
            agentId: target.agentId,
            sessionId: committed?.entry.sessionId ?? target.sessionId,
            sessionKey: target.sessionKey,
            storePath: target.storePath,
            lifecycleRevision: committed
              ? committed.entry.lifecycleRevision
              : originalWriter?.expectedLifecycleRevision,
            activeWriterRunId: committed
              ? committed.entry.activeWriterRunId
              : originalWriter?.expectedWriterRunId,
          },
        }
      : counts.count > 0 || counts.currentContextSnapshot
        ? { kind: "presentation-only", ...counts }
        : undefined;
  if (params.onCompactionAccounting) {
    params.onCompactionAccounting(fact);
  } else if (fact?.kind === "durable" && fact.count > 0) {
    try {
      await incrementCompactionCount({
        ...fact.target,
        expectedSession: fact.target,
        amount: fact.count,
        tokensAfter: fact.currentContextSnapshot?.tokens,
        // Cancellation preserves bookkeeping, but a reused run id cannot lend a new admission.
        authorize: () =>
          compaction.authority !== undefined &&
          getAdmittedRunDelegatedAuthority(runtime.admittedRunContext) === compaction.authority,
      });
    } catch (error) {
      log.warn(`compaction accounting failed: ${formatErrorMessage(error)}`);
    }
  }
  if (params.isFinalFallbackAttempt !== false) {
    await runInput.progressController.maybeEmitFastModeAutoResetBestEffort();
  }
  forgetPromptBuildDrainCacheForRun(params.runId);
  clearProviderPromptState(params.runId);
  runtime.stopRuntimeAuthRefreshTimer();
  if (ownedContextEngineLease) {
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "context-engine-dispose",
      log,
      cleanup: async () => {
        await ownedContextEngineLease.dispose();
      },
    });
  }
  if (params.cleanupBundleMcpOnRunEnd === true) {
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "bundle-mcp-retire",
      log,
      cleanup: async () => {
        const onError = (errorLocal: unknown, sessionId: string) => {
          log.warn(
            `bundle-mcp cleanup failed after run for ${sessionId}: ${formatErrorMessage(errorLocal)}`,
          );
        };
        const retiredBySessionKey = await retireSessionMcpRuntimeForSessionKey({
          sessionKey: params.sessionKey,
          reason: "embedded-run-end",
          // MCP App views hold bounded leases so their bridge can remain
          // usable after a one-shot gateway run returns.
          preserveActiveLeases: true,
          onError,
        });
        if (!retiredBySessionKey) {
          await retireSessionMcpRuntime({
            sessionId: params.sessionId,
            reason: "embedded-run-end",
            preserveActiveLeases: true,
            onError,
          });
        }
      },
    });
  }
}
