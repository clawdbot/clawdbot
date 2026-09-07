/** Prepares the session-owned runtime used by one embedded attempt. */
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { createCacheTrace } from "../../cache-trace.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import type { AgentSession } from "../../sessions/index.js";
import { readCacheTtlEntries } from "../cache-ttl.js";
import { getProviderPromptState } from "../provider-prompt-state.js";
import { getEmbeddedSessionPromptState } from "../session-prompt-state.js";
import { restoreCacheTtlToolResultProjections } from "../tool-result-truncation.js";
import type { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import type { AttemptContextEngine } from "./attempt-context-engine-helpers.js";
import {
  prepareEmbeddedAttemptAgentSession,
  prepareEmbeddedAttemptSessionBoundary,
  prepareEmbeddedAttemptSessionManager,
} from "./attempt-session-prepare.js";
import {
  createEmbeddedAttemptSessionSettleTracker,
  type EmbeddedAttemptSessionResources,
} from "./attempt-session-settle.js";
import { installEmbeddedAttemptContextGuards, type EmbeddedAttemptSetup } from "./attempt-setup.js";
import { prepareEmbeddedAttemptTransport } from "./attempt-stream-settle.js";
import type { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import type { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import { prepareEmbeddedAttemptTrajectory } from "./attempt-trajectory.js";
import type { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import type {
  EmbeddedAttemptExternalAbortController,
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./types.js";

type SessionSettleTracker = ReturnType<typeof createEmbeddedAttemptSessionSettleTracker>;

type EmbeddedAttemptSessionRuntimeState = {
  currentTurnImageFailureCount: number;
  prePromptMessageCount: number;
  promptCache: EmbeddedRunAttemptResult["promptCache"];
  systemPromptText: string;
};

export async function prepareEmbeddedAttemptSessionRuntime(input: {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: AttemptContextEngine;
  agentDir: string;
  isRawModelRun: boolean;
  resolveActiveContextEnginePluginId: () => string | undefined;
  setup: EmbeddedAttemptSetup;
  toolBase: ReturnType<typeof prepareEmbeddedAttemptToolBase>;
  toolCatalog: ReturnType<typeof prepareEmbeddedAttemptToolCatalog>;
  bundleTools: Awaited<ReturnType<typeof prepareEmbeddedAttemptBundleTools>>;
  systemPrompt: Awaited<ReturnType<typeof prepareEmbeddedAttemptSystemPrompt>>;
  sessionLock: Awaited<ReturnType<typeof prepareEmbeddedAttemptTranscriptLifecycle>>;
  runAbortSignal: AbortSignal;
  externalAbortController: Pick<EmbeddedAttemptExternalAbortController, "setActiveSessionAbort">;
  resources: EmbeddedAttemptSessionResources;
  onSessionYieldReady: (input: {
    abortActiveSession: SessionSettleTracker["abortActiveSession"];
    activeSession: AgentSession;
  }) => void;
}) {
  const { attempt, resources, runAbortSignal, sessionLock, toolBase } = input;
  const {
    agentCoreThinkingLevel,
    effectiveCwd,
    effectiveFsWorkspaceOnly,
    effectiveWorkspace,
    getCurrentAttemptPluginMetadataSnapshot,
    getProviderRuntimeHandle,
    prepStages,
    providerThinkingLevel,
    sandbox,
    sandboxSessionKey,
    sessionAgentId,
  } = input.setup;
  const {
    catalogToolHookContext,
    deferredDirectoryToolsCallable,
    effectiveTools,
    toolSearchRunPlan,
  } = input.toolCatalog;
  const { clientTools, uncompactedEffectiveTools } = input.bundleTools;
  const {
    codeModeControlsEnabledForRun,
    computerContextEpoch,
    localModelLeanEnabled,
    replaySafetyOptions,
    toolSearchCatalogRef,
    toolSearchRuntimeConfig,
  } = toolBase;
  const { systemPromptReport, systemPromptText } = input.systemPrompt;
  const effectiveToolCount = effectiveTools.length;
  const preparedSessionManager = await prepareEmbeddedAttemptSessionManager({
    attempt,
    ...(input.activeContextEngine ? { activeContextEngine: input.activeContextEngine } : {}),
    agentDir: input.agentDir,
    effectiveCwd,
    effectiveWorkspace,
    onSessionManagerCreated: (manager) => {
      resources.sessionManager = manager;
    },
    replayAllowedToolNames: toolSearchRunPlan.replayAllowedToolNames,
    resolveActiveContextEnginePluginId: input.resolveActiveContextEnginePluginId,
    sessionAgentId,
    transcriptLifecycle: sessionLock.transcriptLifecycle,
    withOwnedTranscriptWrite: sessionLock.withOwnedTranscriptWrite,
  });
  const { isOpenAIResponsesApi, preparedUserTurnMessage, sessionManager, transcriptPolicy } =
    preparedSessionManager;

  const state: EmbeddedAttemptSessionRuntimeState = {
    currentTurnImageFailureCount: 0,
    prePromptMessageCount: 0,
    promptCache: undefined,
    systemPromptText,
  };
  const preparedAgentSession = await prepareEmbeddedAttemptAgentSession({
    attempt,
    ...(input.activeContextEngine
      ? { activeContextEngineInfo: input.activeContextEngine.info }
      : {}),
    agentCoreThinkingLevel,
    agentDir: input.agentDir,
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
      getToolAbortSignal: () => toolBase.toolAbortSignal,
    },
    effectiveCwd,
    getCurrentAttemptPluginMetadataSnapshot,
    initialSystemPrompt: state.systemPromptText,
    markStage: (stage) => prepStages.mark(stage),
    onSessionCreated: (session) => {
      resources.session = session;
    },
    onSystemPromptChanged: (nextSystemPrompt) => {
      state.systemPromptText = nextSystemPrompt;
    },
    runAbortSignal,
    sessionAgentId,
    transcriptLifecycle: sessionLock.transcriptLifecycle,
    sessionManager,
    assertInitialUserTurnReplay: preparedSessionManager.assertInitialUserTurnReplay,
  });
  const { activeSession, setActiveSessionSystemPrompt, settingsManager } = preparedAgentSession;
  const recordCurrentTurnImageFailure = (count: number) => {
    state.currentTurnImageFailureCount = Math.max(state.currentTurnImageFailureCount, count);
  };
  await attempt.userTurnTranscriptRecorder?.waitForRuntimePersistence();
  const boundary = await sessionLock.withOwnedTranscriptWrite(() =>
    prepareEmbeddedAttemptSessionBoundary({
      abortSignal: runAbortSignal,
      activeSession,
      appendOnlyRuntimeContext: transcriptPolicy.appendOnlyRuntimeContext,
      attempt,
      ...preparedSessionManager.userMessageBoundary,
      isRawModelRun: input.isRawModelRun,
      sessionManager,
      setActiveSessionSystemPrompt,
    }),
  );
  state.prePromptMessageCount = activeSession.messages.length;

  // Session-owned projections survive attempt teardown so already-sent tool results
  // cannot rewrite the provider prompt-cache tail between turns (#99495).
  const sessionPromptState = getEmbeddedSessionPromptState(attempt.sessionId);
  const toolResultPromptProjectionState = sessionPromptState.toolResults;
  if (!input.isRawModelRun) {
    restoreCacheTtlToolResultProjections(
      toolResultPromptProjectionState,
      readCacheTtlEntries(sessionManager),
    );
  }
  const settleTracker = createEmbeddedAttemptSessionSettleTracker(activeSession);
  input.externalAbortController.setActiveSessionAbort(settleTracker.abortActiveSession);
  resources.buildAbortSettlePromise = settleTracker.buildAbortSettlePromise;
  input.onSessionYieldReady({
    abortActiveSession: settleTracker.abortActiveSession,
    activeSession,
  });

  // Guard hooks execute during prompt submission, after transport preparation.
  const contextGuards = installEmbeddedAttemptContextGuards({
    ...(input.activeContextEngine ? { activeContextEngine: input.activeContextEngine } : {}),
    activeSession,
    agentDir: input.agentDir,
    attempt,
    computerContextEpoch,
    dropThinkingBlocksForEstimate: transcriptPolicy.dropThinkingBlocks,
    effectiveCwd,
    effectiveFsWorkspaceOnly,
    effectiveWorkspace,
    getPrePromptMessageCount: () => state.prePromptMessageCount,
    getPromptCache: () => state.promptCache,
    onCurrentTurnImageFailure: recordCurrentTurnImageFailure,
    getPromptCacheRetention: () => transport.effectivePromptCacheRetention,
    getCompactionReplayEnabled: () => transport.compactionReplayEnabled,
    getServerToolClearingEnabled: () => transport.serverToolClearingEnabled,
    toolResultPromptProjectionState,
    getSystemPrompt: () => state.systemPromptText,
    isOpenAIResponsesApi,
    repairToolUseResultPairing: transcriptPolicy.repairToolUseResultPairing,
    sessionAgentId,
    sessionManager,
    settingsManager,
    sandbox,
  });
  resources.removeToolResultContextGuard = contextGuards.remove;

  const cacheTrace = createCacheTrace({
    cfg: attempt.config,
    env: process.env,
    runId: attempt.runId,
    sessionId: activeSession.sessionId,
    sessionKey: attempt.sessionKey,
    provider: attempt.provider,
    modelId: attempt.modelId,
    modelApi: attempt.model.api,
    workspaceDir: attempt.workspaceDir,
  });
  const anthropicPayloadLogger = createAnthropicPayloadLogger({
    env: process.env,
    runId: attempt.runId,
    sessionId: activeSession.sessionId,
    sessionKey: attempt.sessionKey,
    provider: attempt.provider,
    modelId: attempt.modelId,
    modelApi: attempt.model.api,
    workspaceDir: attempt.workspaceDir,
  });
  const trajectoryRecorder = await prepareEmbeddedAttemptTrajectory({
    activeSession,
    attempt,
    clientToolCount: preparedAgentSession.clientToolDefs.length,
    effectiveToolCount,
    effectiveWorkspace,
    localModelLeanEnabled,
    sessionAgentId,
    ...(systemPromptReport ? { systemPromptReport } : {}),
  });
  resources.trajectoryRecorder = trajectoryRecorder;

  const transport = await prepareEmbeddedAttemptTransport({
    attempt,
    session: activeSession,
    settingsManager,
    providerThinkingLevel,
    sessionAgentId,
    workspaceDir: effectiveWorkspace,
    workspaceOnly: effectiveFsWorkspaceOnly,
    agentDir: input.agentDir,
    abortSignal: runAbortSignal,
    getProviderRuntimeHandle,
    onCurrentTurnImageFailure: recordCurrentTurnImageFailure,
    sandboxSessionKey,
    ...(sandbox !== undefined ? { sandbox } : {}),
    codeModeControlsEnabled: codeModeControlsEnabledForRun,
    providerPromptState: {
      state: getProviderPromptState(attempt.runId),
      effectiveContextTokenBudget: Math.max(
        1,
        Math.floor(
          attempt.contextTokenBudget ?? attempt.model.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        ),
      ),
      ...(trajectoryRecorder ? { recordEvent: trajectoryRecorder.recordEvent } : {}),
    },
  });

  return {
    agentSession: preparedAgentSession,
    anthropicPayloadLogger,
    boundary,
    cacheTrace,
    contextGuards,
    isOpenAIResponsesApi,
    preparedUserTurnMessage,
    sessionManager,
    sessionPromptState,
    settleTracker,
    state,
    toolResultPromptProjectionState,
    trajectoryRecorder,
    transcriptPolicy,
    transport,
  };
}
