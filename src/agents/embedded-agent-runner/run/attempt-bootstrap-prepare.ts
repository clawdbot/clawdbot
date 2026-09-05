import path from "node:path";
import { isEmbeddedMode } from "../../../infra/embedded-mode.js";
import { buildBootstrapBudgetState, buildBootstrapInjectionStats } from "../../bootstrap-budget.js";
import {
  buildBootstrapContextForFiles,
  hasCompletedBootstrapTurn,
  makeBootstrapWarn,
  resolveBootstrapFilesForRun,
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
  const resolveWorkspaceBootstrapFiles = (workspaceDir: string) =>
    resolveBootstrapFilesForRun({
      workspaceDir,
      config: attempt.config,
      sessionKey: attempt.sessionKey,
      sessionId: attempt.sessionId,
      chatType: attempt.chatType,
      agentId: params.sessionAgentId,
      warn: bootstrapWarn,
      contextMode: attempt.bootstrapContextMode,
      runKind: attempt.bootstrapContextRunKind,
    });
  let completedBootstrapTurn: boolean | undefined;
  const hasCompletedBootstrapTurnForAttempt = async () => {
    completedBootstrapTurn ??= await hasCompletedBootstrapTurn(attempt.sessionTarget);
    return completedBootstrapTurn;
  };
  const resolveBootstrapRouting = (bootstrapFiles?: readonly WorkspaceBootstrapFile[]) =>
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
    });
  const shouldProbeContinuationSkip =
    !suppressAmbientContext &&
    contextInjectionMode === "continuation-skip" &&
    !isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind) &&
    (await hasCompletedBootstrapTurnForAttempt());
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
      return {
        bootstrapFiles: layeredBootstrapFiles,
        contextFiles: buildBootstrapContextForFiles(layeredBootstrapFiles, {
          config: attempt.config,
          agentId: params.sessionAgentId,
          warn: bootstrapWarn,
        }),
      };
    },
  });
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
