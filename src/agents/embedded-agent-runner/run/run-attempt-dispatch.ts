import path from "node:path";
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
import { resolveSessionPermissionExecMode } from "../../session-permission-exec-mode.js";
import { resolveSessionPlacementSandbox } from "../../session-placement-admission.js";
import { resolveSessionSkillResourceSnapshot } from "../../session-placement-skill-resources.js";
import { createToolTerminalObserver } from "../../tool-terminal-outcome.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import type { SystemAgentToolOptions } from "../../tools/system-agent-tool.js";
import {
  resolveSandboxSkillRuntimeInputs,
  mapSandboxSkillUsagePaths,
  remapSkillReferencePaths,
} from "../sandbox-skills.js";
import { prepareExecApprovalContinuationForAttempt } from "./attempt-exec-approval-continuation.js";
import { applyResolvedToolPromptFinalizer } from "./attempt-prompt-support.js";
import { resolveAttemptWorkspaceSandbox } from "./attempt-setup.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";
import type {
  EmbeddedRunAttemptInternalParams,
  RunEmbeddedAgentInternalParams,
} from "./internal-params.js";
import type { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { PreparedNativeSessionRuntime } from "./model-setup.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";
import { resolveSkillWorkshopAttemptParams } from "./skill-workshop-attempt-params.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptTrajectoryRecorder } from "./types.js";

type InternalRunParams = RunEmbeddedAgentInternalParams & {
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
  nativeSessionRuntime?: PreparedNativeSessionRuntime;
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
  createAttemptControls: ReturnType<
    typeof createEmbeddedRunLaneController
  >["createAttemptControls"];
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
  permissionChange?: EmbeddedRunAttemptParams["permissionChange"];
  /** Run-owned start timestamp captured before admission; projected on recovery. */
  runStartedAtMs: number;
  runtime: AttemptRuntime;
  transcriptOwnership: AttemptTranscriptOwnership;
  control: AttemptControl;
  bootstrapPromptWarningSignaturesSeen: string[];
  suppressNextUserMessagePersistence: boolean;
  beforeAgentFinalizeRevisionAttempts: number;
  maxBeforeAgentFinalizeRevisions: number;
}): Promise<{
  rawAttempt: Awaited<ReturnType<typeof runEmbeddedAttemptWithBackend>>;
  preparedAttempt: EmbeddedRunAttemptParams;
}> {
  const { params, runtime, control } = input;
  const observeToolTerminal = createToolTerminalObserver(params.runId);
  const attemptAbortController = new AbortController();
  control.setPostCompactionAbortController(attemptAbortController);
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
  const pluginWorkspace = control.pluginHarnessOwnsTransport
    ? await resolveAttemptWorkspaceSandbox({
        ...params,
        agentId: runtime.agentId,
        cwd: undefined,
        sessionId: runtime.sessionId,
        sessionKey: runtime.sessionKey,
        workspaceDir: runtime.workspaceDir,
      })
    : undefined;
  const promptMedia = pluginWorkspace
    ? await prepareEmbeddedAttemptPromptExecution({
        attempt: { ...params, model: runtime.model },
        mediaOwnerAgentId: pluginWorkspace.sessionAgentId,
        effectiveFsWorkspaceOnly: pluginWorkspace.effectiveFsWorkspaceOnly,
        effectiveWorkspace: pluginWorkspace.effectiveWorkspace,
        prompt: "",
        sandbox: pluginWorkspace.sandbox,
        skipPromptSubmission: false,
        pluginHarness: true,
      })
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
      })) ?? pluginWorkspace?.sandbox)
    : undefined;
  if (!params.admittedRunContext) {
    throw new Error("embedded attempt reached dispatch without an admitted run context");
  }
  const admittedRunContext = params.admittedRunContext;
  if (params.permissionMode) {
    // Attempts narrow this shared run-owned policy before recovery can reuse it.
    params.execOverrides ??= {};
    params.execOverrides.mode = resolveSessionPermissionExecMode({ mode: params.permissionMode });
  }
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
  let skillsSnapshot = resolveSessionSkillResourceSnapshot(params.skillsSnapshot);
  let skillReferencePaths = pluginSandbox?.readOnlyResourceMounts?.map((mount) => ({
    skillFile: path.join(mount.hostPath, "SKILL.md"),
    readPath: path.posix.join(mount.containerPath, "SKILL.md"),
  }));
  if (
    pluginSandbox?.enabled &&
    !pluginSandbox.readOnlyResourceMounts?.length &&
    skillsSnapshot?.librarySelections?.length
  ) {
    const prepared = resolveSandboxSkillRuntimeInputs({
      sandbox: pluginSandbox,
      skillsAnchorWorkspace: runtime.bootstrapWorkspaceDir ?? runtime.workspaceDir,
      skillsSnapshot,
    });
    skillsSnapshot = prepared.skillsSnapshot;
    skillReferencePaths = mapSandboxSkillUsagePaths({
      paths: pluginSandbox.skillUsagePaths,
      skillsWorkspaceDir: prepared.skillsWorkspaceDir,
      skillsPromptWorkspaceDir: prepared.skillsPromptWorkspaceDir,
    });
  }
  const attemptControls = control.createAttemptControls({
    admittedRunContext,
    abortSignal: attemptAbortController.signal,
    onAbort: () => {
      if (!params.abortSignal?.aborted) {
        params.replyOperation?.abortByUser();
      }
    },
  });
  const attemptParams: EmbeddedRunAttemptInternalParams = {
    permissionChange: input.permissionChange,
    admittedRunContext: params.admittedRunContext,
    startedAtMs: input.runStartedAtMs,
    contextEngineAgentId: runtime.contextEngineAgentId,
    ...(control.pluginHarnessOwnsTransport ? { sandbox: pluginSandbox } : {}),
    operation: "attempt",
    sessionId: runtime.sessionId,
    sessionKey: runtime.sessionKey,
    conversationRecall: params.conversationRecall,
    promptCacheKey: params.promptCacheKey,
    sandboxSessionKey: params.sandboxSessionKey,
    sandboxAgentId: params.sandboxAgentId,
    trigger: params.trigger,
    memoryFlushWritePath: params.memoryFlushWritePath,
    messageChannel: params.messageChannel,
    messageProvider: params.messageProvider,
    clientCaps: params.clientCaps,
    toolBindings: params.toolBindings,
    // Preserve the Gateway's tri-state capability; undefined hides both GitHub tools.
    githubPublicationAvailable: params.githubPublicationAvailable,
    chatType: params.chatType,
    agentAccountId: params.agentAccountId,
    conversationRoutePeerId: params.conversationRoutePeerId,
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
    skillsSnapshot,
    prompt: remapSkillReferencePaths(
      pluginHarnessPrompt ?? preparedExecApprovalContinuation.prompt,
      skillReferencePaths,
    ),
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
    explicitSkillSelections: params.explicitSkillSelections?.map((selection) => ({
      ...selection,
      path: remapSkillReferencePaths(selection.path, skillReferencePaths),
    })),
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
    ...(runtime.nativeSessionRuntime
      ? {
          expectedSessionRuntimeOwnership: {
            model: "native",
            auth: runtime.nativeSessionRuntime.auth,
            ...(runtime.nativeSessionRuntime.auth === "host"
              ? { modelRef: runtime.nativeSessionRuntime.modelRef }
              : {}),
          },
        }
      : {}),
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
    execOverrides: params.execOverrides,
    bashElevated: params.bashElevated,
    timeoutMs: params.timeoutMs,
    runTimeoutOverrideMs: params.runTimeoutOverrideMs,
    runId: params.runId,
    lifecycleGeneration: control.lifecycleGeneration,
    abortSignal: attemptControls.abortSignal,
    onAttemptDeadlineChanged: attemptControls.onAttemptDeadlineChanged,
    onAttemptTimeout: attemptControls.onAttemptTimeout,
    onAttemptAbort: attemptControls.onAttemptAbort,
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
    onDeferredLifecycleOwner: params.onDeferredLifecycleOwner,
    onDeferredLifecycleAbort: params.onDeferredLifecycleAbort,
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
    toolExecutionAllow: params.toolExecutionAllow,
    // Authorized prompt enrichment needs the exact prepared turn policy identity.
    toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    sessionPersistence: params.sessionPersistence,
    // The host loop settles all completed counts, including default/SDK runs.
    compactionCountOwner: "caller",
    onContextAccountingEvent: params.onContextAccountingEvent,
    ...(params.systemAgentTool ? { systemAgentTool: params.systemAgentTool } : {}),
    cleanupBundleMcpOnRunEnd: params.cleanupBundleMcpOnRunEnd,
    disableMessageTool: params.disableMessageTool,
    swarmCollector: params.swarmCollector,
    swarmOutputSchema: params.swarmOutputSchema,
    forceRestartSafeTools: params.forceRestartSafeTools,
    forceCodeModeTools: params.forceCodeModeTools,
    codeModeOverride: params.codeModeOverride,
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
    prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
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
    runEmbeddedAttemptWithBackend(attemptParams, runtime.nativeSessionRuntime),
  )
    .catch((err: unknown): never => {
      throw control.getPostCompactionAbortError() ?? err;
    })
    .finally(() => {
      attemptControls.close();
      control.clearPostCompactionAbortController(attemptAbortController);
    });

  const postCompactionAbortError = control.getPostCompactionAbortError();
  if (postCompactionAbortError) {
    throw postCompactionAbortError;
  }
  return { rawAttempt, preparedAttempt: attemptParams };
}
