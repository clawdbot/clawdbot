/** Orchestrates one embedded-agent attempt from prompt setup through stream result. */
import {
  assertContextEngineHostSupport,
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
} from "../../../context-engine/host-compat.js";
import { resolveContextEngineOwnerPluginId } from "../../../context-engine/registry.js";
import { createBundleLspToolRuntime } from "../../agent-bundle-lsp-runtime.js";
import { materializeBundleMcpToolsForRun } from "../../agent-bundle-mcp-tools.js";
import {
  mergeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
  type AgentRunAttemptTerminal,
} from "../../agent-run-terminal-outcome.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../../agent-scope.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import {
  clearToolSearchCatalog,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "../../tool-search.js";
import { log } from "../logger.js";
import {
  createEmbeddedAttemptExternalAbortController,
  type EmbeddedAttemptAbortStatePort,
} from "./attempt-abort.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { runEmbeddedAttemptExecutionPhase } from "./attempt-execution-phase.js";
import type { EmbeddedAttemptExecutionState } from "./attempt-execution-types.js";
import { cleanupEmbeddedAttemptSessionPhase } from "./attempt-session-cleanup.js";
import { prepareEmbeddedAttemptSessionLock } from "./attempt-session-lock-prepare.js";
import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import { prepareEmbeddedAttemptSetup } from "./attempt-setup.js";
import { createEmbeddedRunStageTracker } from "./attempt-stage-timing.js";
import {
  prepareEmbeddedAttemptSkills,
  startEmbeddedAttemptDiagnostics,
  type EmitDiagnosticRunCompleted,
} from "./attempt-startup.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-base-prepare.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import type { EmbeddedAttemptSessionFileOwner } from "./attempt.session-lock.js";
import {
  queueSessionsYieldInterruptMessage,
  SESSIONS_YIELD_ABORT_REASON,
} from "./attempt.sessions-yield.js";
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
    sessionAgentId,
  } = await prepareEmbeddedAttemptSetup(params);

  let restoreSkillEnv: (() => void) | undefined;
  const executionState: EmbeddedAttemptExecutionState = {
    beforeAgentRunBlocked: false,
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
  // Releases the eager session lock if post-prompt code exits before cleanup.
  let releaseRetainedSessionLock: (() => Promise<void>) | undefined;
  let retainedSessionFileOwner: EmbeddedAttemptSessionFileOwner | undefined;
  let bundleMcpRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  let bundleLspRuntime: Awaited<ReturnType<typeof createBundleLspToolRuntime>> | undefined;
  let toolSearchCatalogRef: ToolSearchCatalogRef | undefined;
  let toolSearchCatalogApplied = false;
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
  try {
    const preparedSkills = prepareEmbeddedAttemptSkills({
      attempt: params,
      effectiveWorkspace,
      sandbox,
      sessionAgentId,
    });
    restoreSkillEnv = preparedSkills.restoreSkillEnv;
    const { skillUsagePaths, skillsPrompt, skillsSnapshotForRun } = preparedSkills;
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
    const preparedToolBase = prepareEmbeddedAttemptToolBase({
      agentDir,
      attempt: params,
      effectiveCwd,
      effectiveWorkspace,
      markCoreToolStage: (name) => corePluginToolStages.mark(name),
      onYield: (message) => {
        yieldDetected = true;
        yieldMessage = message;
        queueYieldInterruptForSession?.();
        runAbortController.abort(SESSIONS_YIELD_ABORT_REASON);
        abortSessionForYield?.();
      },
      resolvedWorkspace,
      runAbortController,
      runTrace,
      sandbox,
      sandboxSessionKey,
      sessionAgentId,
      skillUsagePaths,
      skillsSnapshot: skillsSnapshotForRun,
      toolSearchCatalogExecutor: (toolParams) => {
        if (!toolSearchCatalogExecutor) {
          throw new Error("Tool Search catalog executor is unavailable for this run.");
        }
        return toolSearchCatalogExecutor(toolParams);
      },
    });
    toolSearchCatalogRef = preparedToolBase.toolSearchCatalogRef;
    const {
      codeModeControlsEnabledForRun,
      computerContextEpoch,
      localModelLeanEnabled,
      replaySafetyOptions,
      toolSearchRuntimeConfig,
      toolsEnabled,
      toolsRaw,
    } = preparedToolBase;
    prepStages.mark("core-plugin-tools");
    emitCorePluginToolStageSummary("core-plugin-tools", corePluginToolStages.snapshot());
    const preparedBootstrap = await prepareEmbeddedAttemptBootstrap({
      attempt: params,
      effectiveWorkspace,
      hasReadTool: toolsEnabled && toolsRaw.some((tool) => tool.name === "read"),
      isRawModelRun,
      markStage: (name) => prepStages.mark(name),
      resolvedWorkspace,
      sessionAgentId,
      sessionLabel: params.sessionKey ?? params.sessionId,
    });
    const { defaultAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
      agentId: params.agentId,
    });
    // Track sessions_yield tool invocation (callback pattern, like clientToolCallDetected)
    let yieldDetected = false;
    let yieldMessage: string | null = null;
    // Late-binding reference so onYield can abort the session (declared after tool creation)
    let abortSessionForYield: (() => void) | null = null;
    let queueYieldInterruptForSession: (() => void) | null = null;
    let yieldAbortSettled: Promise<void> | null = null;
    const preparedBundleTools = await prepareEmbeddedAttemptBundleTools({
      agentDir,
      attempt: params,
      effectiveWorkspace,
      getCurrentAttemptPluginMetadataSnapshot,
      getProviderRuntimeHandle,
      isRawModelRun,
      preparedToolBase,
      sessionAgentId,
    });
    bundleMcpRuntime = preparedBundleTools.bundleMcpRuntime;
    bundleLspRuntime = preparedBundleTools.bundleLspRuntime;
    const { clientTools, uncompactedEffectiveTools } = preparedBundleTools;
    const preparedToolCatalog = prepareEmbeddedAttemptToolCatalog({
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
    });
    const {
      catalogToolHookContext,
      deferredDirectoryToolsCallable,
      effectiveTools,
      toolSearch,
      toolSearchRunPlan,
    } = preparedToolCatalog;
    // Arms the early-exit catalog clear: the run-scoped catalog is registered in
    // a process-global map that only clearToolSearchCatalog deletes from, so a
    // prep-phase abort after registration leaks the entry without this.
    toolSearchCatalogApplied = toolSearch.catalogRegistered;
    const preparedSystemPrompt = await prepareEmbeddedAttemptSystemPrompt({
      activeContextEngine,
      attempt: params,
      bootstrap: preparedBootstrap,
      capabilityToolNames: toolSearchRunPlan.capabilityToolNames,
      defaultAgentId,
      deferredDirectoryToolsCallable,
      effectiveCwd,
      effectiveTools,
      effectiveWorkspace,
      getProviderRuntimeHandle,
      isRawModelRun,
      markStage: (name) => prepStages.mark(name),
      proactiveSubagentOrchestration,
      sandbox: sandbox ?? undefined,
      sandboxSessionKey,
      sessionAgentId,
      skillsPrompt,
      toolSearchCatalogRef,
    });
    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    const {
      compactionTimeoutMs,
      ownedTranscriptWriteContext,
      sessionLockController,
      withOwnedSessionWriteLock,
    } = await prepareEmbeddedAttemptSessionLock({
      attempt: params,
      externalAbortController,
      getSessionManager: () => sessionManager,
      onSessionFileOwnerAcquired: (owner) => {
        retainedSessionFileOwner = owner;
      },
      onSessionLockReleaseReady: (release) => {
        releaseRetainedSessionLock = release;
      },
    });

    let session: AgentSession | undefined;
    let removeToolResultContextGuard: (() => void) | undefined;
    let trajectoryRecorder: Awaited<
      ReturnType<typeof prepareEmbeddedAttemptSessionRuntime>
    >["trajectoryRecorder"] = null;
    let buildAbortSettlePromise: () => Promise<void> | null = () => null;
    try {
      const preparedSessionRuntime = await prepareEmbeddedAttemptSessionRuntime({
        attempt: params,
        ...(activeContextEngine ? { activeContextEngine } : {}),
        agentDir,
        effectiveCwd,
        effectiveFsWorkspaceOnly,
        effectiveWorkspace,
        initialSystemPrompt: preparedSystemPrompt.systemPromptText,
        isRawModelRun,
        sessionManager: {
          replayAllowedToolNames: toolSearchRunPlan.replayAllowedToolNames,
          resolveActiveContextEnginePluginId,
          sessionAgentId,
          sessionLockController,
          withOwnedSessionWriteLock,
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
      });
      return await runEmbeddedAttemptExecutionPhase({
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
        },
        sessionLock: {
          compactionTimeoutMs,
          ownedTranscriptWriteContext,
          sessionLockController,
          withOwnedSessionWriteLock,
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
          readYieldState: () => ({ yieldAbortSettled, yieldDetected, yieldMessage }),
          setToolSearchCatalogExecutor: (executor) => {
            toolSearchCatalogExecutor = executor;
          },
        },
      });
    } finally {
      const terminal = projectAgentRunAttemptTerminal(executionState.terminal);
      await cleanupEmbeddedAttemptSessionPhase({
        attempt: params,
        session,
        sessionManager,
        sessionLockController,
        bundleMcpRuntime,
        bundleLspRuntime,
        removeToolResultContextGuard,
        toolSearchCatalogRef,
        sandboxSessionKey,
        sessionAgentId,
        buildAbortSettlePromise,
        trajectoryRecorder,
        trajectoryEndRecorded: executionState.trajectoryEndRecorded,
        cleanupYieldAborted: terminal.cleanupYieldAborted,
        emitDiagnosticRunCompleted,
        readState: () => ({
          ...projectAgentRunAttemptTerminal(executionState.terminal),
          beforeAgentRunBlocked: executionState.beforeAgentRunBlocked,
          beforeAgentRunBlockedBy: executionState.beforeAgentRunBlockedBy,
        }),
      });
    }
  } finally {
    externalAbortController.dispose();
    clearToolActivityRun(params.runId);
    try {
      await cleanupEmbeddedPrepResourcesAfterEarlyExit();
    } catch (cleanupErr) {
      log.warn(
        `failed to clean up embedded prep resources after early attempt exit: runId=${params.runId} ${String(cleanupErr)}`,
      );
    }
    try {
      await releaseRetainedSessionLock?.();
    } catch (releaseErr) {
      log.error(
        `failed to release retained session lock on attempt teardown: runId=${params.runId} ${String(releaseErr)}`,
      );
    }
    retainedSessionFileOwner?.release();
    const terminal = projectAgentRunAttemptTerminal(executionState.terminal);
    emitDiagnosticRunCompleted?.(
      terminal.aborted ? "aborted" : "error",
      terminal.promptError ?? new Error("run exited before diagnostic completion"),
    );
    restoreSkillEnv?.();
  }
}
