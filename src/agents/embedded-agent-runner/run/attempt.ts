/** Orchestrates one embedded-agent attempt from prompt setup through stream result. */
import {
  assertContextEngineHostSupport,
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
} from "../../../context-engine/host-compat.js";
import { resolveContextEngineOwnerPluginId } from "../../../context-engine/registry.js";
import { createBundleLspToolRuntime } from "../../agent-bundle-lsp-runtime.js";
import { materializeBundleMcpToolsForRun } from "../../agent-bundle-mcp-tools.js";
import { AgentRunTerminalOutcomeError } from "../../agent-run-terminal-error.js";
import {
  buildAgentRunTerminalOutcomeFromAttempt,
  mergeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
  type AgentRunAttemptTerminal,
} from "../../agent-run-terminal-outcome.js";
import { resolveAgentDir } from "../../agent-scope.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import {
  clearToolSearchCatalog,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "../../tool-search.js";
import { log } from "../logger.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { runEmbeddedAttemptExecutionPhase } from "./attempt-execution-phase.js";
import type { EmbeddedAttemptExecutionState } from "./attempt-execution-types.js";
import {
  createEmbeddedAttemptExternalAbortController,
  type EmbeddedAttemptAbortStatePort,
} from "./attempt-finalize.js";
import { createEmbeddedAttemptPreparation } from "./attempt-preparation.js";
import { createPromptBuildToolPolicy } from "./attempt-prompt-support.js";
import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import { cleanupEmbeddedAttemptSessionPhase } from "./attempt-session-settle.js";
import {
  queueSessionsYieldInterruptMessage,
  SESSIONS_YIELD_ABORT_REASON,
} from "./attempt-sessions-yield.js";
import {
  prepareEmbeddedAttemptSetup,
  prepareEmbeddedAttemptSkills,
  startEmbeddedAttemptDiagnostics,
  type EmitDiagnosticRunCompleted,
} from "./attempt-setup.js";
import { createEmbeddedRunStageTracker } from "./attempt-stage-timing.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import { measureEmbeddedAgentPreparation } from "./preparation-timing.js";
import { clearToolActivityRun } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const runAbortController = new AbortController();
  const {
    agentCoreThinkingLevel,
    effectiveCwd,
    effectiveFsWorkspaceOnly,
    effectiveWorkspace,
    emitCorePluginToolStageSummary,
    emitPrepStageSummary,
    getCurrentAttemptPluginMetadataSnapshot,
    getProviderRuntimeHandle,
    prepStages,
    proactiveSubagentOrchestration,
    providerThinkingLevel,
    resolvedWorkspace,
    sandbox,
    sandboxSessionKey,
    sessionPermissionRoot,
    sessionPermissionPolicy,
    sessionAgentId,
  } = await measureEmbeddedAgentPreparation(
    "attempt.setup",
    () => prepareEmbeddedAttemptSetup(params),
    {
      config: params.config,
    },
  );

  let restoreSkillEnv: (() => void) | undefined;
  const executionState: EmbeddedAttemptExecutionState = {
    beforeAgentRunBlockedBy: undefined,
    terminal: params.abortSignal?.aborted
      ? { kind: "aborted", source: "external" }
      : { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  const mergeTerminal = (incoming: AgentRunAttemptTerminal) => {
    executionState.terminal = mergeAgentRunAttemptTerminal(executionState.terminal, incoming);
  };
  let emitDiagnosticRunCompleted: EmitDiagnosticRunCompleted | undefined;
  let bundleMcpRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  let bundleLspRuntime: Awaited<ReturnType<typeof createBundleLspToolRuntime>> | undefined;
  let toolSearchCatalogRef: ToolSearchCatalogRef | undefined;
  let toolSearchCatalogApplied = false;
  let runCleanups: Array<(reason: string) => Promise<void>> = [];
  const cleanupEmbeddedPrepResourcesAfterEarlyExit = async () => {
    if (toolSearchCatalogApplied) {
      clearToolSearchCatalog({
        sessionId: params.sessionId,
        sessionKey: sandboxSessionKey,
        agentId: sessionAgentId,
        runId: params.runId,
        catalogRef: toolSearchCatalogRef,
      });
      toolSearchCatalogApplied = false;
    }
    try {
      await bundleMcpRuntime?.dispose();
    } catch {
      /* best-effort */
    } finally {
      bundleMcpRuntime = undefined;
    }
    try {
      await bundleLspRuntime?.dispose();
    } catch {
      /* best-effort */
    } finally {
      bundleLspRuntime = undefined;
    }
  };
  const abortState: EmbeddedAttemptAbortStatePort = {
    markAborted: () =>
      mergeTerminal({
        kind: "aborted",
        source:
          runAbortController.signal.reason === SESSIONS_YIELD_ABORT_REASON
            ? "yield_cleanup"
            : "runtime",
      }),
    markExternalAbort: () => mergeTerminal({ kind: "aborted", source: "external" }),
    markTimedOut: () => mergeTerminal({ kind: "timeout", phase: "prompt", source: "runtime" }),
    markTimedOutDuringCompaction: () =>
      mergeTerminal({ kind: "timeout", phase: "compaction", source: "observation" }),
    markTimedOutDuringToolExecution: () =>
      mergeTerminal({ kind: "timeout", phase: "tool_execution", source: "observation" }),
    readTimedOutDuringCompaction: () =>
      projectAgentRunAttemptTerminal(executionState.terminal).timedOutDuringCompaction,
    setPromptError: (error) => mergeTerminal({ kind: "failed", source: "prompt", error }),
  };
  const externalAbortController = createEmbeddedAttemptExternalAbortController({
    abortSignal: params.abortSignal,
    cleanupAfterEarlyAbort: cleanupEmbeddedPrepResourcesAfterEarlyExit,
    runAbortController,
    runId: params.runId,
    state: abortState,
  });
  const prepare = createEmbeddedAttemptPreparation({
    config: params.config,
    assertCurrent: externalAbortController.throwIfFired,
  });
  try {
    const preparedSkills = await prepare("attempt.skills", () =>
      prepareEmbeddedAttemptSkills({
        attempt: params,
        effectiveWorkspace,
        sandbox,
        sessionAgentId,
      }),
    );
    restoreSkillEnv = preparedSkills.restoreSkillEnv;
    const { codeModeSkills, skillUsagePaths, skillsPrompt, skillsSnapshotForRun } = preparedSkills;
    prepStages.mark("skills");

    const isRawModelRun = params.modelRun === true || params.promptMode === "none";
    if (isRawModelRun && log.isEnabled("debug")) {
      log.debug(
        `raw model run enabled: modelRun=${params.modelRun === true} promptMode=${params.promptMode ?? "unset"}`,
      );
    }
    const activeContextEngine = isRawModelRun ? undefined : params.contextEngine;
    if (activeContextEngine && activeContextEngine.info.id !== "legacy") {
      assertContextEngineHostSupport({
        contextEngine: activeContextEngine,
        operation: "agent-run",
        host: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      });
    }
    const resolveActiveContextEnginePluginId = () =>
      resolveContextEngineOwnerPluginId(activeContextEngine);
    const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
    const { diagnosticTrace, runTrace, emitCompleted } = startEmbeddedAttemptDiagnostics(params);
    emitDiagnosticRunCompleted = emitCompleted;
    const corePluginToolStages = createEmbeddedRunStageTracker();
    let toolSearchCatalogExecutor: ToolSearchCatalogToolExecutor | undefined;
    const preparedToolBase = await prepare("attempt.tool-base", () =>
      prepareEmbeddedAttemptToolBase({
        agentDir,
        attempt: params,
        effectiveCwd,
        effectiveWorkspace,
        markCoreToolStage: (name) => corePluginToolStages.mark(name),
        onYield: (message, acknowledgment) => {
          yieldDetected = true;
          yieldMessage = message;
          yieldAcknowledgment = acknowledgment;
          queueYieldInterruptForSession?.();
          runAbortController.abort(SESSIONS_YIELD_ABORT_REASON);
          abortSessionForYield?.();
        },
        resolvedWorkspace,
        runAbortController,
        runTrace,
        sandbox,
        sandboxSessionKey,
        sessionPermissionPolicy,
        sessionPermissionRoot,
        sessionAgentId,
        skillUsagePaths,
        skillsSnapshot: skillsSnapshotForRun,
        codeModeSkills,
        toolSearchCatalogExecutor: (toolParams) => {
          if (!toolSearchCatalogExecutor) {
            throw new Error("Tool Search catalog executor is unavailable for this run.");
          }
          return toolSearchCatalogExecutor(toolParams);
        },
      }),
    );
    toolSearchCatalogRef = preparedToolBase.toolSearchCatalogRef;
    const {
      codeModeControlsEnabledForRun,
      computerContextEpoch,
      localModelLeanEnabled,
      replaySafetyOptions,
      runCleanups: preparedRunCleanups,
      toolSearchControlsEnabledForRun,
      toolSearchRuntimeConfig,
      toolsEnabled,
      toolsRaw,
    } = preparedToolBase;
    runCleanups = preparedRunCleanups;
    prepStages.mark("core-plugin-tools");
    emitCorePluginToolStageSummary("core-plugin-tools", corePluginToolStages.snapshot());
    const preparedBootstrap = await prepare("attempt.bootstrap", () =>
      prepareEmbeddedAttemptBootstrap({
        attempt: params,
        bootstrapWorkspaceDir: params.bootstrapWorkspaceDir,
        effectiveWorkspace,
        hasReadTool: toolsEnabled && toolsRaw.some((tool) => tool.name === "read"),
        isRawModelRun,
        markStage: (name) => prepStages.mark(name),
        resolvedWorkspace,
        sessionAgentId,
        sessionLabel: params.sessionKey ?? params.sessionId,
      }),
    );
    // Track sessions_yield tool invocation (callback pattern, like clientToolCallDetected)
    let yieldDetected = false;
    let yieldMessage: string | null = null;
    let yieldAcknowledgment: string | undefined;
    // Late-binding reference so onYield can abort the session (declared after tool creation)
    let abortSessionForYield: (() => void) | null = null;
    let queueYieldInterruptForSession: (() => void) | null = null;
    let yieldAbortSettled: Promise<void> | null = null;
    const preparedBundleTools = await prepare("attempt.bundle-tools", () =>
      prepareEmbeddedAttemptBundleTools({
        agentDir,
        attempt: params,
        effectiveWorkspace,
        getCurrentAttemptPluginMetadataSnapshot,
        getProviderRuntimeHandle,
        isRawModelRun,
        preparedToolBase,
        sessionAgentId,
      }),
    );
    bundleMcpRuntime = preparedBundleTools.bundleMcpRuntime;
    bundleLspRuntime = preparedBundleTools.bundleLspRuntime;
    const { clientTools, uncompactedEffectiveTools } = preparedBundleTools;
    // Catalog preparation registers global run state before tool projection and
    // diagnostics, so arm cleanup before either can fail and leak the catalog.
    toolSearchCatalogApplied = toolSearchCatalogRef !== undefined;
    const preparedToolCatalog = await prepare("attempt.tool-catalog", () =>
      prepareEmbeddedAttemptToolCatalog({
        attempt: params,
        preparedToolBase,
        bundleTools: { clientTools, uncompactedEffectiveTools },
        effectiveCwd,
        effectiveWorkspace,
        sessionAgentId,
        sandboxSessionKey,
        runTrace,
        abortSignal: runAbortController.signal,
        executeCodeModeTool: (toolParams) => {
          if (!toolSearchCatalogExecutor) {
            throw new Error("Code Mode catalog executor is unavailable for this run.");
          }
          return toolSearchCatalogExecutor(toolParams);
        },
        getProviderRuntimeHandle,
        markStage: (name) => prepStages.mark(name),
      }),
    );
    const {
      catalogToolHookContext,
      deferredDirectoryToolsCallable,
      effectiveTools,
      toolSearch,
      toolSearchRunPlan,
    } = preparedToolCatalog;
    toolSearchCatalogApplied = toolSearch.catalogRegistered;
    const preparedSystemPrompt = await prepare("attempt.system-prompt", () =>
      prepareEmbeddedAttemptSystemPrompt({
        activeContextEngine,
        attempt: params,
        bootstrap: preparedBootstrap,
        capabilityToolNames: toolSearchRunPlan.capabilityToolNames,
        effectiveCwd,
        effectiveTools,
        effectiveWorkspace,
        getProviderRuntimeHandle,
        isRawModelRun,
        markStage: (name) => prepStages.mark(name),
        modelToolsEnabled: toolsEnabled,
        proactiveSubagentOrchestration,
        sandbox: sandbox ?? undefined,
        sandboxSessionKey,
        sessionAgentId,
        skillsPrompt,
        codeModeActive: codeModeControlsEnabledForRun,
        toolSearchCatalogRef,
        toolSearchDirectoryEnabled: toolSearchControlsEnabledForRun && toolSearch.catalogRegistered,
        toolSearchRuntimeConfig,
      }),
    );
    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    const {
      compactionTimeoutMs,
      ownedTranscriptWriteContext,
      transcriptLifecycle,
      withOwnedTranscriptWrite,
    } = await prepare("attempt.transcript-lifecycle", () =>
      prepareEmbeddedAttemptTranscriptLifecycle({
        attempt: params,
        externalAbortController,
      }),
    );

    let session: AgentSession | undefined;
    let removeToolResultContextGuard: (() => void) | undefined;
    let trajectoryRecorder: Awaited<
      ReturnType<typeof prepareEmbeddedAttemptSessionRuntime>
    >["trajectoryRecorder"] = null;
    let buildAbortSettlePromise: () => Promise<void> | null = () => null;
    try {
      const preparedSessionRuntime = await prepare("attempt.session-runtime", () =>
        prepareEmbeddedAttemptSessionRuntime({
          attempt: params,
          ...(activeContextEngine ? { activeContextEngine } : {}),
          agentDir,
          effectiveCwd,
          effectiveFsWorkspaceOnly,
          effectiveWorkspace,
          initialSystemPrompt: preparedSystemPrompt.systemPromptText,
          isRawModelRun,
          nestedToolActivities: preparedToolBase.nestedToolActivities,
          sessionManager: {
            replayAllowedToolNames: toolSearchRunPlan.replayAllowedToolNames,
            resolveActiveContextEnginePluginId,
            sessionAgentId,
            transcriptLifecycle,
            withOwnedTranscriptWrite,
          },
          agentSession: {
            agentCoreThinkingLevel,
            clientToolPreparation: {
              catalogToolHookContext,
              clientTools,
              codeModeControlsEnabledForRun,
              deferredDirectoryToolsCallable,
              effectiveTools,
              replaySafetyOptions,
              sandboxEnabled: Boolean(sandbox?.enabled),
              sandboxSessionKey,
              sessionAgentId,
              toolSearchCatalogRef,
              toolSearchRuntimeConfig,
              uncompactedEffectiveTools,
              getToolAbortSignal: () => preparedToolBase.toolAbortSignal,
            },
            getCurrentAttemptPluginMetadataSnapshot,
            markStage: (stage) => prepStages.mark(stage),
            runAbortSignal: runAbortController.signal,
          },
          contextGuards: { computerContextEpoch },
          trajectory: {
            effectiveToolCount: effectiveTools.length,
            localModelLeanEnabled,
            ...(preparedSystemPrompt.systemPromptReport
              ? { systemPromptReport: preparedSystemPrompt.systemPromptReport }
              : {}),
          },
          transport: {
            abortSignal: runAbortController.signal,
            codeModeControlsEnabled: codeModeControlsEnabledForRun,
            getProviderRuntimeHandle,
            providerThinkingLevel,
            ...(sandbox !== undefined ? { sandbox } : {}),
            sandboxSessionKey,
          },
          externalAbortController,
          lifecycle: {
            onContextGuardsInstalled: (remove) => {
              removeToolResultContextGuard = remove;
            },
            onSessionCreated: (createdSession) => {
              session = createdSession;
            },
            onSessionManagerCreated: (createdSessionManager) => {
              sessionManager = createdSessionManager;
            },
            onSessionSettleTrackerReady: (build) => {
              buildAbortSettlePromise = build;
            },
            onSessionYieldReady: ({ abortActiveSession, activeSession }) => {
              abortSessionForYield = () => {
                yieldAbortSettled = abortActiveSession(SESSIONS_YIELD_ABORT_REASON);
              };
              queueYieldInterruptForSession = () => {
                queueSessionsYieldInterruptMessage(activeSession);
              };
            },
            onTrajectoryRecorderCreated: (recorder) => {
              trajectoryRecorder = recorder;
            },
          },
        }),
      );
      const promptToolPolicy = createPromptBuildToolPolicy({
        session: preparedSessionRuntime.agentSession.activeSession,
        effectiveTools,
        uncompactedEffectiveTools,
        tools: preparedBundleTools.tools,
        catalogRef: preparedToolBase.toolSearchCatalogRef,
        codeModeControlsEnabled: preparedToolBase.codeModeControlsEnabledForRun,
        coreReadAuthorized: preparedSessionRuntime.agentSession.coreReadAuthorized,
        onApplied: (surface) => {
          const allowedNames = new Set([
            ...surface.activeToolNames,
            ...surface.uncompactedEffectiveTools.map((tool) => tool.name),
          ]);
          preparedToolCatalog.applyPromptToolPolicy(allowedNames);
          preparedSessionRuntime.agentSession.setCodeModeReconciliationReadAuthorized(
            surface.coreReadAuthorized,
          );
        },
        forceToolNames: [
          ...(preparedToolBase.forceDirectMessageTool ? ["message"] : []),
          ...(params.swarmCollector && params.swarmOutputSchema ? ["structured_output"] : []),
        ],
      });
      const executionResult = await runEmbeddedAttemptExecutionPhase({
        attempt: params,
        ...(activeContextEngine ? { activeContextEngine } : {}),
        agentDir,
        isRawModelRun,
        resolveActiveContextEnginePluginId,
        runAbortController,
        externalAbortController,
        abortState,
        prepared: {
          bootstrap: preparedBootstrap,
          bundleTools: preparedBundleTools,
          sessionRuntime: preparedSessionRuntime,
          systemPrompt: preparedSystemPrompt,
          toolBase: preparedToolBase,
          toolCatalog: preparedToolCatalog,
          promptToolPolicy,
        },
        sessionLock: {
          compactionTimeoutMs,
          ownedTranscriptWriteContext,
          withOwnedTranscriptWrite,
        },
        setup: {
          effectiveFsWorkspaceOnly,
          effectiveWorkspace,
          emitPrepStageSummary,
          prepStages,
          sandbox,
          sandboxSessionKey,
          sessionAgentId,
        },
        diagnostics: { diagnosticTrace, runTrace },
        state: executionState,
        lifecycle: {
          applyPermissionMode: (mode, revokeApprovals) => {
            preparedToolBase.refreshPermissionMode(mode, revokeApprovals);
            preparedBundleTools.refreshTools();
            preparedToolCatalog.refreshTools();
            preparedSessionRuntime.agentSession.refreshTools();
            promptToolPolicy.refresh();
            const preparePermissionPrompt = preparedSystemPrompt.preparePermissionPrompt;
            preparedSessionRuntime.agentSession.setPermissionPromptPreparation(
              preparePermissionPrompt
                ? () => preparePermissionPrompt(promptToolPolicy.current.effectiveTools)
                : undefined,
            );
            params.permissionChange?.recordApplied(mode);
          },
          readYieldState: () => ({
            yieldAbortSettled,
            yieldDetected,
            yieldMessage,
            yieldAcknowledgment,
          }),
          setToolSearchCatalogExecutor: (executor) => {
            toolSearchCatalogExecutor = executor;
          },
        },
      });
      // Read catalog counters before the finally-phase cleanup clears the
      // run-scoped catalog session; afterwards the counts are gone.
      const catalogSession = toolSearchCatalogRef?.current;
      return {
        ...executionResult,
        codeModeEngaged: codeModeControlsEnabledForRun,
        providerRetryMaxRetries:
          preparedSessionRuntime.agentSession.settingsManager.getProviderRetrySettings().maxRetries,
        ...(catalogSession
          ? {
              bridgeCalls: {
                search: catalogSession.searchCount,
                describe: catalogSession.describeCount,
                call: catalogSession.callCount,
              },
            }
          : {}),
      };
    } finally {
      const terminal = projectAgentRunAttemptTerminal(executionState.terminal);
      await cleanupEmbeddedAttemptSessionPhase({
        attempt: params,
        session,
        sessionManager,
        transcriptLifecycle,
        bundleMcpRuntime,
        bundleLspRuntime,
        removeToolResultContextGuard,
        toolSearchCatalogRef,
        sandboxSessionKey,
        sessionAgentId,
        buildAbortSettlePromise,
        trajectoryRecorder,
        trajectoryEndRecorded: executionState.trajectoryEndRecorded,
        deferredLifecycleOwner: executionState.deferredLifecycleOwner,
        cleanupYieldAborted: terminal.cleanupYieldAborted,
        emitDiagnosticRunCompleted,
        readState: () => ({
          ...projectAgentRunAttemptTerminal(executionState.terminal),
          beforeAgentRunBlockedBy: executionState.beforeAgentRunBlockedBy,
        }),
      });
    }
  } catch (error) {
    const terminalOutcome = buildAgentRunTerminalOutcomeFromAttempt({
      terminal: executionState.terminal,
      abortSignal: params.abortSignal,
    });
    if (terminalOutcome.status === "timeout") {
      throw new AgentRunTerminalOutcomeError(error, terminalOutcome);
    }
    throw error;
  } finally {
    const cleanupTerminal = projectAgentRunAttemptTerminal(executionState.terminal);
    const cleanupReason =
      cleanupTerminal.timedOut ||
      cleanupTerminal.timedOutDuringCompaction ||
      cleanupTerminal.timedOutDuringToolExecution
        ? "timeout"
        : cleanupTerminal.aborted
          ? "cancel"
          : cleanupTerminal.failed
            ? "error"
            : "completion";
    const cleanups = runCleanups.splice(0);
    await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup(cleanupReason)));
    externalAbortController.dispose();
    clearToolActivityRun(params.runId);
    try {
      await cleanupEmbeddedPrepResourcesAfterEarlyExit();
    } catch (cleanupErr) {
      log.warn(
        `failed to clean up embedded prep resources after early attempt exit: runId=${params.runId} ${String(cleanupErr)}`,
      );
    }
    const terminal = projectAgentRunAttemptTerminal(executionState.terminal);
    emitDiagnosticRunCompleted?.(
      terminal.aborted ? "aborted" : "error",
      terminal.promptError ?? new Error("run exited before diagnostic completion"),
    );
    restoreSkillEnv?.();
  }
}
