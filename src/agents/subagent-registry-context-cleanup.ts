import { isFastTestRuntimeEnv } from "../infra/env.js";
import { removeInternalSessionEffectsSession } from "./internal-session-effects.js";
import {
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  emitSubagentEndedHookOnce,
  resolveLifecycleOutcomeFromRunOutcome,
} from "./subagent-registry-completion.js";
import {
  ensureSubagentRegistryPluginRuntimeLoaded,
  resolveSubagentRegistryContextEngine,
  type SubagentRegistryDeps,
} from "./subagent-registry-deps.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

export function createSubagentRegistryContextCleanup(config: {
  deps: () => SubagentRegistryDeps;
  persist: () => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { deps, persist, warn } = config;
  const endedHookInFlightRunIds = new Set<string>();

  async function runContextEngineSubagentEnded(
    params: ContextEngineSubagentEndedParams,
  ): Promise<void> {
    const cfg = deps().getRuntimeConfig();
    await ensureSubagentRegistryPluginRuntimeLoaded({
      config: cfg,
      workspaceDir: params.workspaceDir,
      allowGatewaySubagentBinding: true,
    });
    const engine = await resolveSubagentRegistryContextEngine(cfg, {
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    });
    await engine.onSubagentEnded?.(params);
  }

  async function notifyContextEngineSubagentEnded(
    params: ContextEngineSubagentEndedParams,
  ): Promise<void> {
    try {
      await runContextEngineSubagentEnded(params);
    } catch (err) {
      warn("context-engine onSubagentEnded failed (best-effort)", { err });
    }
  }

  async function finishCollectorContextEngineCleanup(
    params: ContextEngineSubagentEndedParams,
  ): Promise<boolean> {
    try {
      await runContextEngineSubagentEnded(params);
      return true;
    } catch (err) {
      warn("context-engine collector cleanup failed", { err });
      return false;
    }
  }

  async function cleanupCollectorLaunchResources(entry: SubagentRunRecord): Promise<boolean> {
    let internalEffectsRemoved = true;
    try {
      await removeInternalSessionEffectsSession(entry.execution?.transcriptTarget);
    } catch (err) {
      internalEffectsRemoved = false;
      warn("failed to remove collector internal session effects", {
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        err,
      });
    }
    const contextAlreadyEnded = typeof entry.contextEngineCleanupCompletedAt === "number";
    const [attachmentsRemoved, contextEnded] = await Promise.all([
      safeRemoveAttachmentsDir(entry),
      contextAlreadyEnded
        ? true
        : finishCollectorContextEngineCleanup({
            childSessionKey: entry.childSessionKey,
            reason: "deleted",
            agentDir: entry.agentDir,
            workspaceDir: entry.workspaceDir,
          }),
    ]);
    if (!contextAlreadyEnded && contextEnded) {
      entry.contextEngineCleanupCompletedAt = Date.now();
      persist();
    }
    return internalEffectsRemoved && attachmentsRemoved && contextEnded;
  }

  async function terminateAcceptedRestoredCollectorRun(params: {
    entry: SubagentRunRecord;
    gatewayRunId: string;
    timeoutMs: number;
  }): Promise<void> {
    // A restored FIFO slot cannot be released until the accepted Gateway run is
    // definitely stopped; otherwise the group can exceed maxConcurrent.
    for (;;) {
      try {
        await deps().callGateway({
          method: "chat.abort",
          params: { sessionKey: params.entry.childSessionKey, runId: params.gatewayRunId },
          timeoutMs: params.timeoutMs,
        });
        return;
      } catch {
        try {
          await deps().callGateway({
            method: "sessions.delete",
            params: {
              key: params.entry.childSessionKey,
              deleteTranscript: true,
              emitLifecycleHooks: false,
            },
            timeoutMs: params.timeoutMs,
          });
          return;
        } catch {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
            timer.unref?.();
          });
        }
      }
    }
  }

  function suppressAnnounceForSteerRestart(entry?: SubagentRunRecord) {
    return entry?.suppressAnnounceReason === "steer-restart";
  }

  function shouldKeepThreadBindingAfterRun(params: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }) {
    if (params.reason === SUBAGENT_ENDED_REASON_KILLED) {
      return false;
    }
    return params.entry.spawnMode === "session";
  }

  function shouldEmitEndedHookForRun(params: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }) {
    return !shouldKeepThreadBindingAfterRun(params);
  }

  async function emitSubagentEndedHookForRun(params: {
    entry: SubagentRunRecord;
    reason?: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    isCurrent?: () => boolean;
  }) {
    if (params.entry.endedHookEmittedAt) {
      return;
    }
    const cfg = deps().getRuntimeConfig();
    await ensureSubagentRegistryPluginRuntimeLoaded({
      config: cfg,
      workspaceDir: params.entry.workspaceDir,
      allowGatewaySubagentBinding: true,
    });
    if (params.entry.endedHookEmittedAt || params.isCurrent?.() === false) {
      return;
    }
    // Plugin loading yields after the terminal lock is released. Resolve the
    // event from the canonical row only after that boundary so an older callback
    // cannot claim the exactly-once hook with a superseded timeout or error.
    const reason = params.entry.endedReason ?? params.reason ?? SUBAGENT_ENDED_REASON_COMPLETE;
    const outcome =
      reason === SUBAGENT_ENDED_REASON_KILLED
        ? SUBAGENT_ENDED_OUTCOME_KILLED
        : resolveLifecycleOutcomeFromRunOutcome(params.entry.outcome);
    const error = params.entry.outcome?.status === "error" ? params.entry.outcome.error : undefined;
    await emitSubagentEndedHookOnce({
      entry: params.entry,
      reason,
      sendFarewell: params.sendFarewell,
      accountId: params.accountId ?? params.entry.requesterOrigin?.accountId,
      outcome,
      error,
      inFlightRunIds: endedHookInFlightRunIds,
      persist,
    });
  }

  return {
    runContextEngineSubagentEnded,
    notifyContextEngineSubagentEnded,
    cleanupCollectorLaunchResources,
    terminateAcceptedRestoredCollectorRun,
    suppressAnnounceForSteerRestart,
    shouldEmitEndedHookForRun,
    emitSubagentEndedHookForRun,
    reset: () => endedHookInFlightRunIds.clear(),
  };
}
