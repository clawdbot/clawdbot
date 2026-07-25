import type { ContextEngineSessionTarget } from "../../../context-engine/types.js";
import { createAgentHarnessTaskRuntimeScope } from "../../../tasks/agent-harness-task-runtime-scope.js";
import type { ToolOutcomeObserver } from "../../agent-tools.before-tool-call.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { resolveDelegationCapability } from "../../delegation-capability.js";
import type { AgentHarnessRuntimeArtifactBinding } from "../../harness/runtime-artifact.types.js";
import { appendIncognitoSystemPrompt } from "../../incognito-system-prompt.js";
import { applyAuthHeaderOverride, applyLocalNoAuthHeaderOverride } from "../../model-auth.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import { createToolTerminalObserver } from "../../tool-terminal-outcome.js";
import type { SystemAgentToolOptions } from "../../tools/system-agent-tool.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";
import {
  EMBEDDED_RUN_LANE_HEARTBEAT_MS,
  EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
} from "./lane-runtime.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { preparePluginHarnessPromptImages } from "./plugin-harness-prompt-images.js";
import { resolveSkillWorkshopAttemptParams } from "./skill-workshop-attempt-params.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptTrajectoryRecorder } from "./types.js";

type InternalRunParams = RunEmbeddedAgentParams & {
  sessionFile: string;
  systemAgentTool?: SystemAgentToolOptions;
};

type AttemptRuntime = {
  sessionId: string;
  sessionFile: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionKey?: string;
  trajectorySessionFile: string;
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder;
  workspaceDir: string;
  isCanonicalWorkspace: boolean;
  agentDir: string;
  preparedModelRuntime?: EmbeddedRunAttemptParams["preparedModelRuntime"];
  contextEngine?: EmbeddedRunAttemptParams["contextEngine"];
  contextTokenBudget?: number;
  contextWindowInfo?: EmbeddedRunAttemptParams["contextWindowInfo"];
  prompt: string;
  provider: string;
  modelId: string;
  requestedModelId: string;
  fallbackActive: boolean;
  fallbackReason: string | null;
  agentHarnessId: string;
  expectedRuntimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  runtimePlan: AgentRuntimePlan;
  model: EmbeddedRunAttemptParams["model"];
  resolvedApiKey?: string;
  authProfileId?: string;
  authProfileIdSource: "auto" | "user";
  initialReplayState: NonNullable<EmbeddedRunAttemptParams["initialReplayState"]>;
  authStorage: EmbeddedRunAttemptParams["authStorage"];
  authProfileStore: AuthProfileStore;
  toolAuthProfileStore?: AuthProfileStore;
  modelRegistry: EmbeddedRunAttemptParams["modelRegistry"];
  agentId: string;
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"];
  fastMode: EmbeddedRunAttemptParams["fastMode"];
  fastModeStartedAtMs?: number;
  fastModeAutoOnSeconds?: number;
  fastModeAutoProgressState?: EmbeddedRunAttemptParams["fastModeAutoProgressState"];
  toolResultFormat: EmbeddedRunAttemptParams["toolResultFormat"];
  skipPreparedUserTurnMessage: boolean;
  apiKeyInfo: Parameters<typeof applyLocalNoAuthHeaderOverride>[1];
  runtimeAuthActive: boolean;
  captureRuntimeArtifact: boolean;
};

type AttemptControl = {
  lifecycleGeneration: string;
  pluginHarnessOwnsTransport: boolean;
  laneTaskAbortController: AbortController;
  laneTaskReleaseController: AbortController;
  noteLaneTaskProgress: () => void;
  onToolOutcome: ToolOutcomeObserver;
  allocateToolOutcomeOrdinal: (toolCallId?: string) => number;
  onToolStreamBoundary: NonNullable<EmbeddedRunAttemptParams["onToolStreamBoundary"]>;
  onRunProgress: NonNullable<EmbeddedRunAttemptParams["onRunProgress"]>;
  onToolResult: NonNullable<EmbeddedRunAttemptParams["onToolResult"]>;
  onAgentEvent: NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>;
  onUserMessagePersisted: NonNullable<EmbeddedRunAttemptParams["onUserMessagePersisted"]>;
  onUserMessagePersistenceInvalidated: NonNullable<
    EmbeddedRunAttemptParams["onUserMessagePersistenceInvalidated"]
  >;
  getPostCompactionAbortError: () => Error | undefined;
  setPostCompactionAbortController: (controller: AbortController | undefined) => void;
  clearPostCompactionAbortController: (controller: AbortController) => void;
};

export async function dispatchEmbeddedRunAttempt(input: {
  params: InternalRunParams;
  runtime: AttemptRuntime;
  control: AttemptControl;
  bootstrapPromptWarningSignaturesSeen: string[];
  suppressNextUserMessagePersistence: boolean;
  beforeAgentFinalizeRevisionAttempts: number;
  maxBeforeAgentFinalizeRevisions: number;
}): Promise<{
  rawAttempt: Awaited<ReturnType<typeof runEmbeddedAttemptWithBackend>>;
  cancellationRequested: boolean;
  preparedAttempt: EmbeddedRunAttemptParams;
}> {
  const { params, runtime, control } = input;
  const observeToolTerminal = createToolTerminalObserver(params.runId);
  const attemptAbortController = new AbortController();
  control.setPostCompactionAbortController(attemptAbortController);
  const parentAbortSignal = params.abortSignal;
  const relayParentAbort = (): void => {
    control.laneTaskAbortController.abort(parentAbortSignal?.reason);
    attemptAbortController.abort(parentAbortSignal?.reason);
  };
  if (parentAbortSignal?.aborted) {
    relayParentAbort();
  } else {
    parentAbortSignal?.addEventListener("abort", relayParentAbort, { once: true });
  }

  // Native attempts start the heartbeat only after their own timeout watchdog
  // is armed, keeping preflight inside the requested deadline.
  let progressInterval: ReturnType<typeof setInterval> | undefined;
  const stopLaneProgressHeartbeat = () => {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = undefined;
    }
    attemptAbortController.signal.removeEventListener("abort", stopLaneProgressHeartbeat);
  };
  const startLaneProgressHeartbeat = () => {
    if (progressInterval || attemptAbortController.signal.aborted) {
      return;
    }
    progressInterval = setInterval(
      () => control.noteLaneTaskProgress(),
      EMBEDDED_RUN_LANE_HEARTBEAT_MS,
    );
    progressInterval.unref?.();
    attemptAbortController.signal.addEventListener("abort", stopLaneProgressHeartbeat, {
      once: true,
    });
  };

  // Timeout recovery can continue after an attempt returns, but a native
  // transport that ignores its timeout releases the lane after one grace.
  let timeoutReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  const clearAttemptTimeoutRelease = () => {
    if (timeoutReleaseTimer) {
      clearTimeout(timeoutReleaseTimer);
      timeoutReleaseTimer = undefined;
    }
  };
  const armAttemptTimeoutRelease = (reason: Error) => {
    if (timeoutReleaseTimer) {
      return;
    }
    timeoutReleaseTimer = setTimeout(
      () => control.laneTaskReleaseController.abort(reason),
      EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
    );
    timeoutReleaseTimer.unref?.();
  };

  let cancellationRequested = false;
  const promptMedia = await preparePluginHarnessPromptImages({
    runParams: params,
    runtime,
    pluginHarnessOwnsTransport: control.pluginHarnessOwnsTransport,
  });
  const attemptParams: EmbeddedRunAttemptParams = {
    operation: "attempt",
    sessionId: runtime.sessionId,
    sessionKey: runtime.sessionKey,
    conversationRecall: params.conversationRecall,
    promptCacheKey: params.promptCacheKey,
    sandboxSessionKey: params.sandboxSessionKey,
    trigger: params.trigger,
    memoryFlushWritePath: params.memoryFlushWritePath,
    messageChannel: params.messageChannel,
    messageProvider: params.messageProvider,
    clientCaps: params.clientCaps,
    chatType: params.chatType,
    agentAccountId: params.agentAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    messageActionTurnCapability: params.messageActionTurnCapability,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    memberRoleIds: params.memberRoleIds,
    spawnedBy: params.spawnedBy,
    isCanonicalWorkspace: runtime.isCanonicalWorkspace,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    approvalReviewerDeviceId: params.approvalReviewerDeviceId,
    currentChannelId: params.currentChannelId,
    chatId: params.chatId,
    channelContext: params.channelContext,
    currentMessagingTarget: params.currentMessagingTarget,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    currentInboundAudio: params.currentInboundAudio,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    sessionFile: runtime.sessionFile,
    sessionTarget: runtime.sessionTarget,
    trajectorySessionFile: runtime.trajectorySessionFile,
    trajectoryRecorder: runtime.trajectoryRecorder,
    workspaceDir: runtime.workspaceDir,
    cwd: params.cwd,
    agentDir: runtime.agentDir,
    preparedModelRuntime: runtime.preparedModelRuntime,
    config: params.config,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    ...(runtime.contextEngine
      ? {
          contextEngine: runtime.contextEngine,
          contextTokenBudget: runtime.contextTokenBudget,
          contextWindowInfo: runtime.contextWindowInfo,
        }
      : {}),
    skillsSnapshot: params.skillsSnapshot,
    prompt: runtime.prompt,
    transcriptPrompt: params.transcriptPrompt,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    skipPreparedUserTurnMessage: runtime.skipPreparedUserTurnMessage,
    currentInboundEventKind: params.currentInboundEventKind,
    currentInboundContext: params.currentInboundContext,
    images: promptMedia.images,
    imageOrder: promptMedia.imageOrder,
    media: promptMedia.media,
    clientTools: params.clientTools,
    disableTools: params.disableTools,
    provider: runtime.provider,
    modelId: runtime.modelId,
    requestedModelId: runtime.requestedModelId,
    fallbackActive: runtime.fallbackActive,
    fallbackReason: runtime.fallbackReason,
    delegationCapability: resolveDelegationCapability({
      fallbackActive: runtime.fallbackActive,
      inputProvenance: params.inputProvenance,
    }),
    isFinalFallbackAttempt: params.isFinalFallbackAttempt,
    agentHarnessId: runtime.agentHarnessId,
    agentHarnessRuntimeOverride: runtime.agentHarnessId,
    modelSelectionLocked: params.modelSelectionLocked,
    ...(runtime.captureRuntimeArtifact ? { captureRuntimeArtifact: true } : {}),
    ...(runtime.expectedRuntimeArtifact
      ? { expectedRuntimeArtifact: runtime.expectedRuntimeArtifact }
      : {}),
    ...(params.sessionKey
      ? {
          agentHarnessTaskRuntimeScope: createAgentHarnessTaskRuntimeScope({
            requesterSessionKey: params.sessionKey,
          }),
        }
      : {}),
    runtimePlan: runtime.runtimePlan,
    observeToolTerminal,
    model: applyAuthHeaderOverride(
      applyLocalNoAuthHeaderOverride(runtime.model, runtime.apiKeyInfo),
      runtime.runtimeAuthActive ? null : runtime.apiKeyInfo,
      params.config,
    ),
    resolvedApiKey: runtime.resolvedApiKey,
    authProfileId: runtime.authProfileId,
    authProfileIdSource: runtime.authProfileIdSource,
    initialReplayState: runtime.initialReplayState,
    authStorage: runtime.authStorage,
    authProfileStore: runtime.authProfileStore,
    toolAuthProfileStore: runtime.toolAuthProfileStore,
    modelRegistry: runtime.modelRegistry,
    agentId: runtime.agentId,
    thinkLevel: runtime.thinkLevel,
    onToolOutcome: control.onToolOutcome,
    allocateToolOutcomeOrdinal: control.allocateToolOutcomeOrdinal,
    onToolStreamBoundary: control.onToolStreamBoundary,
    onRunProgress: control.onRunProgress,
    fastMode: runtime.fastMode,
    fastModeAuto: params.fastMode === "auto",
    ...(params.fastMode === "auto"
      ? {
          fastModeStartedAtMs: runtime.fastModeStartedAtMs,
          fastModeAutoOnSeconds: runtime.fastModeAutoOnSeconds,
          fastModeAutoProgressState: runtime.fastModeAutoProgressState,
        }
      : {}),
    verboseLevel: params.verboseLevel,
    reasoningLevel: params.reasoningLevel,
    toolResultFormat: runtime.toolResultFormat,
    toolProgressDetail: params.toolProgressDetail,
    execOverrides: params.execOverrides,
    bashElevated: params.bashElevated,
    timeoutMs: params.timeoutMs,
    runTimeoutOverrideMs: params.runTimeoutOverrideMs,
    runId: params.runId,
    lifecycleGeneration: control.lifecycleGeneration,
    abortSignal: attemptAbortController.signal,
    onAttemptTimeoutArmed: control.pluginHarnessOwnsTransport
      ? undefined
      : startLaneProgressHeartbeat,
    onAttemptTimeout: control.pluginHarnessOwnsTransport ? undefined : armAttemptTimeoutRelease,
    onAttemptAbort: () => {
      cancellationRequested = true;
      if (!params.abortSignal?.aborted) {
        params.replyOperation?.abortByUser();
      }
      if (!control.pluginHarnessOwnsTransport) {
        stopLaneProgressHeartbeat();
        control.laneTaskAbortController.abort();
      }
    },
    replyOperation: params.replyOperation,
    shouldEmitToolResult: params.shouldEmitToolResult,
    shouldEmitToolOutput: params.shouldEmitToolOutput,
    onPartialReply: params.onPartialReply,
    onAssistantMessageStart: params.onAssistantMessageStart,
    onBlockReply: params.onBlockReply,
    onBlockReplyFlush: params.onBlockReplyFlush,
    blockReplyBreak: params.blockReplyBreak,
    blockReplyChunking: params.blockReplyChunking,
    onReasoningStream: params.onReasoningStream,
    streamReasoningInNonStreamModes: params.streamReasoningInNonStreamModes,
    onReasoningEnd: params.onReasoningEnd,
    onToolResult: control.onToolResult,
    onAgentToolResult: params.onAgentToolResult,
    onAgentEvent: control.onAgentEvent,
    // Normalize the shipped harness alias once; attempt internals consume only the canonical flag.
    deferTerminalLifecycle: params.deferTerminalLifecycle ?? params.deferTerminalLifecycleEnd,
    onExecutionPhase: params.onExecutionPhase,
    extraSystemPrompt: appendIncognitoSystemPrompt({
      agentId: runtime.agentId,
      extraSystemPrompt: params.extraSystemPrompt,
      sessionKey: params.sessionKey,
      storePath: params.sessionTarget?.storePath,
    }),
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    inputProvenance: params.inputProvenance,
    trustedInternalHandoff: params.trustedInternalHandoff,
    scheduledToolPolicy: params.scheduledToolPolicy,
    streamParams: params.streamParams,
    modelRun: params.modelRun,
    disableTrajectory: params.disableTrajectory,
    ...resolveSkillWorkshopAttemptParams(params),
    promptMode: params.promptMode,
    ownerNumbers: params.ownerNumbers,
    enforceFinalTag: params.enforceFinalTag,
    silentExpected: params.silentExpected,
    suppressLiveStreamOutput: params.suppressLiveStreamOutput,
    bootstrapContextMode: params.bootstrapContextMode,
    bootstrapContextRunKind: params.bootstrapContextRunKind,
    jobId: params.jobId,
    toolsAllow: params.toolsAllow,
    ...(params.systemAgentTool ? { systemAgentTool: params.systemAgentTool } : {}),
    cleanupBundleMcpOnRunEnd: params.cleanupBundleMcpOnRunEnd,
    disableMessageTool: params.disableMessageTool,
    swarmCollector: params.swarmCollector,
    swarmOutputSchema: params.swarmOutputSchema,
    forceRestartSafeTools: params.forceRestartSafeTools,
    forceMessageTool: params.forceMessageTool,
    enableHeartbeatTool: params.enableHeartbeatTool,
    forceHeartbeatTool: params.forceHeartbeatTool,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    internalEvents: params.internalEvents,
    bootstrapPromptWarningSignaturesSeen: input.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature:
      input.bootstrapPromptWarningSignaturesSeen[
        input.bootstrapPromptWarningSignaturesSeen.length - 1
      ],
    suppressNextUserMessagePersistence: input.suppressNextUserMessagePersistence,
    beforeAgentFinalizeRevisionAttempts: input.beforeAgentFinalizeRevisionAttempts,
    maxBeforeAgentFinalizeRevisions: input.maxBeforeAgentFinalizeRevisions,
    suppressTranscriptOnlyAssistantPersistence: params.suppressTranscriptOnlyAssistantPersistence,
    suppressAssistantErrorPersistence: params.suppressAssistantErrorPersistence,
    onUserMessagePersisted: control.onUserMessagePersisted,
    onUserMessagePersistenceInvalidated: control.onUserMessagePersistenceInvalidated,
    onAssistantErrorMessagePersisted: params.onAssistantErrorMessagePersisted,
  };
  const rawAttempt = await runEmbeddedAttemptWithBackend(attemptParams)
    .catch((err: unknown): never => {
      throw control.getPostCompactionAbortError() ?? err;
    })
    .finally(() => {
      clearAttemptTimeoutRelease();
      stopLaneProgressHeartbeat();
      parentAbortSignal?.removeEventListener?.("abort", relayParentAbort);
      control.clearPostCompactionAbortController(attemptAbortController);
    });

  const postCompactionAbortError = control.getPostCompactionAbortError();
  if (postCompactionAbortError) {
    throw postCompactionAbortError;
  }
  return { rawAttempt, cancellationRequested, preparedAttempt: attemptParams };
}
