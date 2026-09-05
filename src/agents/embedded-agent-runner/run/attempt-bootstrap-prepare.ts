import path from "node:path";
import { performance } from "node:perf_hooks";
import { isEmbeddedMode } from "../../../infra/embedded-mode.js";
import { buildBootstrapBudgetState, buildBootstrapInjectionStats } from "../../bootstrap-budget.js";
import {
  buildBootstrapContextForFiles,
  hasCompletedBootstrapTurn,
  makeBootstrapWarn,
  resolveBootstrapFilesForRunWithTiming,
  resolveContextInjectionMode,
} from "../../bootstrap-files.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import {
  isPrimaryBootstrapRun,
  resolveWorkspaceBootstrapRouting,
} from "../../bootstrap-routing.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  isWorkspaceBootstrapPending,
  type WorkspaceBootstrapFile,
} from "../../workspace.js";
import { log } from "../logger.js";
import { resolveAttemptBootstrapContext } from "./attempt-context-engine-helpers.js";
import { remapInjectedContextFilesToWorkspace } from "./attempt-setup.js";
import { measureBootstrapSubstage } from "./attempt-stage-timing.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export async function prepareEmbeddedAttemptBootstrap(params: {
  attempt: EmbeddedRunAttemptParams;
  bootstrapWorkspaceDir?: string;
  effectiveWorkspace: string;
  hasReadTool: boolean;
  isRawModelRun: boolean;
  markStage: (name: string) => void;
  resolvedWorkspace: string;
  sessionAgentId: string;
  sessionLabel: string;
}) {
  const { attempt } = params;
  const bootstrapWorkspaceDir = params.bootstrapWorkspaceDir ?? params.resolvedWorkspace;
  // The selected session workspace owns execution. Agent bootstrap identity stays
  // in the configured workspace; execution project instructions layer after it.
  const bootstrapPromptWorkspaceDir =
    bootstrapWorkspaceDir === params.resolvedWorkspace
      ? params.effectiveWorkspace
      : bootstrapWorkspaceDir;
  const suppressAmbientContext =
    params.isRawModelRun || attempt.operation === "settled-tool-finalization";
  const contextInjectionMode = resolveContextInjectionMode(attempt.config, params.sessionAgentId);
  const bootstrapWarn = makeBootstrapWarn({
    sessionLabel: params.sessionLabel,
    workspaceDir: bootstrapWorkspaceDir,
    warn: (message) => log.warn(message),
  });
  // Bootstrap-context can stall the event loop; record per-substage timings so a
  // slow run reports where it spent time instead of a single opaque total.
  const bootstrapContextStartedAt = performance.now();
  const bootstrapContextSubstageTimings: Array<{ name: string; durationMs: number }> = [];
  const recordBootstrapContextSubstage = (name: string, durationMs: number) => {
    bootstrapContextSubstageTimings.push({
      name,
      durationMs: Math.max(0, durationMs),
    });
  };
  const resolveWorkspaceBootstrapFiles = (workspaceDir: string) =>
    resolveBootstrapFilesForRunWithTiming({
      workspaceDir,
      config: attempt.config,
      sessionKey: attempt.sessionKey,
      sessionId: attempt.sessionId,
      chatType: attempt.chatType,
      agentId: params.sessionAgentId,
      warn: bootstrapWarn,
      contextMode: attempt.bootstrapContextMode,
      runKind: attempt.bootstrapContextRunKind,
      onBootstrapSubstageTiming: recordBootstrapContextSubstage,
    });
  let completedBootstrapTurn: boolean | undefined;
  const hasCompletedBootstrapTurnForAttempt = async () => {
    completedBootstrapTurn ??= await hasCompletedBootstrapTurn(attempt.sessionTarget);
    return completedBootstrapTurn;
  };
  const resolveBootstrapRouting = (bootstrapFiles?: readonly WorkspaceBootstrapFile[]) =>
    measureBootstrapSubstage(recordBootstrapContextSubstage, "bootstrap-routing", () =>
      resolveWorkspaceBootstrapRouting({
        isWorkspaceBootstrapPending,
        bootstrapFiles,
        bootstrapContextRunKind: attempt.bootstrapContextRunKind,
        trigger: attempt.trigger,
        sessionKey: attempt.sessionKey,
        isPrimaryRun: isPrimaryBootstrapRun(attempt.sessionKey),
        isCanonicalWorkspace: attempt.isCanonicalWorkspace,
        effectiveWorkspace: params.effectiveWorkspace,
        resolvedWorkspace: bootstrapWorkspaceDir,
        hasBootstrapFileAccess: params.hasReadTool,
      }),
    );
  const shouldProbeContinuation =
    !suppressAmbientContext &&
    contextInjectionMode === "continuation-skip" &&
    !isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind);
  const shouldProbeContinuationSkip = shouldProbeContinuation
    ? await measureBootstrapSubstage(recordBootstrapContextSubstage, "continuation-scan", () =>
        hasCompletedBootstrapTurnForAttempt(),
      )
    : false;
  let preloadedBootstrapFiles: WorkspaceBootstrapFile[] | undefined;
  let bootstrapRouting =
    shouldProbeContinuationSkip || suppressAmbientContext || contextInjectionMode === "never"
      ? await resolveBootstrapRouting()
      : undefined;
  if (
    !suppressAmbientContext &&
    contextInjectionMode !== "never" &&
    (bootstrapRouting === undefined || bootstrapRouting.bootstrapMode === "full")
  ) {
    preloadedBootstrapFiles = await resolveWorkspaceBootstrapFiles(bootstrapWorkspaceDir);
    bootstrapRouting = await resolveBootstrapRouting(preloadedBootstrapFiles);
  }
  bootstrapRouting ??= await resolveBootstrapRouting(preloadedBootstrapFiles);
  const bootstrapMode = bootstrapRouting.bootstrapMode;
  const {
    bootstrapFiles: hookAdjustedBootstrapFiles,
    contextFiles: resolvedContextFiles,
    shouldRecordCompletedBootstrapTurn,
  } = await resolveAttemptBootstrapContext({
    // Raw probes and isolated finalization must not load AGENTS/BOOTSTRAP
    // context even though finalization preserves the settled transcript.
    contextInjectionMode: suppressAmbientContext ? "never" : contextInjectionMode,
    bootstrapContextMode: attempt.bootstrapContextMode,
    bootstrapContextRunKind: attempt.bootstrapContextRunKind ?? "default",
    bootstrapMode,
    hasCompletedBootstrapTurn: hasCompletedBootstrapTurnForAttempt,
    resolveBootstrapContextForRun: async () => {
      const bootstrapFiles =
        preloadedBootstrapFiles ?? (await resolveWorkspaceBootstrapFiles(bootstrapWorkspaceDir));
      const executionAgentsPath = path.join(
        path.resolve(params.resolvedWorkspace),
        DEFAULT_AGENTS_FILENAME,
      );
      const executionProjectFiles =
        bootstrapWorkspaceDir === params.resolvedWorkspace
          ? []
          : (await resolveWorkspaceBootstrapFiles(params.resolvedWorkspace)).filter(
              (file) =>
                file.name === DEFAULT_AGENTS_FILENAME &&
                !file.missing &&
                path.resolve(file.path) === executionAgentsPath,
            );
      const layeredBootstrapFiles = [...bootstrapFiles, ...executionProjectFiles];
      const contextBuildStartedAt = performance.now();
      const contextFiles = buildBootstrapContextForFiles(layeredBootstrapFiles, {
        config: attempt.config,
        agentId: params.sessionAgentId,
        warn: bootstrapWarn,
      });
      recordBootstrapContextSubstage("context-build", performance.now() - contextBuildStartedAt);
      return {
        bootstrapFiles: layeredBootstrapFiles,
        contextFiles,
      };
    },
  });
  const bootstrapContextTotalMs = performance.now() - bootstrapContextStartedAt;
  if (bootstrapContextTotalMs > 2_000) {
    const substages =
      bootstrapContextSubstageTimings.length > 0
        ? bootstrapContextSubstageTimings
            .map((stage) => `${stage.name}:${stage.durationMs.toFixed(1)}ms`)
            .join(",")
        : "none";
    log.warn(
      `[trace:embedded-run] bootstrap-context substages: runId=${attempt.runId} sessionId=${attempt.sessionId} totalMs=${bootstrapContextTotalMs.toFixed(1)} substages=${substages}`,
    );
  }
  params.markStage("bootstrap-context");
  const remappedContextFiles = remapInjectedContextFilesToWorkspace({
    files: resolvedContextFiles,
    sourceWorkspaceDir: bootstrapWorkspaceDir,
    targetWorkspaceDir: bootstrapPromptWorkspaceDir,
  });
  const contextFiles = bootstrapRouting.includeBootstrapInSystemContext
    ? remappedContextFiles
    : remappedContextFiles.filter((file) => !/(^|[\\/])BOOTSTRAP\.md$/iu.test(file.path.trim()));
  const bootstrapInjectionStats = buildBootstrapInjectionStats({
    bootstrapFiles: hookAdjustedBootstrapFiles,
    injectedFiles: contextFiles,
  });
  // Stats retain input order. Reports include suppressed BOOTSTRAP rows; budgets do not.
  const bootstrapBudgetFiles = bootstrapRouting.includeBootstrapInSystemContext
    ? bootstrapInjectionStats
    : bootstrapInjectionStats.filter(
        (_, index) => hookAdjustedBootstrapFiles[index]!.name !== DEFAULT_BOOTSTRAP_FILENAME,
      );
  const bootstrapBudget = buildBootstrapBudgetState({
    config: attempt.config,
    agentId: params.sessionAgentId,
    files: bootstrapBudgetFiles,
    seenSignatures: attempt.bootstrapPromptWarningSignaturesSeen,
    previousSignature: attempt.bootstrapPromptWarningSignature,
  });
  const workspaceNotes: string[] = [];
  if (
    hookAdjustedBootstrapFiles.some(
      (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.missing,
    )
  ) {
    workspaceNotes.push("Reminder: commit your changes in this workspace after edits.");
  }
  if (isEmbeddedMode()) {
    workspaceNotes.push(
      "Running in local embedded mode (no gateway). Most tools work locally. Gateway-dependent tools (canvas, nodes, cron, message, sessions_send, sessions_spawn, gateway) are unavailable. Subagent kill/steer require a gateway. Do not attempt to read gateway-specific files such as sessions.json, gateway.log, or gateway.pid.",
    );
  }

  return {
    ...bootstrapBudget,
    bootstrapMode,
    contextFiles,
    bootstrapInjectionStats,
    shouldRecordCompletedBootstrapTurn,
    workspaceNotes,
  };
}
