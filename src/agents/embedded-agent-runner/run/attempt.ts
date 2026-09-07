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
  projectAgentRunAttemptTerminal,
} from "../../agent-run-terminal-outcome.js";
import { resolveAgentDir } from "../../agent-scope.js";
import { recordAgentCleanupFailure, runOwnedAgentCleanup } from "../../run-cleanup-timeout.js";
import {
  clearToolSearchCatalog,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "../../tool-search.js";
import { log } from "../logger.js";
import { remapSkillReferencePaths } from "../sandbox-skills.js";
import { prepareEmbeddedSkills } from "../skill-runtime.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { runEmbeddedAttemptExecutionPhase } from "./attempt-execution-phase.js";
import { createEmbeddedAttemptExternalAbortController } from "./attempt-finalize.js";
import { createEmbeddedAttemptPreparation } from "./attempt-preparation.js";
import { createPromptBuildToolPolicy } from "./attempt-prompt-support.js";
import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import {
  cleanupEmbeddedAttemptSessionPhase,
  type EmbeddedAttemptSessionResources,
} from "./attempt-session-settle.js";
import {
  queueSessionsYieldInterruptMessage,
  SESSIONS_YIELD_ABORT_REASON,
} from "./attempt-sessions-yield.js";
import {
  prepareEmbeddedAttemptSetup,
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
import type {
  EmbeddedAttemptExecutionState,
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./types.js";

export async function runEmbeddedAttempt(
  input: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  let params = input;
  const runAbortController = new AbortController();
  const setup = await measureEmbeddedAgentPreparation(
    "attempt.setup",
    () => prepareEmbeddedAttemptSetup(params),
    {
      config: params.config,
    },
  );
  const {
    effectiveWorkspace,
    emitCorePluginToolStageSummary,
    prepStages,
    sandbox,
    sandboxSessionKey,
    sessionAgentId,
  } = setup;

  let restoreSkillEnv: (() => void) | undefined;
  const executionState: EmbeddedAttemptExecutionState = {
    beforeAgentRunBlockedBy: undefined,
    terminal: params.abortSignal?.aborted
      ? { kind: "aborted", source: "external" }
      : { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  let emitDiagnosticRunCompleted: EmitDiagnosticRunCompleted | undefined;
  let bundleMcpRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  let bundleLspRuntime: Awaited<ReturnType<typeof createBundleLspToolRuntime>> | undefined;
  let toolSearchCatalogRef: ToolSearchCatalogRef | undefined;
  let toolSearchCatalogApplied = false;
  let runCleanups: Array<(reason: string) => Promise<void>> = [];
  const cleanupStep = (step: string, cleanup: () => Promise<void>) =>
    runOwnedAgentCleanup({ ...params, step, cleanup, log });
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
      recordAgentCleanupFailure();
    } finally {
      bundleMcpRuntime = undefined;
    }
    try {
      await bundleLspRuntime?.dispose();
    } catch {
      recordAgentCleanupFailure();
    } finally {
      bundleLspRuntime = undefined;
    }
  };
  const externalAbortController = createEmbeddedAttemptExternalAbortController({
    abortSignal: params.abortSignal,
    cleanupAfterEarlyAbort: cleanupEmbeddedPrepResourcesAfterEarlyExit,
    runAbortController,
    runId: params.runId,
    state: executionState,
  });
  const prepare = createEmbeddedAttemptPreparation({
    config: params.config,
    assertCurrent: externalAbortController.throwIfFired,
  });
  try {
    const preparedSkills = await prepare("attempt.skills", () =>
      prepareEmbeddedSkills({
        includeCodeModeSkills: true,
        attempt: params,
        effectiveWorkspace,
        sandbox,
        sessionAgentId,
      }),
    );
    restoreSkillEnv = preparedSkills.restoreSkillEnv;
    const { codeModeSkills, skillUsagePaths, skillsPrompt, skillsSnapshotForRun } = preparedSkills;
    if (params.skillsSnapshot?.librarySelections?.length && sandbox?.enabled) {
      const remapped = remapSkillReferencePaths(params.prompt, skillUsagePaths);
      if (remapped !== params.prompt) {
        params = {
          ...params,
          prompt: remapped,
          transcriptPrompt: params.transcriptPrompt ?? params.prompt,
        };
      }
    }
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
        setup,
        markCoreToolStage: (name) => corePluginToolStages.mark(name),
        onYield: (message, acknowledgment) => {
          yieldDetected = true;
          yieldMessage = message;
          yieldAcknowledgment = acknowledgment;
          queueYieldInterruptForSession?.();
          runAbortController.abort(SESSIONS_YIELD_ABORT_REASON);
          abortSessionForYield?.();
        },
        runAbortController,
        runTrace,
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
        setup,
        hasReadTool: toolsEnabled && toolsRaw.some((tool) => tool.name === "read"),
        isRawModelRun,
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
        setup,
        isRawModelRun,
        preparedToolBase,
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
        setup,
        preparedToolBase,
        bundleTools: { clientTools, uncompactedEffectiveTools },
        runTrace,
        abortSignal: runAbortController.signal,
        executeCodeModeTool: (toolParams) => {
          if (!toolSearchCatalogExecutor) {
            throw new Error("Code Mode catalog executor is unavailable for this run.");
          }
          return toolSearchCatalogExecutor(toolParams);
        },
      }),
    );
    const { effectiveTools, toolSearch, toolSearchRunPlan } = preparedToolCatalog;
    toolSearchCatalogApplied = toolSearch.catalogRegistered;
    const preparedSystemPrompt = await prepare("attempt.system-prompt", () =>
      prepareEmbeddedAttemptSystemPrompt({
        activeContextEngine,
        attempt: params,
        setup,
        bootstrap: preparedBootstrap,
        capabilityToolNames: toolSearchRunPlan.capabilityToolNames,
        requireExplicitMessageTarget: preparedToolBase.requireExplicitMessageTarget,
        effectiveTools,
        isRawModelRun,
        modelToolsEnabled: toolsEnabled,
        skillsPrompt,
        codeModeActive: codeModeControlsEnabledForRun,
        toolSearchCatalogRef,
        toolSearchDirectoryEnabled: toolSearchControlsEnabledForRun && toolSearch.catalogRegistered,
        toolSearchRuntimeConfig,
      }),
    );
    const sessionLock = await prepare("attempt.transcript-lifecycle", () =>
      prepareEmbeddedAttemptTranscriptLifecycle({
        attempt: params,
        externalAbortController,
      }),
    );
    const resources: EmbeddedAttemptSessionResources = {
      trajectoryRecorder: null,
      buildAbortSettlePromise: () => null,
    };
    try {
      const preparedSessionRuntime = await prepare("attempt.session-runtime", () =>
        prepareEmbeddedAttemptSessionRuntime({
          attempt: params,
          ...(activeContextEngine ? { activeContextEngine } : {}),
          agentDir,
          isRawModelRun,
          resolveActiveContextEnginePluginId,
          setup,
          toolBase: preparedToolBase,
          toolCatalog: preparedToolCatalog,
          bundleTools: preparedBundleTools,
          systemPrompt: preparedSystemPrompt,
          sessionLock,
          runAbortSignal: runAbortController.signal,
          externalAbortController,
          resources,
          onSessionYieldReady: ({ abortActiveSession, activeSession }) => {
            abortSessionForYield = () => {
              yieldAbortSettled = abortActiveSession(SESSIONS_YIELD_ABORT_REASON);
            };
            queueYieldInterruptForSession = () => {
              queueSessionsYieldInterruptMessage(activeSession);
            };
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
        onApplied: (surface) => {
          const allowedNames = new Set([
            ...surface.activeToolNames,
            ...surface.uncompactedEffectiveTools.map((tool) => tool.name),
          ]);
          preparedToolCatalog.applyPromptToolPolicy(allowedNames);
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
        prepared: {
          bootstrap: preparedBootstrap,
          bundleTools: preparedBundleTools,
          sessionRuntime: preparedSessionRuntime,
          systemPrompt: preparedSystemPrompt,
          toolBase: preparedToolBase,
          toolCatalog: preparedToolCatalog,
          promptToolPolicy,
        },
        sessionLock,
        setup,
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
      // Transfer resources to the session cleanup owner before awaiting it. A
      // bounded timeout must not let outer early-exit cleanup dispose them twice.
      const sessionMcpRuntime = bundleMcpRuntime;
      const sessionLspRuntime = bundleLspRuntime;
      bundleMcpRuntime = undefined;
      bundleLspRuntime = undefined;
      toolSearchCatalogApplied = false;
      await cleanupStep("embedded-session", () =>
        cleanupEmbeddedAttemptSessionPhase({
          attempt: params,
          ...resources,
          transcriptLifecycle: sessionLock.transcriptLifecycle,
          bundleMcpRuntime: sessionMcpRuntime,
          bundleLspRuntime: sessionLspRuntime,
          toolSearchCatalogRef,
          sandboxSessionKey,
          sessionAgentId,
          trajectoryEndRecorded: executionState.trajectoryEndRecorded,
          deferredLifecycleOwner: executionState.deferredLifecycleOwner,
          emitDiagnosticRunCompleted,
          state: executionState,
        }),
      );
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
    await cleanupStep("embedded-registered-resources", async () => {
      const settled = await Promise.allSettled(
        cleanups.map(async (cleanup) => await cleanup(cleanupReason)),
      );
      if (settled.some((result) => result.status === "rejected")) {
        recordAgentCleanupFailure();
      }
    });
    externalAbortController.dispose();
    clearToolActivityRun(params.runId);
    try {
      await cleanupStep("embedded-preparation", cleanupEmbeddedPrepResourcesAfterEarlyExit);
    } catch (cleanupErr) {
      recordAgentCleanupFailure();
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
