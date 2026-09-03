import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import {
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { shouldDeferTerminalCleanupForUnconfirmedChild } from "./subagent-registry-cleanup.js";
import {
  emitSubagentEndedHookOnce,
  resolveLifecycleOutcomeFromRunOutcome,
} from "./subagent-registry-completion.js";
import {
  loadSubagentRegistryPluginRuntimeHandle,
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
  persist: (...runIds: string[]) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { deps, persist, warn } = config;
  const endedHookInFlightRunIds = new Set<string>();

  async function runContextEngineSubagentEnded(
    params: ContextEngineSubagentEndedParams,
    options?: { isCurrent?: () => boolean },
  ): Promise<void> {
    const cfg = deps().getRuntimeConfig();
    const registry = await loadSubagentRegistryPluginRuntimeHandle({
      config: cfg,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      allowGatewaySubagentBinding: true,
    });
    await withPluginRuntimeRegistryScope(registry, async () => {
      const engine = await resolveSubagentRegistryContextEngine(cfg, {
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      });
      if (options?.isCurrent?.() === false) {
        return;
      }
      await engine.onSubagentEnded?.(params);
    });
  }

  async function tryContextEngineSubagentEnded(
    params: ContextEngineSubagentEndedParams,
    warning: string,
    options?: { isCurrent?: () => boolean },
  ): Promise<boolean> {
    try {
      await runContextEngineSubagentEnded(params, options);
      return true;
    } catch (err) {
      warn(warning, { err });
      return false;
    }
  }

  async function notifyContextEngineSubagentEnded(
    params: ContextEngineSubagentEndedParams,
    options?: { isCurrent?: () => boolean },
  ): Promise<void> {
    await tryContextEngineSubagentEnded(
      params,
      "context-engine onSubagentEnded failed (best-effort)",
      options,
    );
  }

  async function cleanupCollectorLaunchResources(
    entry: SubagentRunRecord,
    options?: { isCurrent?: () => boolean },
  ): Promise<boolean> {
    const isCurrent = () => options?.isCurrent?.() !== false;
    let internalEffectsRemoved = true;
    if (isCurrent()) {
      try {
        await removeInternalSessionEffectsSession(entry.execution.transcriptTarget);
      } catch (err) {
        internalEffectsRemoved = false;
        warn("failed to remove collector internal session effects", {
          runId: entry.runId,
          childSessionKey: entry.childSessionKey,
          err,
        });
      }
    }
    const contextAlreadyEnded = typeof entry.contextEngineCleanupCompletedAt === "number";
    const attachmentsRemoved = await safeRemoveAttachmentsDir(entry);
    if (!isCurrent()) {
      return false;
    }
    const contextEnded = contextAlreadyEnded
      ? true
      : await tryContextEngineSubagentEnded(
          {
            childSessionKey: entry.childSessionKey,
            reason: "deleted",
            agentDir: entry.agentDir,
            workspaceDir: entry.workspaceDir,
          },
          "context-engine collector cleanup failed",
          options,
        );
    if (!contextAlreadyEnded && contextEnded && isCurrent()) {
      entry.contextEngineCleanupCompletedAt = Date.now();
      persist(entry.runId);
    }
    return internalEffectsRemoved && attachmentsRemoved && contextEnded && isCurrent();
  }

  function shouldEmitEndedHookForRun(params: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }) {
    return params.reason === SUBAGENT_ENDED_REASON_KILLED || params.entry.spawnMode !== "session";
  }

  async function emitSubagentEndedHookForRun(params: {
    entry: SubagentRunRecord;
    reason?: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    isCurrent?: () => boolean;
  }) {
    // Gate the plugin-visible completion hook here rather than at each caller:
    // three paths reach it (terminal effects, the completion-message announce
    // tail, and the suspended-delivery give-up), and `endedHookEmittedAt` below
    // is a persisted exactly-once marker, so a single premature emit from ANY of
    // them permanently consumes the run's one chance to report the real ending.
    // `subagent_ended` is documented as "the child completed" and channel
    // plugins act on it destructively — Discord unbinds the child's thread
    // bindings, Feishu unbinds its session binding — so emitting it for a child
    // whose stop was never observed tears down routing for a possibly-live
    // child AND makes the truthful hook unsendable. Promotion re-enters these
    // paths with an observed disposition, which is where the hook is emitted.
    if (shouldDeferTerminalCleanupForUnconfirmedChild(params.entry)) {
      return;
    }
    if (params.entry.endedHookEmittedAt) {
      return;
    }
    // Loading and entering plugin scope are part of the best-effort hook boundary.
    try {
      const cfg = deps().getRuntimeConfig();
      const registry = await loadSubagentRegistryPluginRuntimeHandle({
        config: cfg,
        ...(params.entry.workspaceDir ? { workspaceDir: params.entry.workspaceDir } : {}),
        allowGatewaySubagentBinding: true,
      });
      await withPluginRuntimeRegistryScope(registry, async () => {
        if (
          params.entry.endedHookEmittedAt ||
          params.isCurrent?.() === false ||
          shouldDeferTerminalCleanupForUnconfirmedChild(params.entry)
        ) {
          return;
        }
        // Plugin loading yields after the terminal lock is released. Resolve the
        // event from the canonical row only after that boundary so an older callback
        // cannot claim the exactly-once hook with a superseded timeout or error —
        // including a row that became `child-unconfirmed` across the yield.
        const reason = params.entry.endedReason ?? params.reason ?? SUBAGENT_ENDED_REASON_COMPLETE;
        const outcome =
          reason === SUBAGENT_ENDED_REASON_KILLED
            ? SUBAGENT_ENDED_OUTCOME_KILLED
            : resolveLifecycleOutcomeFromRunOutcome(params.entry.execution.outcome);
        const error =
          params.entry.execution.outcome?.status === "error"
            ? params.entry.execution.outcome.error
            : undefined;
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
      });
    } catch (err) {
      warn("subagent_ended hook failed (best-effort)", { phase: "plugin-runtime", err });
    }
  }

  return {
    runContextEngineSubagentEnded,
    notifyContextEngineSubagentEnded,
    cleanupCollectorLaunchResources,
    suppressAnnounceForSteerRestart: (entry?: SubagentRunRecord) =>
      entry?.suppressAnnounceReason === "steer-restart",
    shouldEmitEndedHookForRun,
    emitSubagentEndedHookForRun,
    reset: () => endedHookInFlightRunIds.clear(),
  };
}
