/**
 * Orchestrates one embedded-agent attempt from prompt setup through stream result.
 */
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import {
  bindOwnedSessionTranscriptWrites,
  type OwnedSessionTranscriptCacheSnapshot,
  type OwnedSessionTranscriptWriteOptions,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import {
  assertContextEngineHostSupport,
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
} from "../../../context-engine/host-compat.js";
import { resolveContextEngineOwnerPluginId } from "../../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import { emitTrustedDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import { buildTrajectoryRunMetadata } from "../../../trajectory/metadata.js";
import {
  createTrajectoryRuntimeRecorder,
  toTrajectoryToolDefinitions,
} from "../../../trajectory/runtime.js";
import { createBundleLspToolRuntime } from "../../agent-bundle-lsp-runtime.js";
import { materializeBundleMcpToolsForRun } from "../../agent-bundle-mcp-tools.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../../agent-scope.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import { createCacheTrace } from "../../cache-trace.js";
import { resolveUserTimezone } from "../../date-time.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { countActiveToolExecutions } from "../../embedded-agent-subscribe.handlers.tools.js";
import { isSignalTimeoutReason } from "../../failover-error.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { relocateCurrentRuntimeContextCarrierToTail } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { acquireSessionWriteLock } from "../../session-write-lock.js";
import type { AgentSession } from "../../sessions/index.js";
import { releasePendingAgentSteeringItems } from "../../subagent-registry.js";
import {
  clearToolSearchCatalog,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "../../tool-search.js";
import { invalidateComputerFrameIfMissing } from "../../tools/computer-tool.js";
import type { NormalizedUsage } from "../../usage.js";
import { readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
import { prepareGooglePromptCacheStreamFn } from "../google-prompt-cache.js";
import { log } from "../logger.js";
import type { PromptCacheBreak, PromptCacheChange } from "../prompt-cache-observability.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  markActiveEmbeddedRunAbandoned,
} from "../runs.js";
import { getEmbeddedSessionPromptState } from "../session-prompt-state.js";
import { resolveEmbeddedAgentApiKey } from "../stream-resolution.js";
import {
  installContextEngineLoopHook,
  installToolResultContextGuard,
} from "../tool-result-context-guard.js";
import { resolveLiveToolResultMaxChars } from "../tool-result-truncation.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import { abortable as abortableWithSignal } from "./abortable.js";
import { releaseEmbeddedAttemptSessionLockForAbort } from "./attempt-abort.js";
import { completeEmbeddedAttemptAfterTurn } from "./attempt-after-turn.js";
import { runEmbeddedAttemptBeforeAgentRun } from "./attempt-before-agent-run.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { summarizeSessionContext } from "./attempt-context-summary.js";
import { prepareEmbeddedAttemptHistory } from "./attempt-history-prepare.js";
import {
  replayTrailingEntriesForOrphanRepair,
  resolveOrphanRepairPlan,
} from "./attempt-orphan-repair.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-assembly.js";
import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-context.js";
import {
  handleEmbeddedAttemptMidTurnPrecheck,
  prepareEmbeddedAttemptPromptPreflight,
} from "./attempt-prompt-preflight.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { completeEmbeddedAttemptResult } from "./attempt-result.js";
import { cleanupEmbeddedAttemptSessionPhase } from "./attempt-session-cleanup.js";
import { prepareEmbeddedAttemptSessionManager } from "./attempt-session-manager-prepare.js";
import { prepareEmbeddedAttemptAgentSession } from "./attempt-session.js";
import { prepareEmbeddedAttemptSetup } from "./attempt-setup.js";
import { createEmbeddedRunStageTracker } from "./attempt-stage-timing.js";
import {
  prepareEmbeddedAttemptSkills,
  startEmbeddedAttemptDiagnostics,
  type EmitDiagnosticRunCompleted,
} from "./attempt-startup.js";
import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";
import { prepareEmbeddedAttemptTransport } from "./attempt-stream-transport.js";
import { installEmbeddedAttemptStreamGuards } from "./attempt-stream.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-base-prepare.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import {
  cloneHookMessages,
  removeTrailingMidTurnPrecheckAssistantError,
  repairAttemptToolUseResultPairing,
  resolveAttemptTrajectorySessionFile,
} from "./attempt-transcript-helpers.js";
import { buildLoopPromptCacheInfo } from "./attempt.context-engine-helpers.js";
import { normalizeMessagesForLlmBoundary } from "./attempt.llm-boundary.js";
import {
  buildAfterTurnRuntimeContext,
  resolvePromptSubmissionSkipReason,
} from "./attempt.prompt-helpers.js";
import { resolveEmbeddedAttemptSessionWriteLockOptions } from "./attempt.run-decisions.js";
import {
  acquireEmbeddedAttemptSessionFileOwner,
  type EmbeddedAttemptSessionFileOwner,
  createEmbeddedAttemptSessionLockController,
  installPromptSubmissionLockRelease,
} from "./attempt.session-lock.js";
import {
  isSessionsYieldAbortError,
  persistSessionsYieldContextMessage,
  queueSessionsYieldInterruptMessage,
  SESSIONS_YIELD_ABORT_REASON,
  stripSessionsYieldArtifacts,
  waitForSessionsYieldAbortSettle,
} from "./attempt.sessions-yield.js";
import { shouldFlagCompactionTimeout } from "./compaction-timeout.js";
import { installHistoryImagePruneContextTransform } from "./history-image-prune.js";
import { detectAndLoadPromptImages } from "./images.js";
import { isMidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./midturn-precheck.js";
import { detachPrePersistedCurrentUserTurn } from "./pre-persisted-user-turn.js";
import { PREEMPTIVE_OVERFLOW_ERROR_TEXT } from "./preemptive-compaction.js";
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
  let aborted = Boolean(params.abortSignal?.aborted);
  let externalAbort = false;
  let timedOut = false;
  let idleTimedOut = false;
  let timedOutDuringCompaction = false;
  let timedOutDuringToolExecution = false;
  let timedOutByRunBudget = false;
  let promptError: unknown = null;
  let emitDiagnosticRunCompleted: EmitDiagnosticRunCompleted | undefined;
  let beforeAgentRunBlocked = false;
  let beforeAgentRunBlockedBy: string | undefined;
  // Releases the eager session lock if post-prompt code exits before cleanup.
  let releaseRetainedSessionLock: (() => Promise<void>) | undefined;
  let retainedSessionFileOwner: EmbeddedAttemptSessionFileOwner | undefined;
  let bundleMcpRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  let bundleLspRuntime: Awaited<ReturnType<typeof createBundleLspToolRuntime>> | undefined;
  let toolSearchCatalogRef: ToolSearchCatalogRef | undefined;
  let appliedToolSearchCatalog: ReturnType<typeof prepareEmbeddedAttemptToolCatalog> | undefined;
  const sessionCleanupOwnsEmbeddedResources = false;
  let abortActiveSessionForExternalSignal: (() => Promise<void>) | undefined;
  let abortRunForExternalSignal: ((isTimeout?: boolean, reason?: unknown) => void) | undefined;
  let isCompactionPendingForExternalSignal: (() => boolean) | undefined;
  let isCompactionInFlightForExternalSignal: (() => boolean) | undefined;
  let removeExternalAbortSignalListener: (() => void) | undefined;
  const createAttemptAbortError = (signal: AbortSignal): Error => {
    if (signal.reason instanceof Error) {
      return signal.reason;
    }
    const err = new Error("request aborted", { cause: signal.reason });
    err.name = "AbortError";
    return err;
  };
  const getAbortReason = (signal: AbortSignal): unknown =>
    "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
  const makeTimeoutAbortReason = (): Error => {
    const err = new Error("request timed out");
    err.name = "TimeoutError";
    return err;
  };
  const cleanupEmbeddedPrepResourcesAfterEarlyExit = async () => {
    if (appliedToolSearchCatalog) {
      clearToolSearchCatalog({
        sessionId: params.sessionId,
        sessionKey: sandboxSessionKey,
        agentId: sessionAgentId,
        runId: params.runId,
        catalogRef: toolSearchCatalogRef,
      });
      appliedToolSearchCatalog = undefined;
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
  const onExternalAbortSignal = () => {
    const signal = params.abortSignal;
    if (!signal) {
      return;
    }
    externalAbort = true;
    const reason = getAbortReason(signal);
    const timeout = reason ? isSignalTimeoutReason(reason) : false;
    if (
      shouldFlagCompactionTimeout({
        isTimeout: timeout,
        isCompactionPendingOrRetrying: isCompactionPendingForExternalSignal?.() ?? false,
        isCompactionInFlight: isCompactionInFlightForExternalSignal?.() ?? false,
      })
    ) {
      timedOutDuringCompaction = true;
    }
    if (abortRunForExternalSignal) {
      abortRunForExternalSignal(timeout, reason);
      return;
    }
    aborted = true;
    if (timeout) {
      timedOut = true;
      if (!timedOutDuringCompaction && countActiveToolExecutions(params.runId) > 0) {
        timedOutDuringToolExecution = true;
      }
    }
    promptError = createAttemptAbortError(signal);
    if (!runAbortController.signal.aborted) {
      runAbortController.abort(timeout ? (reason ?? makeTimeoutAbortReason()) : reason);
    }
    void abortActiveSessionForExternalSignal?.();
  };
  const armExternalAbortSignal = () => {
    const signal = params.abortSignal;
    if (!signal || removeExternalAbortSignalListener) {
      return;
    }
    if (signal.aborted) {
      onExternalAbortSignal();
      return;
    }
    signal.addEventListener("abort", onExternalAbortSignal, { once: true });
    removeExternalAbortSignalListener = () => {
      signal.removeEventListener("abort", onExternalAbortSignal);
      removeExternalAbortSignalListener = undefined;
    };
  };
  const throwIfAttemptAbortSignalFiredAfterPrepCleanup = async () => {
    if (params.abortSignal?.aborted === true) {
      const abortError = createAttemptAbortError(params.abortSignal);
      aborted = true;
      externalAbort = true;
      promptError = abortError;
      await cleanupEmbeddedPrepResourcesAfterEarlyExit();
      throw abortError;
    }
  };
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

    const sessionLabel = params.sessionKey ?? params.sessionId;
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
      toolSearchTargetTranscriptProjections,
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
      sessionLabel,
    });
    const { bootstrapPromptWarning, shouldRecordCompletedBootstrapTurn } = preparedBootstrap;

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
    const { clientTools, tools, uncompactedEffectiveTools } = preparedBundleTools;
    appliedToolSearchCatalog = prepareEmbeddedAttemptToolCatalog({
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
      emptyExplicitToolAllowlistError,
      toolSearch,
      toolSearchRunPlan,
    } = appliedToolSearchCatalog;
    const replayAllowedToolNames = toolSearchRunPlan.replayAllowedToolNames;
    const liveAllowedToolNames = toolSearchRunPlan.liveAllowedToolNames;
    const capabilityToolNames = toolSearchRunPlan.capabilityToolNames;

    const preparedSystemPrompt = await prepareEmbeddedAttemptSystemPrompt({
      activeContextEngine,
      attempt: params,
      bootstrap: preparedBootstrap,
      capabilityToolNames,
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
    const { runtimeChannel, runtimeInfo, systemPromptReport } = preparedSystemPrompt;
    let systemPromptText = preparedSystemPrompt.systemPromptText;

    const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
    const sessionWriteLockOptions = resolveEmbeddedAttemptSessionWriteLockOptions({
      config: params.config,
      compactionTimeoutMs,
    });
    await throwIfAttemptAbortSignalFiredAfterPrepCleanup();
    retainedSessionFileOwner = await acquireEmbeddedAttemptSessionFileOwner({
      sessionFile: params.sessionFile,
      timeoutMs: sessionWriteLockOptions.maxHoldMs,
      signal: params.abortSignal,
    });
    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    const sessionLockController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      initialAcquireSignal: params.abortSignal,
      lockOptions: {
        sessionFile: params.sessionFile,
        ...sessionWriteLockOptions,
      },
      mergePromptReleasedSessionEntries: (entries) => {
        if (!sessionManager) {
          throw new Error("session manager unavailable during prompt-released entry merge");
        }
        return sessionManager.mergePromptReleasedSessionEntries(entries, { persistLeaf: true });
      },
      reloadPromptReleasedSessionFile: () => {
        if (!sessionManager) {
          throw new Error("session manager unavailable during prompt-released file reload");
        }
        sessionManager.setSessionFile(params.sessionFile);
      },
    });
    releaseRetainedSessionLock = () => sessionLockController.dispose();
    const ownedTranscriptWriteContext = {
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      canAdvanceSessionEntryCache: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
        sessionLockController.canAdvanceSessionEntryCache(snapshot),
      publishSessionFileSnapshot: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
        sessionLockController.publishOwnedSessionFileSnapshot(snapshot),
      withSessionWriteLock: <T>(
        operation: () => Promise<T> | T,
        options?: OwnedSessionTranscriptWriteOptions<T>,
      ) => sessionLockController.withSessionWriteLock(operation, options),
    };
    const withOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T): Promise<T> =>
      withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
        sessionLockController.withSessionWriteLock(operation),
      );
    armExternalAbortSignal();
    // The signal can fire while the eager session lock is being acquired.
    // Recheck after arming so a stopped run never reaches session creation or provider prompt.
    await throwIfAttemptAbortSignalFiredAfterPrepCleanup();

    let session: AgentSession | undefined;
    let removeToolResultContextGuard: (() => void) | undefined;
    let trajectoryRecorder: ReturnType<typeof createTrajectoryRuntimeRecorder> | null = null;
    let trajectoryEndRecorded = false;
    let buildAbortSettlePromise: () => Promise<void> | null = () => null;
    let cleanupYieldAborted = false;
    let repairedRejectedThinkingReplay = false;
    try {
      const preparedSessionManager = await prepareEmbeddedAttemptSessionManager({
        attempt: params,
        activeContextEngine,
        agentDir,
        effectiveCwd,
        effectiveWorkspace,
        onSessionManagerCreated: (createdSessionManager) => {
          sessionManager = createdSessionManager;
        },
        replayAllowedToolNames,
        resolveActiveContextEnginePluginId,
        sessionAgentId,
        sessionLockController,
        withOwnedSessionWriteLock,
      });
      const { isOpenAIResponsesApi, preparedUserTurnMessage, transcriptPolicy } =
        preparedSessionManager;
      sessionManager = preparedSessionManager.sessionManager;

      const {
        activeSession,
        allCustomTools,
        clientToolCallSlots,
        clientToolDefs,
        clientToolLoopDetection,
        hasDeliveredSourceReply,
        hookRunner,
        markSourceReplyDelivered,
        replaySafeTools,
        setActiveSessionSystemPrompt,
        settingsManager,
        subscriptionToolTrust,
      } = await prepareEmbeddedAttemptAgentSession({
        attempt: params,
        activeContextEngineInfo: activeContextEngine?.info,
        agentCoreThinkingLevel,
        agentDir,
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
        effectiveCwd,
        getCurrentAttemptPluginMetadataSnapshot,
        initialSystemPrompt: systemPromptText,
        markStage: (stage) => prepStages.mark(stage),
        onSessionCreated: (createdSession) => {
          session = createdSession;
        },
        onSystemPromptChanged: (nextSystemPrompt) => {
          systemPromptText = nextSystemPrompt;
        },
        runAbortSignal: runAbortController.signal,
        sessionAgentId,
        sessionLockController,
        sessionManager,
      });
      if (isRawModelRun) {
        // Raw model probes should measure exactly the requested prompt against
        // the selected provider/model. Reset clears restored transcript state
        // and queues; the empty system prompt prevents the runtime from rebuilding the
        // normal OpenClaw agent/tool prompt when `session.prompt()` starts.
        activeSession.agent.reset();
        setActiveSessionSystemPrompt("");
      }
      const orphanRepair = isRawModelRun
        ? undefined
        : resolveOrphanRepairPlan({
            sessionManager,
            prompt: params.prompt,
            trigger: params.trigger,
          });
      if (orphanRepair?.removeLeaf) {
        if (orphanRepair.messageEntry.parentId) {
          sessionManager.branch(orphanRepair.messageEntry.parentId);
        } else {
          sessionManager.resetLeaf();
        }
        replayTrailingEntriesForOrphanRepair(sessionManager, orphanRepair.trailingEntries);
        // Suppression assumes the canonical user turn still exists. Orphan repair
        // removed it, so the replacement prompt must become the one durable copy.
        sessionManager.clearNextUserMessagePersistenceSuppression?.();
        params.onUserMessagePersistenceInvalidated?.();
        activeSession.agent.state.messages = sessionManager.buildSessionContext().messages;
      }
      detachPrePersistedCurrentUserTurn({
        activeSession,
        preparedUserTurnMessage,
        suppressNextUserMessagePersistence: params.suppressNextUserMessagePersistence,
        userTurnAlreadyPersisted: params.userTurnTranscriptRecorder?.hasPersisted() === true,
      });
      // Single source for the per-message timestamp prefix (issue #3658):
      // normal embedded runs stamp every user message from its own timestamp.
      // Raw model probes must keep the requested prompt text exact.
      const boundaryTimezone = isRawModelRun
        ? undefined
        : resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
      const includeBoundaryTimestamp =
        !isRawModelRun && params.config?.agents?.defaults?.envelopeTimestamp !== "off";
      let currentUserTimestampOverride:
        | { timestamp: number; text: string; alternateText?: string }
        | undefined;
      const buildBoundaryOptions = () => {
        if (isRawModelRun) {
          return undefined;
        }
        return {
          ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
          ...(includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
          ...(currentUserTimestampOverride ? { currentUserTimestampOverride } : {}),
        };
      };
      if (typeof activeSession.agent.convertToLlm === "function") {
        const baseConvertToLlm = activeSession.agent.convertToLlm.bind(activeSession.agent);
        activeSession.agent.convertToLlm = async (messages) =>
          await baseConvertToLlm(
            // Wire-only: move the current-turn runtime-context carrier to the
            // absolute tail so the request is an append-only prefix-extension
            // through the active user turn (see the function's cache rationale).
            // Applied here, not inside normalizeMessagesForLlmBoundary, because
            // normalizeMessagesForCurrentPromptBoundary slices off its appended
            // prompt by position and must not see the carrier relocated past it.
            relocateCurrentRuntimeContextCarrierToTail(
              normalizeMessagesForLlmBoundary(messages, buildBoundaryOptions()),
            ),
          );
      }
      let prePromptMessageCount = activeSession.messages.length;
      // Session-owned projections survive attempt teardown so already-sent tool results
      // cannot rewrite the provider prompt-cache tail between turns (#99495).
      const sessionPromptState = getEmbeddedSessionPromptState(params.sessionId);
      const toolResultPromptProjectionState = sessionPromptState.toolResults;
      let contextEngineAfterTurnCheckpoint: number | null = null;
      const inFlightPromptSettlePromises = new Set<Promise<void>>();
      const inFlightAbortSettlePromises = new Set<Promise<void>>();
      const trackSettlePromise = (
        promises: Set<Promise<void>>,
        promise: Promise<void>,
      ): Promise<void> => {
        promises.add(promise);
        void promise.then(
          () => {
            promises.delete(promise);
          },
          () => {
            promises.delete(promise);
          },
        );
        return promise;
      };
      const trackPromptSettlePromise = (promise: Promise<void>): Promise<void> =>
        trackSettlePromise(inFlightPromptSettlePromises, promise);
      const trackAbortSettlePromise = (promise: Promise<void>): Promise<void> =>
        trackSettlePromise(inFlightAbortSettlePromises, promise);
      const abortActiveSession = (reason?: unknown): Promise<void> =>
        trackAbortSettlePromise(Promise.resolve(activeSession.abort(reason)));
      abortActiveSessionForExternalSignal = abortActiveSession;
      buildAbortSettlePromise = (): Promise<void> | null => {
        const promises = [...inFlightPromptSettlePromises, ...inFlightAbortSettlePromises];
        if (promises.length === 0) {
          return null;
        }
        return Promise.allSettled(promises).then(() => undefined);
      };
      abortSessionForYield = () => {
        yieldAbortSettled = abortActiveSession(SESSIONS_YIELD_ABORT_REASON);
      };
      queueYieldInterruptForSession = () => {
        queueSessionsYieldInterruptMessage(activeSession);
      };
      const contextTokenBudgetForGuard = Math.max(
        1,
        Math.floor(
          params.contextTokenBudget ??
            params.model.contextWindow ??
            params.model.maxTokens ??
            DEFAULT_CONTEXT_TOKENS,
        ),
      );
      const toolResultMaxCharsForGuard = resolveLiveToolResultMaxChars({
        contextWindowTokens: contextTokenBudgetForGuard,
        cfg: params.config,
        agentId: sessionAgentId,
      });
      const midTurnPrecheckEnabled =
        params.config?.agents?.defaults?.compaction?.midTurnPrecheck?.enabled === true;
      let pendingMidTurnPrecheckRequest: MidTurnPrecheckRequest | null = null;
      const onMidTurnPrecheck = (request: MidTurnPrecheckRequest) => {
        pendingMidTurnPrecheckRequest = request;
      };
      const midTurnPrecheckOptions = midTurnPrecheckEnabled
        ? {
            midTurnPrecheck: {
              enabled: true,
              contextTokenBudget: contextTokenBudgetForGuard,
              reserveTokens: () => settingsManager.getCompactionReserveTokens(),
              toolResultMaxChars: toolResultMaxCharsForGuard,
              getSystemPrompt: () => systemPromptText,
              getPrePromptMessageCount: () => prePromptMessageCount,
              onMidTurnPrecheck,
            },
          }
        : {};
      if (activeContextEngine?.info.ownsCompaction === true) {
        const selectedContextEngineId = activeContextEngine.info.id;
        const contextEngineLoopRuntimeSettings = buildContextEngineRuntimeSettings({
          contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
          provider: params.provider,
          requestedModel: params.requestedModelId,
          resolvedModel: params.modelId,
          selectedContextEngineId,
          contextEngineSelectionSource:
            selectedContextEngineId === "legacy" ? "default" : "configured",
          promptTokenBudget: params.contextTokenBudget,
          fallbackReason: params.fallbackReason,
          degradedReason: params.degradedReason,
        });
        const removeContextEngineLoopHook = installContextEngineLoopHook({
          agent: activeSession.agent,
          contextEngine: activeContextEngine,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionTarget: params.sessionTarget,
          sessionFile: params.sessionFile,
          tokenBudget: params.contextTokenBudget,
          modelId: params.modelId,
          ...(transcriptPolicy.repairToolUseResultPairing
            ? {
                repairAssembledMessages: (messages) =>
                  repairAttemptToolUseResultPairing(messages, isOpenAIResponsesApi),
              }
            : {}),
          getPrePromptMessageCount: () => prePromptMessageCount,
          onAfterTurnCheckpoint: (messageCount) => {
            contextEngineAfterTurnCheckpoint = messageCount;
          },
          getRuntimeContext: ({ messages, prePromptMessageCount: loopPrePromptMessageCount }) =>
            buildAfterTurnRuntimeContext({
              attempt: params,
              workspaceDir: effectiveWorkspace,
              cwd: effectiveCwd,
              agentDir,
              tokenBudget: params.contextTokenBudget,
              promptCache:
                promptCache ??
                buildLoopPromptCacheInfo({
                  messagesSnapshot: messages,
                  prePromptMessageCount: loopPrePromptMessageCount,
                  retention: effectivePromptCacheRetention,
                  fallbackLastCacheTouchAt: readLastCacheTtlTimestamp(sessionManager, {
                    provider: params.provider,
                    modelId: params.modelId,
                  }),
                }),
            }),
          runtimeSettings: contextEngineLoopRuntimeSettings,
          isHeartbeat: isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind),
        });
        const removeGuard = installToolResultContextGuard({
          agent: activeSession.agent,
          contextWindowTokens: contextTokenBudgetForGuard,
          ...midTurnPrecheckOptions,
        });
        removeToolResultContextGuard = () => {
          removeGuard();
          removeContextEngineLoopHook();
        };
      } else {
        removeToolResultContextGuard = installToolResultContextGuard({
          agent: activeSession.agent,
          contextWindowTokens: contextTokenBudgetForGuard,
          ...midTurnPrecheckOptions,
        });
      }
      const removeLoopContextGuard = removeToolResultContextGuard;
      const removeHistoryImagePruneContextTransform = installHistoryImagePruneContextTransform(
        activeSession.agent,
      );
      const previousComputerFrameTransform = activeSession.agent.transformContext;
      activeSession.agent.transformContext = async (messages, signal) => {
        const transformed = previousComputerFrameTransform
          ? await previousComputerFrameTransform.call(activeSession.agent, messages, signal)
          : messages;
        const modelContext = Array.isArray(transformed) ? transformed : messages;
        invalidateComputerFrameIfMissing({
          contextEpoch: computerContextEpoch,
          messages: modelContext,
          imagesBlocked: settingsManager.getBlockImages(),
        });
        return modelContext;
      };
      removeToolResultContextGuard = () => {
        activeSession.agent.transformContext = previousComputerFrameTransform;
        removeHistoryImagePruneContextTransform();
        removeLoopContextGuard?.();
      };
      const cacheTrace = createCacheTrace({
        cfg: params.config,
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      const anthropicPayloadLogger = createAnthropicPayloadLogger({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      const trajectorySessionFile = await resolveAttemptTrajectorySessionFile({
        agentId: sessionAgentId,
        config: params.config,
        sessionFile: params.sessionFile,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        sessionTarget: params.sessionTarget,
      });
      trajectoryRecorder = params.disableTrajectory
        ? null
        : createTrajectoryRuntimeRecorder({
            cfg: params.config,
            env: process.env,
            runId: params.runId,
            sessionId: activeSession.sessionId,
            sessionKey: params.sessionKey,
            sessionFile: trajectorySessionFile,
            provider: params.provider,
            modelId: params.modelId,
            modelApi: params.model.api,
            workspaceDir: params.workspaceDir,
          });
      trajectoryRecorder?.recordEvent("session.started", {
        trigger: params.trigger,
        sessionFile: params.sessionFile,
        workspaceDir: effectiveWorkspace,
        agentId: sessionAgentId,
        messageProvider: params.messageProvider,
        messageChannel: params.messageChannel,
        localModelLean: localModelLeanEnabled,
        toolCount: effectiveTools.length,
        clientToolCount: clientToolDefs.length,
      });
      const trajectoryFastMode = typeof params.fastMode === "boolean" ? params.fastMode : undefined;
      trajectoryRecorder?.recordEvent(
        "trace.metadata",
        buildTrajectoryRunMetadata({
          env: process.env,
          config: params.config,
          workspaceDir: effectiveWorkspace,
          sessionFile: params.sessionFile,
          sessionKey: params.sessionKey,
          agentId: sessionAgentId,
          trigger: params.trigger,
          messageProvider: params.messageProvider,
          messageChannel: params.messageChannel,
          provider: params.provider,
          modelId: params.modelId,
          modelApi: params.model.api,
          timeoutMs: params.timeoutMs,
          fastMode: trajectoryFastMode,
          thinkLevel: params.thinkLevel,
          reasoningLevel: params.reasoningLevel,
          toolResultFormat: params.toolResultFormat,
          disableTools: params.disableTools,
          toolsAllow: params.toolsAllow,
          skillsSnapshot: params.skillsSnapshot,
          systemPromptReport,
        }),
      );

      const {
        effectiveAgentTransport,
        effectiveExtraParams,
        effectivePromptCacheRetention,
        providerTextTransforms,
        streamStrategy,
      } = await prepareEmbeddedAttemptTransport({
        attempt: params,
        session: activeSession,
        settingsManager,
        providerThinkingLevel,
        sessionAgentId,
        workspaceDir: effectiveWorkspace,
        agentDir,
        abortSignal: runAbortController.signal,
        getProviderRuntimeHandle,
        sandboxSessionKey,
        sandbox,
        codeModeControlsEnabled: codeModeControlsEnabledForRun,
      });
      const { cacheObservabilityEnabled, promptCacheToolNames } =
        installEmbeddedAttemptStreamGuards({
          attempt: params,
          session: activeSession,
          sessionAgentId,
          cacheTrace,
          allCustomTools,
          systemPromptText,
          transcriptPolicy,
          sessionManager,
          sessionLockController,
          isOpenAIResponsesApi,
          replayAllowedToolNames,
          liveAllowedToolNames,
          isYieldDetected: () => yieldDetected,
          clientToolLoopDetection,
          anthropicPayloadLogger,
          onRejectedThinkingReplayRepaired: () => {
            repairedRejectedThinkingReplay = true;
          },
          onIdleTimeout: (error) => idleTimeoutTrigger?.(error),
          effectiveAgentTransport,
          providerTextTransforms,
          abortSignal: runAbortController.signal,
          runTrace,
        });
      prepStages.mark("stream-setup");
      emitPrepStageSummary("stream-ready");
      let promptCacheChangesForTurn: PromptCacheChange[] | null = null;

      let preparedHistory: Awaited<ReturnType<typeof prepareEmbeddedAttemptHistory>>;
      try {
        preparedHistory = await prepareEmbeddedAttemptHistory({
          attempt: params,
          activeSession,
          sessionManager,
          ...(activeContextEngine ? { activeContextEngine } : {}),
          cacheTrace,
          capabilityToolNames,
          effectiveWorkspace,
          isOpenAIResponsesApi,
          isRawModelRun,
          ...(orphanRepair ? { orphanRepair } : {}),
          replayAllowedToolNames,
          sessionAgentId,
          settingsManager,
          systemPromptText,
          transcriptPolicy,
          setActiveSessionSystemPrompt,
        });
      } catch (err) {
        await flushPendingToolResultsAfterIdle({
          agent: activeSession?.agent,
          sessionManager,
          // PERF: If the run was aborted during the setup,
          // skip the idle wait and flush pending results synchronously so we can
          // immediately dispose the session without orphaning tool calls.
          ...(params.abortSignal?.aborted ? { timeoutMs: 0 } : {}),
        });
        activeSession.dispose();
        throw err;
      }
      const {
        contextEnginePromptAuthority,
        contextEngineAssemblySucceeded,
        unwindowedContextEngineMessagesForPrecheck,
      } = preparedHistory;

      let yieldAborted = false;
      const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
      const abortCompaction = () => {
        if (!activeSession.isCompacting) {
          return;
        }
        try {
          activeSession.abortCompaction();
        } catch (err) {
          if (!isProbeSession) {
            log.warn(
              `embedded run abortCompaction failed: runId=${params.runId} sessionId=${params.sessionId} err=${String(err)}`,
            );
          }
        }
      };
      const abortRun = (isTimeout = false, reason?: unknown) => {
        aborted = true;
        if (isTimeout) {
          timedOut = true;
          if (!timedOutDuringCompaction && countActiveToolExecutions(params.runId) > 0) {
            timedOutDuringToolExecution = true;
          }
        }
        if (isTimeout) {
          const timeoutReason = reason instanceof Error ? reason : makeTimeoutAbortReason();
          params.onAttemptTimeout?.(timeoutReason);
          runAbortController.abort(timeoutReason);
        } else {
          runAbortController.abort(reason);
        }
        abortCompaction();
        void abortActiveSession();
        if (isTimeout && queueHandleForAbandonment) {
          markActiveEmbeddedRunAbandoned({
            sessionId: params.sessionId,
            handle: queueHandleForAbandonment,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
            reason: "timeout",
          });
        }
        releaseEmbeddedAttemptSessionLockForAbort({
          sessionLockController,
          log,
          runId: params.runId,
          abortKind: isTimeout ? "timeout abort" : "abort",
        });
      };
      abortRunForExternalSignal = abortRun;
      const idleTimeoutTrigger: ((error: Error) => void) | undefined = (error) => {
        idleTimedOut = true;
        abortRun(true, error);
      };
      const abortable = <T>(promise: Promise<T>): Promise<T> =>
        abortableWithSignal(runAbortController.signal, promise);
      const promptActiveSession = (
        prompt: string,
        options?: Parameters<typeof activeSession.prompt>[1],
      ): Promise<void> =>
        withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
          abortable(trackPromptSettlePromise(activeSession.prompt(prompt, options))),
        );
      // Hook runner was already obtained earlier before tool creation.
      const hookAgentId = sessionAgentId;
      const onBlockReply = params.onBlockReply
        ? bindOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, params.onBlockReply)
        : undefined;
      const onBlockReplyFlush = params.onBlockReplyFlush
        ? bindOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, params.onBlockReplyFlush)
        : undefined;
      const preparedStream = prepareEmbeddedAttemptStream({
        attempt: params,
        activeSession,
        runtimeChannel,
        hookRunner,
        hookAgentId,
        diagnosticTrace,
        clientToolCallSlots,
        toolSearchTargetTranscriptProjections,
        isReplaySafeTool: (tool) => replaySafeTools.has(tool as never),
        runAbortController,
        abortRun,
        markExternalAbort: () => {
          externalAbort = true;
        },
        getRunState: () => ({
          aborted,
          promptError,
          timedOut,
          yieldDetected,
        }),
        hasDeliveredSourceReply,
        markSourceReplyDelivered,
        onBlockReply,
        onBlockReplyFlush,
        sandboxSessionKey,
        ...subscriptionToolTrust,
      });
      const {
        subscription,
        queueHandle,
        stopAcceptingSteerMessages,
        getBeforeAgentFinalizeRevisionReason,
      } = preparedStream;
      const { unsubscribe, waitForPendingEvents } = subscription;
      toolSearchCatalogExecutor = preparedStream.toolSearchCatalogExecutor;
      isCompactionPendingForExternalSignal = subscription.isCompacting;
      isCompactionInFlightForExternalSignal = () => activeSession.isCompacting;
      let lastAssistant: AssistantMessage | undefined;
      let currentAttemptAssistant: EmbeddedRunAttemptResult["currentAttemptAssistant"];
      let attemptUsage: NormalizedUsage | undefined;
      let cacheBreak: PromptCacheBreak | null = null;
      let promptCache: EmbeddedRunAttemptResult["promptCache"];
      let lastCallUsage: NormalizedUsage | undefined;
      let contextBudgetStatus: EmbeddedRunAttemptResult["contextBudgetStatus"];
      let compactionOccurredThisAttempt = false;
      let finalPromptText: string | undefined;
      const queueHandleForAbandonment: EmbeddedAgentQueueHandle | undefined = queueHandle;

      const attemptTimeout = prepareEmbeddedAttemptTimeout({
        attempt: params,
        activeSession,
        compactionState: subscription,
        compactionTimeoutMs,
        isProbeSession,
        abortRun,
        markExternalAbort: () => {
          externalAbort = true;
        },
        markTimedOutDuringCompaction: () => {
          timedOutDuringCompaction = true;
        },
        markTimedOutByRunBudget: () => {
          timedOutByRunBudget = true;
        },
      });
      const {
        getRunAbortDeadlineAtMs,
        clearTimers: clearAttemptTimeoutTimers,
        removeAbortSignalListener: removeAttemptAbortSignalListener,
      } = attemptTimeout;
      let messagesSnapshot: AgentMessage[] = [];
      let sessionIdUsed = activeSession.sessionId;
      let sessionFileUsed: string | undefined = params.sessionFile;

      const activeSessionManager = sessionManager;
      let preflightRecovery: EmbeddedRunAttemptResult["preflightRecovery"];
      let promptErrorSource: EmbeddedRunAttemptResult["promptErrorSource"] = null;
      const handleMidTurnPrecheckRequest = (request: MidTurnPrecheckRequest) => {
        const outcome = handleEmbeddedAttemptMidTurnPrecheck({
          attempt: params,
          request,
          sessionAgentId,
          sessionManager: activeSessionManager,
          prePromptMessageCount,
          replaceSessionMessages: (messages) => {
            activeSession.agent.state.messages = messages;
          },
        });
        preflightRecovery = outcome.preflightRecovery;
        if (outcome.promptError) {
          promptError = outcome.promptError;
          promptErrorSource = "precheck";
        }
      };
      let skipPromptSubmission = false;
      let leasedSteering:
        | {
            leaseId: string;
            runIds: readonly string[];
          }
        | undefined;
      const releaseLeasedSteering = (error?: unknown) => {
        if (!leasedSteering) {
          return;
        }
        releasePendingAgentSteeringItems({
          runIds: leasedSteering.runIds,
          leaseId: leasedSteering.leaseId,
          error: error ? formatErrorMessage(error) : undefined,
        });
        leasedSteering = undefined;
      };
      try {
        const promptStartedAt = Date.now();
        if (emptyExplicitToolAllowlistError) {
          promptError = emptyExplicitToolAllowlistError;
          promptErrorSource = "precheck";
          skipPromptSubmission = true;
          log.warn(`[tools] ${emptyExplicitToolAllowlistError.message}`);
        }

        const promptAssembly = await prepareEmbeddedAttemptPromptAssembly({
          attempt: params,
          activeSession,
          sessionManager,
          hookRunner,
          hookAgentId,
          diagnosticTrace,
          isRawModelRun,
          ...(orphanRepair ? { orphanRepair } : {}),
          sessionAgentId,
          runtimeModel: runtimeInfo.model,
          systemPromptText,
          setActiveSessionSystemPrompt,
          setLeasedSteering: (lease) => {
            leasedSteering = lease;
          },
          cache: {
            observabilityEnabled: cacheObservabilityEnabled,
            retention: effectivePromptCacheRetention,
            streamStrategy,
            transport: effectiveAgentTransport,
            toolNames: promptCacheToolNames,
            trace: cacheTrace,
          },
        });
        const { hookCtx, promptBuildPrependContext, promptBuildAppendContext, transcriptLeafId } =
          promptAssembly;
        leasedSteering = promptAssembly.leasedSteering ?? leasedSteering;
        promptCacheChangesForTurn = promptAssembly.promptCacheChangesForTurn;

        try {
          const promptContext = prepareEmbeddedAttemptPromptContext({
            attempt: params,
            ...(boundaryTimezone ? { boundaryTimezone } : {}),
            includeBoundaryTimestamp,
            isRawModelRun,
            messages: activeSession.messages,
            ...(typeof preparedUserTurnMessage?.timestamp === "number"
              ? { preparedUserTurnTimestamp: preparedUserTurnMessage.timestamp }
              : {}),
            prompt: promptAssembly,
            replaceSessionMessages: (messages) => {
              activeSession.agent.state.messages = messages;
            },
            sessionAgentId,
            setActiveSessionSystemPrompt,
            ...(systemPromptReport ? { systemPromptReport } : {}),
            systemPromptText,
            toolResultPromptProjectionState,
          });
          const {
            aggregatePressureEngaged,
            contextTokenBudget,
            effectivePrompt,
            hookMessagesForCurrentPrompt,
            llmBoundaryPromptForPrecheck,
            promptForModel,
            promptForSession,
            promptSubmission,
            promptToolResultAggregateMaxChars,
            promptToolResultMaxChars,
            runtimeContextMessageForCurrentTurn,
            systemPromptForHook,
          } = promptContext;
          prePromptMessageCount = promptContext.prePromptMessageCount;
          currentUserTimestampOverride = promptContext.currentUserTimestampOverride;
          if (aggregatePressureEngaged) {
            // Compaction and aggregate truncation both target about half the window;
            // compact-then-truncate prevents re-hitting the same cap on the next turn.
            preflightRecovery = { route: "compact_then_truncate" };
            promptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
            promptErrorSource = "precheck";
            skipPromptSubmission = true;
          }

          const beforeAgentRunOutcome = await runEmbeddedAttemptBeforeAgentRun({
            attempt: params,
            activeSession,
            hookContext: hookCtx,
            hookMessages: hookMessagesForCurrentPrompt,
            hookRunner,
            modelPrompt: promptForModel,
            sessionManager: activeSessionManager,
            systemPrompt: systemPromptForHook,
            withOwnedSessionWriteLock,
          });
          if (beforeAgentRunOutcome) {
            beforeAgentRunBlocked = true;
            beforeAgentRunBlockedBy = beforeAgentRunOutcome.blockedBy;
            promptError = beforeAgentRunOutcome.promptError;
            promptErrorSource = "hook:before_agent_run";
            skipPromptSubmission = true;
          }

          if (!skipPromptSubmission) {
            const googlePromptCacheStreamFn = await prepareGooglePromptCacheStreamFn({
              apiKey: await resolveEmbeddedAgentApiKey({
                provider: params.provider,
                resolvedApiKey: params.resolvedApiKey,
                authStorage: params.authStorage,
              }),
              extraParams: effectiveExtraParams,
              model: params.model,
              modelId: params.modelId,
              provider: params.provider,
              sessionManager: {
                appendCustomEntry: async (customType, data) => {
                  await withOwnedSessionWriteLock(() => {
                    activeSessionManager.appendCustomEntry(customType, data);
                  });
                },
                getEntries: () => activeSessionManager.getEntries(),
              },
              signal: runAbortController.signal,
              streamFn: activeSession.agent.streamFn,
              systemPrompt: systemPromptText,
            });
            if (googlePromptCacheStreamFn) {
              activeSession.agent.streamFn = googlePromptCacheStreamFn;
            }
            installPromptSubmissionLockRelease({
              session: activeSession,
              waitForSessionEvents: (sessionToDrain) =>
                sessionLockController.waitForSessionEvents(sessionToDrain),
              releaseForPrompt: () => sessionLockController.releaseForPrompt(),
              reacquireAfterPrompt: () => sessionLockController.reacquireAfterPrompt(),
              sessionKey: params.sessionKey,
              sessionFile: params.sessionFile,
              withSessionWriteLock: (run, options) =>
                sessionLockController.withSessionWriteLock(run, options),
              canAdvanceSessionEntryCache: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
                sessionLockController.canAdvanceSessionEntryCache(snapshot),
              publishSessionFileSnapshot: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
                sessionLockController.publishOwnedSessionFileSnapshot(snapshot),
            });
          }

          // Detect and load images referenced in the visible prompt for vision-capable models.
          // Images are prompt-local only.
          const imageResult = skipPromptSubmission
            ? {
                images: [],
                detectedRefs: [],
                loadedCount: 0,
                skippedCount: 0,
              }
            : await detectAndLoadPromptImages({
                prompt: promptSubmission.prompt,
                workspaceDir: effectiveWorkspace,
                model: params.model,
                existingImages: params.images,
                imageOrder: params.imageOrder,
                maxBytes: MAX_IMAGE_BYTES,
                maxDimensionPx: resolveImageSanitizationLimits(params.config).maxDimensionPx,
                workspaceOnly: effectiveFsWorkspaceOnly,
                // Enforce sandbox path restrictions when sandbox is enabled
                sandbox:
                  sandbox?.enabled && sandbox?.fsBridge
                    ? { root: sandbox.workspaceDir, bridge: sandbox.fsBridge }
                    : undefined,
              });

          if (!skipPromptSubmission) {
            cacheTrace?.recordStage("prompt:before", {
              prompt: promptForModel,
              messages: activeSession.messages,
            });
            cacheTrace?.recordStage("prompt:images", {
              prompt: promptForModel,
              messages: activeSession.messages,
              note: `images: prompt=${imageResult.images.length}`,
            });
            const trajectoryProviderVisibleTools = toTrajectoryToolDefinitions(effectiveTools);
            trajectoryRecorder?.recordEvent("context.compiled", {
              systemPrompt: systemPromptForHook,
              prompt: promptForModel,
              messages: activeSession.messages,
              tools: toTrajectoryToolDefinitions(
                toolSearch.compacted ? uncompactedEffectiveTools : effectiveTools,
              ),
              ...(toolSearch.compacted
                ? { providerVisibleTools: trajectoryProviderVisibleTools }
                : {}),
              imagesCount: imageResult.images.length,
              streamStrategy,
              transport: effectiveAgentTransport,
              transcriptLeafId,
            });
          }

          const promptSkipReason = skipPromptSubmission
            ? null
            : resolvePromptSubmissionSkipReason({
                prompt: promptForModel,
                messages: activeSession.messages,
                runtimeOnly: promptSubmission.runtimeOnly,
                imageCount: imageResult.images.length,
              });
          if (promptSkipReason) {
            skipPromptSubmission = true;
            const skipContext =
              `runId=${params.runId} sessionId=${params.sessionId} trigger=${params.trigger} ` +
              `provider=${params.provider}/${params.modelId}`;
            if (promptSkipReason === "blank_user_prompt") {
              log.warn(`embedded run prompt skipped: blank user prompt ${skipContext}`);
            } else {
              log.info(`embedded run prompt skipped: empty prompt/history/images ${skipContext}`);
            }
            trajectoryRecorder?.recordEvent("prompt.skipped", {
              reason: promptSkipReason,
              prompt: promptForModel,
              messages: activeSession.messages,
              imagesCount: imageResult.images.length,
            });
          }

          const msgCount = activeSession.messages.length;
          const systemLen = systemPromptText?.length ?? 0;
          const promptLen = effectivePrompt.length;
          const sessionSummary = summarizeSessionContext(activeSession.messages);
          const reserveTokens = settingsManager.getCompactionReserveTokens();
          emitTrustedDiagnosticEvent({
            type: "context.assembled",
            runId: params.runId,
            ...(params.sessionKey && { sessionKey: params.sessionKey }),
            ...(params.sessionId && { sessionId: params.sessionId }),
            provider: params.provider,
            model: params.modelId,
            ...((params.messageChannel ?? params.messageProvider)
              ? { channel: params.messageChannel ?? params.messageProvider }
              : {}),
            trigger: params.trigger,
            messageCount: msgCount,
            historyTextChars: sessionSummary.totalTextChars,
            historyImageBlocks: sessionSummary.totalImageBlocks,
            maxMessageTextChars: sessionSummary.maxMessageTextChars,
            systemPromptChars: systemLen,
            promptChars: promptLen,
            promptImages: imageResult.images.length,
            contextTokenBudget,
            reserveTokens,
            trace: freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(runTrace)),
          });
          params.onExecutionPhase?.({
            phase: "context_assembled",
            provider: params.provider,
            model: params.modelId,
          });

          // Diagnostic: log context sizes before prompt to help debug early overflow errors.
          if (log.isEnabled("debug")) {
            log.debug(
              `[context-diag] pre-prompt: sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `messages=${msgCount} roleCounts=${sessionSummary.roleCounts} ` +
                `historyTextChars=${sessionSummary.totalTextChars} ` +
                `maxMessageTextChars=${sessionSummary.maxMessageTextChars} ` +
                `historyImageBlocks=${sessionSummary.totalImageBlocks} ` +
                `systemPromptChars=${systemLen} promptChars=${promptLen} ` +
                `promptImages=${imageResult.images.length} ` +
                `provider=${params.provider}/${params.modelId} sessionFile=${params.sessionFile}`,
            );
          }

          if (!skipPromptSubmission && !isRawModelRun && hookRunner?.hasHooks("llm_input")) {
            hookRunner
              .runLlmInput(
                {
                  runId: params.runId,
                  sessionId: params.sessionId,
                  provider: params.provider,
                  model: params.modelId,
                  systemPrompt: systemPromptForHook,
                  prompt: llmBoundaryPromptForPrecheck,
                  historyMessages: cloneHookMessages(hookMessagesForCurrentPrompt),
                  imagesCount: imageResult.images.length,
                  tools,
                },
                {
                  runId: params.runId,
                  trace: freezeDiagnosticTraceContext(diagnosticTrace),
                  agentId: hookAgentId,
                  sessionKey: params.sessionKey,
                  sessionId: params.sessionId,
                  workspaceDir: params.workspaceDir,
                  trigger: params.trigger,
                  ...buildAgentHookContextChannelFields(params),
                  ...buildAgentHookContextIdentityFields({
                    trigger: params.trigger,
                    senderId: params.senderId,
                    chatId: params.chatId,
                    channelContext: params.channelContext,
                  }),
                },
              )
              .catch((err: unknown) => {
                log.warn(`llm_input hook failed: ${String(err)}`);
              });
          }

          const promptPreflight = await prepareEmbeddedAttemptPromptPreflight({
            attempt: params,
            ...(activeContextEngine ? { activeContextEngine } : {}),
            contextEngineAssemblySucceeded,
            contextEnginePromptAuthority,
            contextTokenBudget,
            hookMessagesForCurrentPrompt,
            includeBoundaryTimestamp,
            promptForPrecheck: llmBoundaryPromptForPrecheck,
            reserveTokens,
            sessionAgentId,
            sessionManager: activeSessionManager,
            sessionMessageCount: activeSession.messages.length,
            state: {
              contextBudgetStatus,
              preflightRecovery,
              promptError,
              promptErrorSource,
              skipPromptSubmission,
            },
            systemPrompt: systemPromptForHook,
            ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
            toolResultMaxChars: promptToolResultMaxChars,
            ...(unwindowedContextEngineMessagesForPrecheck
              ? { unwindowedContextEngineMessagesForPrecheck }
              : {}),
            withOwnedSessionWriteLock,
          });
          ({
            contextBudgetStatus,
            preflightRecovery,
            promptError,
            promptErrorSource,
            skipPromptSubmission,
          } = promptPreflight);

          if (!skipPromptSubmission) {
            await submitEmbeddedAttemptPrompt({
              attempt: params,
              activeSession,
              ...(promptBuildAppendContext ? { appendContext: promptBuildAppendContext } : {}),
              contextTokenBudget,
              images: imageResult.images,
              ...(leasedSteering ? { leasedSteering } : {}),
              modelPrompt: promptForModel,
              onFinalPromptText: (prompt) => {
                finalPromptText = prompt;
              },
              onSteeringAcknowledged: () => {
                leasedSteering = undefined;
              },
              ...(promptBuildPrependContext ? { prependContext: promptBuildPrependContext } : {}),
              promptActiveSession,
              ...(runtimeContextMessageForCurrentTurn
                ? { runtimeContextMessage: runtimeContextMessageForCurrentTurn }
                : {}),
              runtimeOnly: promptSubmission.runtimeOnly === true,
              sessionPromptState,
              systemPrompt: systemPromptForHook,
              toolResultAggregateMaxChars: promptToolResultAggregateMaxChars,
              toolResultMaxChars: promptToolResultMaxChars,
              toolResultPromptProjectionState,
              trajectoryRecorder,
              transcriptLeafId,
              transcriptPrompt: promptForSession,
            });
          } else {
            releaseLeasedSteering(promptError ?? "prompt submission skipped");
          }
        } catch (err) {
          releaseLeasedSteering(err);
          yieldAborted = yieldDetected && isSessionsYieldAbortError(err);
          cleanupYieldAborted = yieldAborted;
          if (yieldAborted) {
            aborted = false;
            await waitForSessionsYieldAbortSettle({
              settlePromise: yieldAbortSettled,
              runId: params.runId,
              sessionId: params.sessionId,
            });
            await sessionLockController.releaseHeldLockForAbort();
            await sessionLockController.waitForSessionEvents(activeSession);
            await withOwnedSessionWriteLock(async () => {
              stripSessionsYieldArtifacts(activeSession);
              if (yieldMessage) {
                await persistSessionsYieldContextMessage(activeSession, yieldMessage);
              }
            });
          } else if (isMidTurnPrecheckSignal(err)) {
            await sessionLockController.waitForSessionEvents(activeSession);
            await withOwnedSessionWriteLock(() => {
              handleMidTurnPrecheckRequest(err.request);
            });
          } else {
            promptError = err;
            promptErrorSource = "prompt";
          }
        } finally {
          stopAcceptingSteerMessages();
          log.debug(
            `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
          );
        }

        if (pendingMidTurnPrecheckRequest) {
          const request = pendingMidTurnPrecheckRequest;
          pendingMidTurnPrecheckRequest = null;
          await sessionLockController.waitForSessionEvents(activeSession);
          await withOwnedSessionWriteLock(() => {
            removeTrailingMidTurnPrecheckAssistantError({
              activeSession,
              sessionManager: activeSessionManager,
            });
            if (!preflightRecovery && promptErrorSource !== "precheck") {
              promptError = null;
              promptErrorSource = null;
              handleMidTurnPrecheckRequest(request);
            }
          });
        }

        await sessionLockController.waitForSessionEvents(activeSession);
        await waitForPendingEvents();
        if (repairedRejectedThinkingReplay) {
          activeSession.agent.state.messages = activeSessionManager.buildSessionContext().messages;
        }
        await sessionLockController.releaseForPrompt();

        const streamSettleState = {
          promptError,
          promptErrorSource,
          yieldAborted,
          sessionIdUsed,
        };
        const settledStream = await settleEmbeddedAttemptStream({
          attempt: params,
          activeSession,
          sessionManager: activeSessionManager,
          sessionLockController,
          withOwnedSessionWriteLock,
          subscription,
          state: streamSettleState,
          readLifecycleState: () => ({
            aborted,
            timedOut,
            timedOutDuringCompaction,
          }),
          markTimedOutDuringCompaction: () => {
            timedOutDuringCompaction = true;
          },
          runAbortDeadlineAtMs: getRunAbortDeadlineAtMs(),
          runAbortSignal: runAbortController.signal,
          isProbeSession,
          onBlockReplyFlush,
          abortable,
          prePromptMessageCount,
          toolSearchTargetTranscriptProjections,
          cache: {
            observabilityEnabled: cacheObservabilityEnabled,
            changesForTurn: promptCacheChangesForTurn,
            retention: effectivePromptCacheRetention,
          },
          shouldFlushForContextEngine: Boolean(
            activeContextEngine && !getBeforeAgentFinalizeRevisionReason(),
          ),
        }).catch((err: unknown) => {
          // Preserve the outer lifecycle flags when settlement fails after
          // recording a timeout or prompt error.
          promptError = streamSettleState.promptError;
          promptErrorSource = streamSettleState.promptErrorSource;
          throw err;
        });
        promptError = settledStream.promptError;
        promptErrorSource = settledStream.promptErrorSource;
        timedOutDuringCompaction = settledStream.timedOutDuringCompaction;
        compactionOccurredThisAttempt = settledStream.compactionOccurredThisAttempt;
        messagesSnapshot = settledStream.messagesSnapshot;
        sessionIdUsed = settledStream.sessionIdUsed;
        lastAssistant = settledStream.lastAssistant;
        currentAttemptAssistant = settledStream.currentAttemptAssistant;
        attemptUsage = settledStream.attemptUsage;
        cacheBreak = settledStream.cacheBreak;
        lastCallUsage = settledStream.lastCallUsage;
        promptCache = settledStream.promptCache;

        const beforeAgentFinalizeRevisionReason = getBeforeAgentFinalizeRevisionReason();
        const afterTurn = await completeEmbeddedAttemptAfterTurn({
          attempt: params,
          activeContextEngine,
          activeSession,
          sessionManager: activeSessionManager,
          sessionLockController,
          withOwnedSessionWriteLock,
          state: {
            promptError,
            yieldAborted,
            sessionIdUsed,
            sessionFileUsed,
            messagesSnapshot,
            prePromptMessageCount,
            contextEngineAfterTurnCheckpoint,
            lastCallUsage,
            promptCache,
            ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
            compactionOccurredThisAttempt,
          },
          readLifecycleState: () => ({
            aborted,
            timedOut,
            idleTimedOut,
            timedOutDuringCompaction,
          }),
          runtime: {
            effectiveWorkspace,
            agentDir,
            sessionAgentId,
            resolveActiveContextEnginePluginId,
            shouldRecordCompletedBootstrapTurn,
            cacheTrace,
            anthropicPayloadLogger,
            hookAgentId,
            diagnosticTrace,
            skillWorkshopAvailable: uncompactedEffectiveTools.some(
              (tool) => tool.name === "skill_workshop",
            ),
            hookRunner,
            promptStartedAt,
          },
        });
        sessionIdUsed = afterTurn.sessionIdUsed;
        sessionFileUsed = afterTurn.sessionFileUsed;
      } finally {
        clearAttemptTimeoutTimers();
        if (!isProbeSession && (aborted || timedOut) && !timedOutDuringCompaction) {
          log.debug(
            `run cleanup: runId=${params.runId} sessionId=${params.sessionId} aborted=${aborted} timedOut=${timedOut}`,
          );
        }
        try {
          unsubscribe();
        } catch (err) {
          // unsubscribe() should never throw; if it does, it indicates a serious bug.
          // Log at error level to ensure visibility, but don't rethrow in finally block
          // as it would mask any exception from the try block above.
          log.error(
            `CRITICAL: unsubscribe failed, possible resource leak: runId=${params.runId} ${String(err)}`,
          );
        }
        if (params.replyOperation) {
          params.replyOperation.detachBackend(queueHandle);
        }
        clearActiveEmbeddedRun(
          params.sessionId,
          queueHandle,
          params.sessionKey,
          params.sessionFile,
        );
        removeAttemptAbortSignalListener();
      }

      const beforeAgentFinalizeRevisionReason = getBeforeAgentFinalizeRevisionReason();
      const finalizedResult = completeEmbeddedAttemptResult({
        attempt: params,
        subscription,
        state: {
          aborted,
          externalAbort,
          timedOut,
          idleTimedOut,
          timedOutDuringCompaction,
          timedOutDuringToolExecution,
          timedOutByRunBudget,
          promptError,
          promptErrorSource,
          preflightRecovery,
          sessionIdUsed,
          sessionFileUsed,
          diagnosticTrace,
          systemPromptReport,
          finalPromptText,
          messagesSnapshot,
          ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
          lastAssistant,
          currentAttemptAssistant,
          attemptUsage,
          promptCache,
          contextBudgetStatus,
          yieldDetected,
          didDeliverSourceReplyViaMessageTool: hasDeliveredSourceReply(),
        },
        clientToolCallSlots,
        hookRunner,
        hookAgentId,
        bootstrapPromptWarning,
        cache: {
          observabilityEnabled: cacheObservabilityEnabled,
          trace: cacheTrace,
          break: cacheBreak,
          changesForTurn: promptCacheChangesForTurn,
          streamStrategy,
        },
        trajectoryRecorder,
      });
      trajectoryEndRecorded = true;
      return finalizedResult;
    } finally {
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
        trajectoryEndRecorded,
        cleanupYieldAborted,
        emitDiagnosticRunCompleted,
        readState: () => ({
          aborted,
          externalAbort,
          timedOut,
          idleTimedOut,
          timedOutDuringCompaction,
          timedOutDuringToolExecution,
          timedOutByRunBudget,
          promptError,
          beforeAgentRunBlocked,
          beforeAgentRunBlockedBy,
        }),
      });
    }
  } finally {
    removeExternalAbortSignalListener?.();
    clearToolActivityRun(params.runId);
    if (!sessionCleanupOwnsEmbeddedResources) {
      try {
        await cleanupEmbeddedPrepResourcesAfterEarlyExit();
      } catch (cleanupErr) {
        log.warn(
          `failed to clean up embedded prep resources after early attempt exit: runId=${params.runId} ${String(cleanupErr)}`,
        );
      }
    }
    try {
      await releaseRetainedSessionLock?.();
    } catch (releaseErr) {
      log.error(
        `failed to release retained session lock on attempt teardown: runId=${params.runId} ${String(releaseErr)}`,
      );
    }
    retainedSessionFileOwner?.release();
    emitDiagnosticRunCompleted?.(
      aborted ? "aborted" : "error",
      promptError ?? new Error("run exited before diagnostic completion"),
    );
    restoreSkillEnv?.();
  }
}
