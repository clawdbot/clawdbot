/** Prepares the session-owned runtime used by one embedded attempt. */
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { createCacheTrace } from "../../cache-trace.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { getEmbeddedSessionPromptState } from "../session-prompt-state.js";
import type { createEmbeddedAttemptExternalAbortController } from "./attempt-abort.js";
import { installEmbeddedAttemptContextGuards } from "./attempt-context-guards.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-boundary.js";
import { prepareEmbeddedAttemptSessionManager } from "./attempt-session-manager-prepare.js";
import { createEmbeddedAttemptSessionSettleTracker } from "./attempt-session-settle.js";
import { prepareEmbeddedAttemptAgentSession } from "./attempt-session.js";
import { prepareEmbeddedAttemptTransport } from "./attempt-stream-transport.js";
import { prepareEmbeddedAttemptTrajectory } from "./attempt-trajectory.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type SessionManagerInput = Parameters<typeof prepareEmbeddedAttemptSessionManager>[0];
type AgentSessionInput = Parameters<typeof prepareEmbeddedAttemptAgentSession>[0];
type ContextGuardsInput = Parameters<typeof installEmbeddedAttemptContextGuards>[0];
type TransportInput = Parameters<typeof prepareEmbeddedAttemptTransport>[0];
type TrajectoryInput = Parameters<typeof prepareEmbeddedAttemptTrajectory>[0];
type AttemptSessionManager = ReturnType<typeof guardSessionManager>;
type SessionSettleTracker = ReturnType<typeof createEmbeddedAttemptSessionSettleTracker>;
type TrajectoryRecorder = Awaited<ReturnType<typeof prepareEmbeddedAttemptTrajectory>>;
type ExternalAbortController = Pick<
  ReturnType<typeof createEmbeddedAttemptExternalAbortController>,
  "setActiveSessionAbort"
>;

type EmbeddedAttemptSessionRuntimeState = {
  prePromptMessageCount: number;
  promptCache: EmbeddedRunAttemptResult["promptCache"];
  systemPromptText: string;
};

export async function prepareEmbeddedAttemptSessionRuntime(input: {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: SessionManagerInput["activeContextEngine"];
  agentDir: string;
  effectiveCwd: string;
  effectiveWorkspace: string;
  initialSystemPrompt: string;
  isRawModelRun: boolean;
  sessionManager: Pick<
    SessionManagerInput,
    | "replayAllowedToolNames"
    | "resolveActiveContextEnginePluginId"
    | "sessionAgentId"
    | "sessionLockController"
    | "withOwnedSessionWriteLock"
  >;
  agentSession: Pick<
    AgentSessionInput,
    | "agentCoreThinkingLevel"
    | "clientToolPreparation"
    | "getCurrentAttemptPluginMetadataSnapshot"
    | "markStage"
    | "runAbortSignal"
  >;
  contextGuards: Pick<ContextGuardsInput, "computerContextEpoch">;
  trajectory: Pick<
    TrajectoryInput,
    "effectiveToolCount" | "localModelLeanEnabled" | "systemPromptReport"
  >;
  transport: Pick<
    TransportInput,
    | "abortSignal"
    | "codeModeControlsEnabled"
    | "getProviderRuntimeHandle"
    | "providerThinkingLevel"
    | "sandbox"
    | "sandboxSessionKey"
  >;
  externalAbortController: ExternalAbortController;
  lifecycle: {
    onContextGuardsInstalled: (remove: () => void) => void;
    onSessionCreated: (session: AgentSession) => void;
    onSessionManagerCreated: (sessionManager: AttemptSessionManager) => void;
    onSessionSettleTrackerReady: (
      buildAbortSettlePromise: SessionSettleTracker["buildAbortSettlePromise"],
    ) => void;
    onSessionYieldReady: (input: {
      abortActiveSession: SessionSettleTracker["abortActiveSession"];
      activeSession: AgentSession;
    }) => void;
    onTrajectoryRecorderCreated: (recorder: TrajectoryRecorder) => void;
  };
}) {
  const { attempt } = input;
  const preparedSessionManager = await prepareEmbeddedAttemptSessionManager({
    attempt,
    ...(input.activeContextEngine ? { activeContextEngine: input.activeContextEngine } : {}),
    agentDir: input.agentDir,
    effectiveCwd: input.effectiveCwd,
    effectiveWorkspace: input.effectiveWorkspace,
    onSessionManagerCreated: input.lifecycle.onSessionManagerCreated,
    replayAllowedToolNames: input.sessionManager.replayAllowedToolNames,
    resolveActiveContextEnginePluginId: input.sessionManager.resolveActiveContextEnginePluginId,
    sessionAgentId: input.sessionManager.sessionAgentId,
    sessionLockController: input.sessionManager.sessionLockController,
    withOwnedSessionWriteLock: input.sessionManager.withOwnedSessionWriteLock,
  });
  const { isOpenAIResponsesApi, preparedUserTurnMessage, sessionManager, transcriptPolicy } =
    preparedSessionManager;

  const state: EmbeddedAttemptSessionRuntimeState = {
    prePromptMessageCount: 0,
    promptCache: undefined,
    systemPromptText: input.initialSystemPrompt,
  };
  const preparedAgentSession = await prepareEmbeddedAttemptAgentSession({
    attempt,
    ...(input.activeContextEngine
      ? { activeContextEngineInfo: input.activeContextEngine.info }
      : {}),
    agentCoreThinkingLevel: input.agentSession.agentCoreThinkingLevel,
    agentDir: input.agentDir,
    clientToolPreparation: input.agentSession.clientToolPreparation,
    effectiveCwd: input.effectiveCwd,
    getCurrentAttemptPluginMetadataSnapshot:
      input.agentSession.getCurrentAttemptPluginMetadataSnapshot,
    initialSystemPrompt: state.systemPromptText,
    markStage: input.agentSession.markStage,
    onSessionCreated: input.lifecycle.onSessionCreated,
    onSystemPromptChanged: (systemPromptText) => {
      state.systemPromptText = systemPromptText;
    },
    runAbortSignal: input.agentSession.runAbortSignal,
    sessionAgentId: input.sessionManager.sessionAgentId,
    sessionLockController: input.sessionManager.sessionLockController,
    sessionManager,
  });
  const { activeSession, setActiveSessionSystemPrompt, settingsManager } = preparedAgentSession;
  const boundary = prepareEmbeddedAttemptSessionBoundary({
    activeSession,
    attempt,
    ...preparedSessionManager.userMessageBoundary,
    isRawModelRun: input.isRawModelRun,
    sessionManager,
    setActiveSessionSystemPrompt,
  });
  state.prePromptMessageCount = activeSession.messages.length;

  // Session-owned projections survive attempt teardown so already-sent tool results
  // cannot rewrite the provider prompt-cache tail between turns (#99495).
  const sessionPromptState = getEmbeddedSessionPromptState(attempt.sessionId);
  const toolResultPromptProjectionState = sessionPromptState.toolResults;
  const settleTracker = createEmbeddedAttemptSessionSettleTracker(activeSession);
  input.externalAbortController.setActiveSessionAbort(settleTracker.abortActiveSession);
  input.lifecycle.onSessionSettleTrackerReady(settleTracker.buildAbortSettlePromise);
  input.lifecycle.onSessionYieldReady({
    abortActiveSession: settleTracker.abortActiveSession,
    activeSession,
  });

  // Guard hooks run during prompt submission, after transport setup fills this value.
  const promptCacheRetentionRef: {
    current: Awaited<
      ReturnType<typeof prepareEmbeddedAttemptTransport>
    >["effectivePromptCacheRetention"];
  } = { current: undefined };
  const contextGuards = installEmbeddedAttemptContextGuards({
    ...(input.activeContextEngine ? { activeContextEngine: input.activeContextEngine } : {}),
    activeSession,
    agentDir: input.agentDir,
    attempt,
    computerContextEpoch: input.contextGuards.computerContextEpoch,
    effectiveCwd: input.effectiveCwd,
    effectiveWorkspace: input.effectiveWorkspace,
    getPrePromptMessageCount: () => state.prePromptMessageCount,
    getPromptCache: () => state.promptCache,
    getPromptCacheRetention: () => promptCacheRetentionRef.current,
    getSystemPrompt: () => state.systemPromptText,
    isOpenAIResponsesApi,
    repairToolUseResultPairing: transcriptPolicy.repairToolUseResultPairing,
    sessionAgentId: input.sessionManager.sessionAgentId,
    sessionManager,
    settingsManager,
  });
  input.lifecycle.onContextGuardsInstalled(contextGuards.remove);

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
    effectiveToolCount: input.trajectory.effectiveToolCount,
    effectiveWorkspace: input.effectiveWorkspace,
    localModelLeanEnabled: input.trajectory.localModelLeanEnabled,
    sessionAgentId: input.sessionManager.sessionAgentId,
    ...(input.trajectory.systemPromptReport
      ? { systemPromptReport: input.trajectory.systemPromptReport }
      : {}),
  });
  input.lifecycle.onTrajectoryRecorderCreated(trajectoryRecorder);

  const transport = await prepareEmbeddedAttemptTransport({
    attempt,
    session: activeSession,
    settingsManager,
    providerThinkingLevel: input.transport.providerThinkingLevel,
    sessionAgentId: input.sessionManager.sessionAgentId,
    workspaceDir: input.effectiveWorkspace,
    agentDir: input.agentDir,
    abortSignal: input.transport.abortSignal,
    getProviderRuntimeHandle: input.transport.getProviderRuntimeHandle,
    sandboxSessionKey: input.transport.sandboxSessionKey,
    ...(input.transport.sandbox !== undefined ? { sandbox: input.transport.sandbox } : {}),
    codeModeControlsEnabled: input.transport.codeModeControlsEnabled,
  });
  promptCacheRetentionRef.current = transport.effectivePromptCacheRetention;

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
