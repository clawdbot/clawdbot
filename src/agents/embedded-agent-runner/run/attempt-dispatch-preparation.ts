import fs from "node:fs/promises";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { resolveSessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import type { resolveContextEngine } from "../../../context-engine/registry.js";
import { attachModelProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import { agentHarnessBuildsOpenClawTools } from "../../harness/selection.js";
import { recordAdmittedModelRoutingDecision } from "../../model-routing-decision.js";
import { buildAgentRuntimePlan } from "../../runtime-plan/build.js";
import { createEmbeddedRunReplayState } from "../replay-state.js";
import { mapThinkingLevelForProvider } from "../utils.js";
import { EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE } from "./attempt-stage-timing.js";
import { resolveAttemptDispatchApiKey } from "./auth-store.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import { resolveEmbeddedAttemptBasePrompt } from "./helpers.js";
import { dispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import { CODEX_HARNESS_ID, resolveAttemptTrajectoryAttribution } from "./runtime-resolution.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import type { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";
import { MAX_BEFORE_AGENT_FINALIZE_REVISIONS } from "./terminal-retry-state.js";

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;
type ContextEngine = Awaited<ReturnType<typeof resolveContextEngine>>;
type SessionPromptState = ReturnType<typeof createEmbeddedRunSessionPromptState>;
type TerminalRetryState = ReturnType<typeof createEmbeddedRunTerminalRetryState>;

export async function prepareAndDispatchEmbeddedRunAttempt(input: {
  runInput: PreparedEmbeddedRunInput;
  preparedRuntime: PreparedRuntime;
  contextEngine: ContextEngine;
  sessionPromptState: SessionPromptState;
  terminalRetryState: TerminalRetryState;
  replayState: ReturnType<typeof createEmbeddedRunReplayState>;
  provider: string;
  modelId: string;
  startupStagesEmitted: boolean;
  bootstrapPromptWarningSignaturesSeen: string[];
  resolveRuntimeFallbackReason: () => string | null;
  observeToolOutcome: Parameters<typeof dispatchEmbeddedRunAttempt>[0]["control"]["onToolOutcome"];
  isTurnTainted: () => boolean;
  allocateToolOutcomeOrdinal: Parameters<
    typeof dispatchEmbeddedRunAttempt
  >[0]["control"]["allocateToolOutcomeOrdinal"];
  getPostCompactionAbortError: () => Error | undefined;
  setPostCompactionAbortController: (controller: AbortController | undefined) => void;
  clearPostCompactionAbortController: (controller: AbortController) => void;
}) {
  const {
    runInput,
    preparedRuntime,
    contextEngine,
    sessionPromptState,
    terminalRetryState,
    provider,
    modelId,
  } = input;
  const params = input.terminalRetryState.forceCodeModeReconciliationTools
    ? { ...runInput.runParams, forceCodeModeReconciliationTools: true }
    : runInput.runParams;
  const {
    workspaceResolution,
    workspaceDir,
    bootstrapWorkspaceDir,
    isCanonicalWorkspace,
    agentDir,
    resolvedSessionKey,
    resolvedToolResultFormat,
    startupStages,
    emitStartupStageSummary,
    lifecycleGeneration,
  } = runInput;
  const {
    fastModeAutoOnSeconds,
    fastModeAutoProgressState,
    fastModeStartedAtMs,
    maybeAnnounceFastModeAutoOff,
    notifyAgentEvent,
    notifyExecutionPhase,
    notifyRunProgress,
    notifyToolResult,
    resolveAttemptFastModeParam,
  } = runInput.progressController;
  const { laneTaskAbortController, laneTaskReleaseController, noteLaneTaskProgress } =
    runInput.laneController;
  const {
    requestedModelId,
    expectedHarnessArtifact,
    nativeModelOwned,
    authStorage,
    modelRegistry,
    attemptAuthProfileStore,
    lockedProfileId,
    resolveRunAttemptAuthProfileStore,
  } = preparedRuntime;
  const runtime = preparedRuntime.snapshot();
  const effectiveModel = attachModelProviderRuntimePluginHandle(
    runtime.effectiveModel,
    runtime.providerRuntimeHandle,
  );

  await fs.mkdir(workspaceDir, { recursive: true });
  if (!input.startupStagesEmitted) {
    startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.workspace);
  }
  const basePrompt =
    sessionPromptState.activePrompt.override ??
    resolveEmbeddedAttemptBasePrompt({ provider, prompt: params.prompt });
  const prompt = terminalRetryState.compactionContinuationInstruction
    ? `${basePrompt}\n\n${terminalRetryState.compactionContinuationInstruction}`
    : basePrompt;
  const resolvedAttemptApiKey = resolveAttemptDispatchApiKey({
    apiKeyInfo: runtime.apiKeyInfo,
    runtimeAuthState: runtime.runtimeAuthState,
    pluginHarnessOwnsTransport: runtime.pluginHarnessOwnsTransport,
  });
  const attemptFastMode = resolveAttemptFastModeParam();
  const existingSessionTarget = sessionPromptState.sessionTarget;
  const reusableSessionTarget =
    existingSessionTarget?.sessionKey === resolvedSessionKey ||
    sessionPromptState.sessionTargetAdopted
      ? existingSessionTarget
      : undefined;
  const resolvedTranscriptTarget =
    reusableSessionTarget ??
    (resolvedSessionKey
      ? await resolveSessionTranscriptRuntimeTarget({
          agentId: workspaceResolution.agentId,
          sessionId: sessionPromptState.sessionId,
          sessionKey: resolvedSessionKey,
          storePath: resolveSessionStorePathCore(params.config?.session?.store, {
            agentId: workspaceResolution.agentId,
          }),
        })
      : undefined);
  const resolvedSessionTarget =
    resolvedTranscriptTarget || sessionPromptState.sessionTarget
      ? {
          ...sessionPromptState.sessionTarget,
          ...resolvedTranscriptTarget,
          ...sessionPromptState.sessionWriterFence,
        }
      : undefined;
  const trajectorySessionFile = resolvedSessionTarget?.sessionKey ?? sessionPromptState.sessionFile;
  if (!input.startupStagesEmitted) {
    startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.prompt);
  }
  const runtimePlan = buildAgentRuntimePlan({
    provider,
    modelId,
    model: effectiveModel,
    modelApi: effectiveModel.api,
    harnessId: runtime.agentHarness.id,
    harnessRuntime: runtime.agentHarness.id,
    preparedAuthPlan: runtime.activePreparedAuthPlan,
    metadataSnapshot: runtime.pluginMetadataSnapshot,
    providerRuntimeHandle: runtime.providerRuntimeHandle,
    config: params.config,
    workspaceDir,
    agentDir,
    agentId: workspaceResolution.agentId,
    thinkingLevel: mapThinkingLevelForProvider(runtime.thinkLevel),
    extraParamsOverride: { ...params.streamParams, fastMode: attemptFastMode },
  });
  const trajectoryAttribution = resolveAttemptTrajectoryAttribution({
    model: effectiveModel,
    modelId,
    provider,
    runtimePlan,
  });
  const trajectoryRecorder =
    runtime.agentHarness.id === CODEX_HARNESS_ID && !params.disableTrajectory
      ? createTrajectoryRuntimeRecorder({
          cfg: params.config,
          env: process.env,
          runId: params.runId,
          sessionId: sessionPromptState.sessionId,
          sessionKey: resolvedSessionKey,
          sessionFile: trajectorySessionFile,
          ...(resolvedSessionTarget?.agentId &&
          resolvedSessionTarget.sessionId &&
          resolvedSessionTarget.sessionKey &&
          resolvedSessionTarget.storePath
            ? {
                sessionTarget: {
                  agentId: resolvedSessionTarget.agentId,
                  sessionId: resolvedSessionTarget.sessionId,
                  sessionKey: resolvedSessionTarget.sessionKey,
                  storePath: resolvedSessionTarget.storePath,
                },
              }
            : {}),
          provider: trajectoryAttribution.provider,
          modelId: trajectoryAttribution.modelId,
          modelApi: trajectoryAttribution.modelApi,
          workspaceDir,
        })
      : undefined;
  let startupStagesEmitted = input.startupStagesEmitted;
  if (!startupStagesEmitted) {
    startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.runtimePlan);
    startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);
    notifyExecutionPhase("attempt_dispatch", { provider, model: modelId });
    emitStartupStageSummary(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);
    startupStagesEmitted = true;
  }
  const fallbackReason = input.resolveRuntimeFallbackReason();
  recordAdmittedModelRoutingDecision({
    admittedRunContext: params.admittedRunContext,
    abortSignal: params.abortSignal,
    requestedProvider: params.modelRoutingProvenance?.requestedProvider ?? runInput.provider,
    requestedModel:
      params.modelRoutingProvenance?.requestedModel ?? requestedModelId ?? runInput.modelId,
    selectedProvider: provider,
    selectedModel: modelId,
    selectionMode:
      runtime.lastProfileId && runtime.lastProfileId === lockedProfileId ? "explicit" : "automatic",
    credentialProfileId: runtime.lastProfileId,
    fallbackSelected:
      params.modelRoutingProvenance?.stage === "fallback" || Boolean(fallbackReason),
    fallbackReason: params.modelRoutingProvenance?.fallbackReason,
  });
  const dispatchedAttempt = await dispatchEmbeddedRunAttempt({
    params,
    transcriptOwnership: params.sessionManager
      ? { kind: "caller-owned", sessionManager: params.sessionManager }
      : { kind: "runtime-target", sessionTarget: resolvedSessionTarget },
    runtime: {
      contextEngineAgentId: runInput.contextEngineAgentId,
      sessionId: sessionPromptState.sessionId,
      sessionFile: sessionPromptState.sessionFile,
      sessionKey: resolvedSessionKey,
      trajectoryRecorder: trajectoryRecorder ?? undefined,
      workspaceDir,
      bootstrapWorkspaceDir,
      isCanonicalWorkspace,
      agentDir,
      preparedModelRuntime: runInput.preparedModelRuntime,
      contextEngine: nativeModelOwned ? undefined : contextEngine,
      contextTokenBudget: runtime.contextTokenBudget,
      authoredContextTokenCap: runtime.authoredContextTokenCap,
      contextWindowInfo: runtime.contextWindowInfo,
      prompt,
      provider,
      modelId,
      requestedModelId,
      fallbackActive: modelId !== requestedModelId || Boolean(fallbackReason),
      fallbackReason,
      agentHarnessId: runtime.agentHarness.id,
      expectedRuntimeArtifact: expectedHarnessArtifact?.artifact,
      runtimePlan,
      model: effectiveModel,
      resolvedApiKey: resolvedAttemptApiKey,
      authProfileId: runtime.lastProfileId,
      authProfileIdSource:
        runtime.lastProfileId && runtime.lastProfileId === lockedProfileId ? "user" : "auto",
      initialReplayState: input.replayState,
      authStorage,
      authProfileStore: resolveRunAttemptAuthProfileStore(),
      toolAuthProfileStore: agentHarnessBuildsOpenClawTools(runtime.agentHarness.id)
        ? attemptAuthProfileStore
        : undefined,
      modelRegistry,
      agentId: workspaceResolution.agentId,
      thinkLevel: runtime.thinkLevel,
      fastMode: attemptFastMode,
      fastModeStartedAtMs,
      fastModeAutoOnSeconds,
      fastModeAutoProgressState,
      toolResultFormat: resolvedToolResultFormat,
      skipPreparedUserTurnMessage: sessionPromptState.activePrompt.internal,
      apiKeyInfo: runtime.apiKeyInfo,
      runtimeAuthActive: runtime.runtimeAuthState !== null,
      captureRuntimeArtifact: Boolean(params.onSuccessfulAuthBinding || expectedHarnessArtifact),
    },
    control: {
      lifecycleGeneration,
      pluginHarnessOwnsTransport: runtime.pluginHarnessOwnsTransport,
      laneTaskAbortController,
      laneTaskReleaseController,
      noteLaneTaskProgress,
      onToolOutcome: input.observeToolOutcome,
      isTurnTainted: input.isTurnTainted,
      allocateToolOutcomeOrdinal: input.allocateToolOutcomeOrdinal,
      onToolStreamBoundary: maybeAnnounceFastModeAutoOff,
      onRunProgress: notifyRunProgress,
      onToolResult: notifyToolResult,
      onAgentEvent: notifyAgentEvent,
      onUserMessagePersisted: sessionPromptState.onUserMessagePersisted,
      onUserMessagePersistenceInvalidated: () => {
        sessionPromptState.activePrompt.persisted = false;
      },
      getPostCompactionAbortError: input.getPostCompactionAbortError,
      setPostCompactionAbortController: input.setPostCompactionAbortController,
      clearPostCompactionAbortController: input.clearPostCompactionAbortController,
    },
    bootstrapPromptWarningSignaturesSeen: input.bootstrapPromptWarningSignaturesSeen,
    suppressNextUserMessagePersistence: sessionPromptState.suppressNextUserMessagePersistence,
    beforeAgentFinalizeRevisionAttempts: terminalRetryState.beforeFinalizeRevisionAttempts,
    maxBeforeAgentFinalizeRevisions: MAX_BEFORE_AGENT_FINALIZE_REVISIONS,
  });
  return { dispatchedAttempt, runtimePlan, startupStagesEmitted };
}
