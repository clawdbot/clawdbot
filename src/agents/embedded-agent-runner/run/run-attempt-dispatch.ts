import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { createAgentHarnessTaskRuntimeScope } from "../../../tasks/agent-harness-task-runtime-scope.js";
import type { ToolOutcomeObserver } from "../../agent-tools.before-tool-call.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { resolveDelegationCapability } from "../../delegation-capability.js";
import type { AgentHarnessRuntimeArtifactBinding } from "../../harness/runtime-artifact.types.js";
import { appendIncognitoSystemPrompt } from "../../incognito-system-prompt.js";
import { applyAuthHeaderOverride, applyLocalNoAuthHeaderOverride } from "../../model-auth.js";
import { appendProgressCardSystemPrompt } from "../../progress-card-system-prompt.js";
import type { AgentRunSessionTarget } from "../../run-session-target.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import { resolveSandboxContext } from "../../sandbox/context.js";
import { resolveSessionPermissionExecMode } from "../../session-permission-exec-mode.js";
import { resolveSessionPlacementSandbox } from "../../session-placement-admission.js";
import { createToolTerminalObserver } from "../../tool-terminal-outcome.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import type { SystemAgentToolOptions } from "../../tools/system-agent-tool.js";
import { prepareExecApprovalContinuationForAttempt } from "./attempt-exec-approval-continuation.js";
import { prepareEmbeddedAttemptPromptExecution } from "./attempt-prompt-submit.js";
import { applyResolvedToolPromptFinalizer } from "./attempt-prompt-support.js";
import { resolveAttemptWorkspaceSandbox } from "./attempt-setup.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";
import {
  EMBEDDED_RUN_LANE_HEARTBEAT_MS,
  EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
} from "./lane-runtime.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { resolveSkillWorkshopAttemptParams } from "./skill-workshop-attempt-params.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptTrajectoryRecorder } from "./types.js";

type InternalRunParams = RunEmbeddedAgentParams & {
  sessionFile: string;
  systemAgentTool?: SystemAgentToolOptions;
};

type AttemptRuntime = {
  contextEngineAgentId?: string;
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder;
  workspaceDir: string;
  bootstrapWorkspaceDir?: string;
  isCanonicalWorkspace: boolean;
  agentDir: string;
  preparedModelRuntime?: EmbeddedRunAttemptParams["preparedModelRuntime"];
  contextEngine?: EmbeddedRunAttemptParams["contextEngine"];
  contextTokenBudget?: number;
  authoredContextTokenCap?: number;
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

type AttemptTranscriptOwnership =
  | {
      kind: "caller-owned";
      sessionManager: NonNullable<RunEmbeddedAgentParams["sessionManager"]>;
    }
  | {
      kind: "runtime-target";
      sessionTarget?: AgentRunSessionTarget;
    };

type AttemptControl = {
  lifecycleGeneration: string;
  pluginHarnessOwnsTransport: boolean;
  laneTaskAbortController: AbortController;
  laneTaskReleaseController: AbortController;
  noteLaneTaskProgress: () => void;
  onToolOutcome: ToolOutcomeObserver;
  isTurnTainted: () => boolean;
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
  transcriptOwnership: AttemptTranscriptOwnership;
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
  const preparedExecApprovalContinuation = prepareExecApprovalContinuationForAttempt({
    prompt: runtime.prompt,
    transcriptPrompt: params.transcriptPrompt,
    promptRange: params.execApprovalContinuationPromptRange,
    transcriptPromptRange: params.execApprovalContinuationTranscriptPromptRange,
    contextTokenBudget: runtime.contextTokenBudget,
    modelContextWindow: runtime.model.contextWindow,
    modelMaxTokens: runtime.model.maxTokens,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
  });
  const promptMedia = control.pluginHarnessOwnsTransport
    ? await (async () => {
        const workspace = await resolveAttemptWorkspaceSandbox({
          ...params,
          cwd: undefined,
          sessionId: runtime.sessionId,
          sessionKey: runtime.sessionKey,
          workspaceDir: runtime.workspaceDir,
        });
        return await prepareEmbeddedAttemptPromptExecution({
          attempt: { ...params, model: runtime.model },
          mediaOwnerAgentId: workspace.sessionAgentId,
          effectiveFsWorkspaceOnly: workspace.effectiveFsWorkspaceOnly,
          effectiveWorkspace: workspace.effectiveWorkspace,
          prompt: "",
          sandbox: workspace.sandbox,
          skipPromptSubmission: false,
          pluginHarness: true,
        });
      })()
    : { images: params.images, imageOrder: params.imageOrder, media: params.media };
  // Plugin harnesses own their tool materialization, so the host cannot attest
  // a message tool. Finalize conservatively instead of leaking phantom guidance.
  const pluginHarnessPrompt =
    control.pluginHarnessOwnsTransport && params.finalizePromptForResolvedTools
      ? applyResolvedToolPromptFinalizer({
          prompt: preparedExecApprovalContinuation.prompt,
          activeToolNames: [],
          finalize: params.finalizePromptForResolvedTools,
        })
      : undefined;
  const pluginSandbox = control.pluginHarnessOwnsTransport
    ? ((await resolveSessionPlacementSandbox({
        agentId: runtime.agentId,
        config: params.config,
        sessionId: runtime.sessionId,
        sessionKey: runtime.sessionKey,
        workspaceDir: runtime.workspaceDir,
      })) ??
      (await resolveSandboxContext({
        config: params.config,
        sessionKey: params.sandboxSessionKey ?? runtime.sessionKey ?? runtime.sessionId,
        workspaceDir: runtime.workspaceDir,
      })))
    : undefined;
  if (!params.admittedRunContext) {
    throw new Error("embedded attempt reached dispatch without an admitted run context");
  }
  const execOverrides = params.permissionMode
    ? {
        ...params.execOverrides,
        mode: resolveSessionPermissionExecMode({ mode: params.permissionMode }),
      }
    : params.execOverrides;
  const incognitoSystemPrompt = appendIncognitoSystemPrompt({
    agentId: runtime.agentId,
    extraSystemPrompt: params.extraSystemPrompt,
    sessionKey: params.sessionKey,
    storePath: params.sessionTarget?.storePath,
  });
  const extraSystemPrompt = await appendProgressCardSystemPrompt({
    agentId: runtime.agentId,
    authProfileId: runtime.authProfileId,
    config: params.config,
    extraSystemPrompt: incognitoSystemPrompt,
    modelId: runtime.modelId,
    provider: runtime.provider,
    sessionKey: params.sessionKey,
    toolsAllow: params.toolsAllow,
  });
  const attemptParams: EmbeddedRunAttemptParams = {
    admittedRunContext: params.admittedRunContext,
    contextEngineAgentId: runtime.contextEngineAgentId,
    ...(control.pluginHarnessOwnsTransport ? { sandbox: pluginSandbox } : {}),
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
    toolBindings: params.toolBindings,
    chatType: params.chatType,
    agentAccountId: params.agentAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    conversationToolPolicy: params.conversationToolPolicy,
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
    ...(input.transcriptOwnership.kind === "caller-owned"
      ? { sessionManager: input.transcriptOwnership.sessionManager }
      : { sessionTarget: input.transcriptOwnership.sessionTarget }),
    trajectoryRecorder: runtime.trajectoryRecorder,
    workspaceDir: runtime.workspaceDir,
    bootstrapWorkspaceDir: runtime.bootstrapWorkspaceDir,
    cwd: params.cwd,
    permissionMode: params.permissionMode,
    sessionRoot: params.sessionRoot,
    agentDir: runtime.agentDir,
    preparedModelRuntime: runtime.preparedModelRuntime,
    config: params.config,
    toolOverrides: params.toolOverrides,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    ...(runtime.contextEngine
      ? {
          contextEngine: runtime.contextEngine,
          contextWindowInfo: runtime.contextWindowInfo,
        }
      : {}),
    ...(runtime.contextTokenBudget === undefined
      ? {}
      : { contextTokenBudget: runtime.contextTokenBudget }),
    ...(runtime.authoredContextTokenCap === undefined
      ? {}
      : { authoredContextTokenCap: runtime.authoredContextTokenCap }),
    skillsSnapshot: params.skillsSnapshot,
    prompt: pluginHarnessPrompt ?? preparedExecApprovalContinuation.prompt,
    transcriptPrompt:
      pluginHarnessPrompt !== undefined && params.transcriptPrompt === undefined
        ? preparedExecApprovalContinuation.prompt
        : preparedExecApprovalContinuation.transcriptPrompt,
    finalizePromptForResolvedTools:
      pluginHarnessPrompt === undefined ? params.finalizePromptForResolvedTools : undefined,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    // The outer run-loop owns the begun lease; the inner attempt reports only
    // the accepted candidate boundary to that owner.
    onContextEngineTurnCandidate: params.onContextEngineTurnCandidate,
    skipPreparedUserTurnMessage: runtime.skipPreparedUserTurnMessage,
    currentInboundEventKind: params.currentInboundEventKind,
    currentInboundContext: params.currentInboundContext,
    explicitSkillSelections: params.explicitSkillSelections,
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
      disableTools: params.disableTools,
      toolsAllow: params.toolsAllow,
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
            gatewayContextResolver: getGatewayContextResolver(params.admittedRunContext),
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
    isTurnTainted: control.isTurnTainted,
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
    execOverrides,
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
    extraSystemPrompt,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    inputProvenance: params.inputProvenance,
    trustedInternalHandoff: params.trustedInternalHandoff,
    scheduledToolPolicy: params.scheduledToolPolicy,
    cronCreatorAuthorityCapability: params.cronCreatorAuthorityCapability,
    cronCreatorAuthorityUnavailableReason: params.cronCreatorAuthorityUnavailableReason,
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
    scheduledRuntimeAuthority: params.scheduledRuntimeAuthority,
    scheduledRuntimeAuthorityRecoveryRequired: params.scheduledRuntimeAuthorityRecoveryRequired,
    toolsAllow: params.toolsAllow,
    ...(params.systemAgentTool ? { systemAgentTool: params.systemAgentTool } : {}),
    cleanupBundleMcpOnRunEnd: params.cleanupBundleMcpOnRunEnd,
    disableMessageTool: params.disableMessageTool,
    swarmCollector: params.swarmCollector,
    swarmOutputSchema: params.swarmOutputSchema,
    forceRestartSafeTools: params.forceRestartSafeTools,
    forceCodeModeReconciliationTools: params.forceCodeModeReconciliationTools,
    forceCodeModeTools: params.forceCodeModeTools,
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
  const callerIdentity = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: attemptParams.admittedRunContext,
    agentId: runtime.agentId,
    sessionKey: runtime.sessionKey,
    turnSourceChannel: params.messageChannel ?? params.messageProvider,
    turnSourceLocal:
      !params.messageChannel &&
      !params.messageProvider &&
      params.cronCreatorAuthorityCapability?.callerOrigin.kind === "local"
        ? true
        : undefined,
    turnSourceTo: params.currentMessagingTarget ?? params.currentChannelId,
    turnSourceAccountId: params.agentAccountId,
    turnSourceThreadId: params.currentThreadTs,
  });
  const rawAttempt = await withGatewayToolCallerIdentity(callerIdentity, () =>
    runEmbeddedAttemptWithBackend(attemptParams),
  )
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
