import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { createShowWidgetTool } from "../canvas/widget-tool.js";
import type { ChatType } from "../channels/chat-type.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { ConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import { selectApplicableRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { getActiveRuntimeWebToolsMetadataFromState } from "../secrets/runtime-web-tools-state.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import type { SkillWorkshopRunOptions } from "../skills/workshop/types.js";
import { resolveTranscriptsConfig } from "../transcripts/config.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "./agent-scope.js";
import {
  type HookContext,
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import type { ConversationRecallContext } from "./conversation-recall.types.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { filterToolsByClientCaps } from "./openclaw-tools.client-caps.js";
import {
  isToolExplicitlyAllowedByFactoryPolicy,
  mergeFactoryPolicyList,
  resolveImageToolFactoryAvailable,
  resolveOptionalMediaToolFactoryPlan,
} from "./openclaw-tools.media-factory-plan.js";
import { createMediaGenerationAsyncStartCallback } from "./openclaw-tools.media-yield.js";
import type { ModelAwareToolContext } from "./openclaw-tools.model-context.js";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.nodes-workspace-guard.js";
import {
  collectPresentOpenClawTools,
  shouldIncludeAskUserToolForOpenClawTools,
  shouldIncludeUpdatePlanToolForOpenClawTools,
} from "./openclaw-tools.registration.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import { createOpenClawSwarmToolGroups } from "./openclaw-tools.swarm.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createAskUserTool } from "./tools/ask-user-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createComputerTool } from "./tools/computer-tool.js";
import {
  createConversationsListTool,
  createConversationsSendTool,
  createConversationsTurnTool,
} from "./tools/conversation-tools.js";
import { createCronTool } from "./tools/cron-tool.js";
import type { CronToolOptions } from "./tools/cron-tool.types.js";
import { createDashboardTool } from "./tools/dashboard-tool.js";
import { createEmbeddedCallGateway } from "./tools/embedded-gateway-stub.js";
import { createGatewayToolCallerWrapper } from "./tools/gateway-caller-context.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import {
  createCreateGoalTool,
  createGetGoalTool,
  createUpdateGoalTool,
} from "./tools/goal-tools.js";
import { createHeartbeatResponseTool } from "./tools/heartbeat-response-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { callAgentToolGatewayRequest } from "./tools/in-process-gateway.js";
import { createMessageTool } from "./tools/message-tool-execution.js";
import { createMobileUiTool } from "./tools/mobile-ui-tool.js";
import { createMusicGenerateTool } from "./tools/music-generate-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createOpenClawDelegateToolsForRun } from "./tools/openclaw-delegate-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createPortalTool } from "./tools/portal-tool.js";
import { createScreenTool } from "./tools/screen-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSearchTool } from "./tools/sessions-search-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsTool } from "./tools/sessions-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";
import { createConfiguredSkillWorkshopTool } from "./tools/skill-workshop-tool-factory.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTaskSuggestionTools } from "./tools/task-suggestion-tools.js";
import { createTerminalTool } from "./tools/terminal-tool.js";
import { createTranscriptsTool } from "./tools/transcripts-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";
import { createVideoGenerateTool } from "./tools/video-generate-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

export { filterToolsByClientCaps } from "./openclaw-tools.client-caps.js";
export function createOpenClawTools(
  options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    toolBindings?: Readonly<Record<string, unknown>>;
    /**
     * The durable store session key for the live run when it differs from the
     * sandbox/policy session key used to construct the tool set.
     */
    runSessionKey?: string;
    agentChannel?: string;
    runId?: string;
    agentAccountId?: string;
    /** Trusted account used only for Gateway authorization; delivery keeps agentAccountId. */
    gatewayCallerAccountId?: string;
    /** Delivery target for topic/thread routing. */
    agentTo?: string;
    /** Thread/topic identifier for routing replies to the originating thread. */
    agentThreadId?: string | number;
    /** Trusted platform-native conversation id for the active inbound turn. */
    nativeChannelId?: string;
    /** Opaque host-issued capability for current-turn channel message actions. */
    messageActionTurnCapability?: string;
    sandboxRoot?: string;
    sandboxContainerWorkdir?: string;
    sandboxFsBridge?: SandboxFsBridge;
    fsPolicy?: ToolFsPolicy;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    webSearchEnabled?: boolean;
    /** Capabilities declared by the gateway client that originated this run. */
    clientCaps?: string[];
    pluginToolAllowlist?: string[];
    pluginToolDenylist?: string[];
    /** Effective caller tool surface to persist on isolated cron agentTurn jobs. */
    cronCreatorToolAllowlist?: CronToolOptions["creatorToolAllowlist"];
    cronCreatorToolAllowlistCaptureRef?: CronToolOptions["creatorToolAllowlistCaptureRef"];
    resolveCronCreatorToolAuthority?: CronToolOptions["resolveCreatorToolAuthority"];
    cronCreatorAuthorityUnavailableReason?: CronToolOptions["creatorAuthorityUnavailableReason"];
    /** Current channel ID for auto-threading. */
    currentChannelId?: string;
    /** Trusted normalized conversation kind for the active inbound turn. */
    currentChatType?: ChatType;
    /** Routable target for the current conversation when it differs from the native channel ID. */
    currentMessagingTarget?: string;
    /** Current thread timestamp for auto-threading. */
    currentThreadTs?: string;
    /** Current inbound message id for action fallbacks. */
    currentMessageId?: string | number;
    /** True when the current inbound turn carried audio media. */
    currentInboundAudio?: boolean;
    /** Dynamic audio state for runs that can accept steered input after tool creation. */
    hasCurrentInboundAudio?: () => boolean;
    /** Reply-to mode for auto-threading. */
    replyToMode?: "off" | "first" | "all" | "batched";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: { value: boolean };
    /** Fail closed instead of posting same-channel thread-originated replies at the root. */
    sameChannelThreadRequired?: boolean;
    /** Mutable model-context generation used to expire screenshot coordinate frames. */
    computerContextEpoch?: { value: number };
    /** Internal review-run restrictions and proposal provenance. */
    skillWorkshop?: SkillWorkshopRunOptions;
    /** If true, nodes action="invoke" can call media-returning commands directly. */
    allowMediaInvokeCommands?: boolean;
    /** Trusted sender identity bit for channel action auth. */
    senderIsOwner?: boolean;
    /** Server-owned operation-local origin for conversation-read visibility policy. */
    conversationReadOrigin?: ConversationReadInvocationOrigin;
    /** Restrict cron operations to the active cron job's self-scoped surface. */
    cronSelfRemoveOnlyJobId?: string;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** Visible source replies must be sent through the message tool when set to message_tool_only. */
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    /** Process-local completion authority restricted to the current source conversation. */
    sourceReplyOnly?: boolean;
    /** Action sink available for model-proposed follow-up tasks. */
    taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
    inboundEventKind?: InboundEventKind;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    swarmCollector?: boolean;
    swarmOutputSchema?: Record<string, unknown>;
    /** If true, include the heartbeat response tool for structured heartbeat outcomes. */
    enableHeartbeatTool?: boolean;
    /** If true, skip plugin tool resolution and return only shipped core tools. */
    disablePluginTools?: boolean;
    /**
     * Wrap returned tools with the before_tool_call hook at construction time.
     * Defaults to true; callers that already enforce the hook at a later shared
     * boundary should opt out explicitly.
     */
    wrapBeforeToolCallHook?: boolean;
    /** Override or extend the default hook context used by construction-time wrapping. */
    beforeToolCallHookContext?: HookContext;
    /** Records hot-path tool-prep stages for reply startup diagnostics. */
    recordToolPrepStage?: (name: string) => void;
    /** Trusted sender id from inbound context (not tool args). */
    requesterSenderId?: string | null;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /** Trusted runtime-only authorization for one bounded cross-conversation recall pass. */
    conversationRecall?: ConversationRecallContext;
    /**
     * Explicit one-shot local CLI runs should not keep plugin-owned process
     * resources alive after emitting their result.
     */
    oneShotCliRun?: boolean;
    /**
     * Workspace directory to pass to spawned subagents for inheritance.
     * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
     * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
     * subagents inherit the real workspace path instead of the sandbox copy.
     */
    spawnWorkspaceDir?: string;
    /** Current runtime directory used as the default project for follow-up suggestions. */
    cwd?: string;
    /** Callback invoked when sessions_yield tool is called. */
    onYield?: (message: string) => Promise<void> | void;
    /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
    allowGatewaySubagentBinding?: boolean;
  } & SpawnedToolContext &
    ModelAwareToolContext,
): AnyAgentTool[] {
  const resolvedConfig = options?.config;
  const activeProjectKeys = options?.preparedModelRuntime?.activeProjectKeys ?? [];
  const runtimeSnapshot = getActiveSecretsRuntimeConfigSnapshot();
  const availabilityConfig = selectApplicableRuntimeConfig({
    inputConfig: resolvedConfig,
    runtimeConfig: runtimeSnapshot?.config,
    runtimeSourceConfig: runtimeSnapshot?.sourceConfig,
  });
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: options?.agentSessionKey,
    config: resolvedConfig,
    agentId: options?.requesterAgentIdOverride,
  });
  const swarmToolGroups = createOpenClawSwarmToolGroups({
    config: resolvedConfig,
    effectiveRequesterAgentId: sessionAgentId,
    agentSessionKey: options?.agentSessionKey,
    runSessionKey: options?.runSessionKey,
    runId: options?.runId,
    swarmCollector: options?.swarmCollector,
    swarmOutputSchema: options?.swarmOutputSchema,
  });
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
  const spawnWorkspaceDir = resolveWorkspaceRoot(
    options?.spawnWorkspaceDir ?? options?.workspaceDir ?? inferredWorkspaceDir,
  );
  options?.recordToolPrepStage?.("openclaw-tools:session-workspace");
  const deliveryContext = normalizeDeliveryContext({
    channel: options?.agentChannel,
    to: options?.agentTo,
    accountId: options?.agentAccountId,
    threadId: options?.agentThreadId,
  });
  // Scheduled turns keep delivery routing live, but Gateway authorization remains bound to the
  // authenticated creator account captured in the immutable scheduled authority envelope.
  const gatewayCallerAccountId = options?.gatewayCallerAccountId ?? options?.agentAccountId;
  const runtimeWebTools = getActiveRuntimeWebToolsMetadataFromState();
  const sandbox =
    options?.sandboxRoot && options?.sandboxFsBridge
      ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
      : undefined;
  const optionalMediaTools = resolveOptionalMediaToolFactoryPlan({
    config: availabilityConfig ?? resolvedConfig,
    workspaceDir,
    authStore: options?.authProfileStore,
    toolAllowlist: options?.pluginToolAllowlist,
    toolDenylist: options?.pluginToolDenylist,
    preparedModelRuntime: options?.preparedModelRuntime,
  });
  const trimmedRunSessionKey = options?.runSessionKey?.trim();
  const mediaGenerationAgentSessionKey =
    trimmedRunSessionKey && isCronRunSessionKey(trimmedRunSessionKey)
      ? trimmedRunSessionKey
      : options?.agentSessionKey;
  const mediaGenerationAsyncStartCallback = createMediaGenerationAsyncStartCallback({
    sessionKey: mediaGenerationAgentSessionKey,
    onYield: options?.onYield,
  });
  const taskKey = normalizeOptionalString(options?.runSessionKey ?? options?.agentSessionKey);
  const requesterSessionKey = trimmedRunSessionKey || options?.agentSessionKey;
  const requesterTurnRunId = options?.runId;
  const imageTool =
    options?.agentDir &&
    resolveImageToolFactoryAvailable({
      config: availabilityConfig ?? resolvedConfig,
      agentDir: options.agentDir,
      workspaceDir,
      modelHasVision: options?.modelHasVision,
      authStore: options?.authProfileStore,
      preparedModelRuntime: options?.preparedModelRuntime,
    })
      ? createImageTool({
          config: availabilityConfig ?? options?.config,
          agentId: sessionAgentId,
          agentDir: options.agentDir,
          preparedModelRuntime: options?.preparedModelRuntime,
          authProfileStore: options?.authProfileStore,
          workspaceDir,
          sandbox,
          fsPolicy: options?.fsPolicy,
          agentChannel: options?.agentChannel,
          agentAccountId: options?.agentAccountId,
          currentChannelId: options?.currentChannelId,
          modelHasVision: options?.modelHasVision,
          deferAutoModelResolution: true,
        })
      : null;
  options?.recordToolPrepStage?.("openclaw-tools:image-tool");
  const mediaGenerationToolOptions = {
    config: options?.config,
    agentDir: options?.agentDir,
    authProfileStore: options?.authProfileStore,
    agentSessionKey: mediaGenerationAgentSessionKey,
    requesterAgentId: sessionAgentId,
    requesterOrigin: deliveryContext ?? undefined,
    workspaceDir,
    preparedModelRuntime: options?.preparedModelRuntime,
    sandbox,
    fsPolicy: options?.fsPolicy,
    onAsyncTaskStarted: mediaGenerationAsyncStartCallback,
  };
  const imageGenerateTool = optionalMediaTools.imageGenerate
    ? createImageGenerateTool(mediaGenerationToolOptions)
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:image-generate-tool");
  const videoGenerateTool = optionalMediaTools.videoGenerate
    ? createVideoGenerateTool(mediaGenerationToolOptions)
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:video-generate-tool");
  const musicGenerateTool = optionalMediaTools.musicGenerate
    ? createMusicGenerateTool(mediaGenerationToolOptions)
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:music-generate-tool");
  const pdfTool =
    optionalMediaTools.pdf && options?.agentDir?.trim()
      ? createPdfTool({
          config: options?.config,
          agentId: sessionAgentId,
          agentDir: options.agentDir,
          preparedModelRuntime: options?.preparedModelRuntime,
          authProfileStore: options?.authProfileStore,
          workspaceDir,
          sandbox,
          fsPolicy: options?.fsPolicy,
          deferAutoModelResolution: true,
        })
      : null;
  options?.recordToolPrepStage?.("openclaw-tools:pdf-tool");
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    enabled: options?.webSearchEnabled,
    agentDir: options?.agentDir,
    sandboxed: options?.sandboxed,
    runtimeWebSearch: runtimeWebTools?.search,
    lateBindRuntimeConfig: true,
  });
  options?.recordToolPrepStage?.("openclaw-tools:web-search-tool");
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
    runtimeWebFetch: runtimeWebTools?.fetch,
    lateBindRuntimeConfig: true,
  });
  options?.recordToolPrepStage?.("openclaw-tools:web-fetch-tool");
  const messageTool = options?.disableMessageTool
    ? null
    : createMessageTool({
        agentAccountId: options?.agentAccountId,
        agentSessionKey: options?.agentSessionKey,
        runSessionKey: options?.runSessionKey,
        runId: options?.runId,
        agentId: sessionAgentId,
        sessionId: options?.sessionId,
        messageActionTurnCapability: options?.messageActionTurnCapability,
        config: options?.config,
        preparedMessageToolCatalog: options?.preparedModelRuntime?.messageToolCatalog,
        currentChannelId: options?.currentChannelId,
        currentChatType: options?.currentChatType,
        currentMessagingTarget:
          options?.currentMessagingTarget ??
          (options?.sourceReplyOnly ? options.agentTo : undefined),
        currentChannelProvider: options?.agentChannel,
        currentThreadTs: options?.currentThreadTs,
        currentInboundAudio: options?.currentInboundAudio,
        hasCurrentInboundAudio: options?.hasCurrentInboundAudio,
        agentThreadId: options?.agentThreadId,
        currentMessageId: options?.currentMessageId,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sameChannelThreadRequired: options?.sameChannelThreadRequired,
        sandboxRoot: options?.sandboxRoot,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
        sourceReplyOnly: options?.sourceReplyOnly,
        inboundEventKind: options?.inboundEventKind,
        requesterSenderId: options?.requesterSenderId ?? undefined,
        senderIsOwner: options?.senderIsOwner,
        conversationReadOrigin: options?.conversationReadOrigin,
      });
  const heartbeatTool = options?.enableHeartbeatTool ? createHeartbeatResponseTool() : null;
  options?.recordToolPrepStage?.("openclaw-tools:message-tool");
  const nodesToolBase = createNodesTool({
    agentSessionKey: options?.agentSessionKey,
    agentId: sessionAgentId,
    agentChannel: options?.agentChannel,
    agentAccountId: options?.agentAccountId,
    currentChannelId: options?.currentChannelId,
    currentThreadTs: options?.currentThreadTs,
    config: options?.config,
    modelHasVision: options?.modelHasVision,
    allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
  });
  const nodesTool = applyNodesToolWorkspaceGuard(nodesToolBase, {
    fsPolicy: options?.fsPolicy,
    sandboxContainerWorkdir: options?.sandboxContainerWorkdir,
    sandboxRoot: options?.sandboxRoot,
    workspaceDir,
  });
  options?.recordToolPrepStage?.("openclaw-tools:nodes-tool");
  const embedded = isEmbeddedMode();
  const explicitFactoryAllowlist = mergeFactoryPolicyList(
    resolvedConfig?.tools?.allow,
    resolvedConfig?.tools?.alsoAllow,
    options?.pluginToolAllowlist,
  );
  const explicitFactoryDenylist = mergeFactoryPolicyList(
    resolvedConfig?.tools?.deny,
    options?.pluginToolDenylist,
  );
  const includeMessageTool =
    !embedded ||
    options?.sourceReplyDeliveryMode === "message_tool_only" ||
    isToolExplicitlyAllowedByFactoryPolicy({
      toolName: "message",
      allowlist: explicitFactoryAllowlist,
      denylist: explicitFactoryDenylist,
    });
  const effectiveCallGateway = embedded ? createEmbeddedCallGateway() : callAgentToolGatewayRequest;
  const includeUpdatePlanTool = shouldIncludeUpdatePlanToolForOpenClawTools({
    config: resolvedConfig,
    pluginToolDenylist: options?.pluginToolDenylist,
  });
  const includeAskUserTool = shouldIncludeAskUserToolForOpenClawTools({
    config: resolvedConfig,
    agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
    pluginToolDenylist: options?.pluginToolDenylist,
  });
  const includeTranscriptsTool = resolveTranscriptsConfig(resolvedConfig?.transcripts).enabled;
  const tools: AnyAgentTool[] = [
    createDashboardTool({
      agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
      agentId: sessionAgentId,
    }),
    ...(embedded
      ? []
      : [
          nodesTool,
          createMobileUiTool({ idempotencyScope: options?.runId }),
          ...(options?.modelHasVision === false
            ? []
            : [
                createComputerTool({
                  config: options?.config,
                  modelHasVision: options?.modelHasVision,
                  // Run ids expire before later assistant runs can reuse a provider call id.
                  idempotencyScope: options?.runId,
                  contextEpoch: options?.computerContextEpoch,
                }),
              ]),
          createCronTool({
            // Use the durable runSessionKey; cleanup-retired policy keys leave cron jobs dangling.
            agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            agentId: sessionAgentId,
            agentAccountId: gatewayCallerAccountId,
            config: options?.config,
            currentDeliveryContext: {
              channel: options?.agentChannel,
              to: options?.currentChannelId ?? options?.agentTo,
              accountId: options?.agentAccountId,
              threadId: options?.currentThreadTs ?? options?.agentThreadId,
            },
            creatorToolAllowlist: options?.cronCreatorToolAllowlist,
            creatorToolAllowlistCaptureRef: options?.cronCreatorToolAllowlistCaptureRef,
            resolveCreatorToolAuthority: options?.resolveCronCreatorToolAuthority,
            creatorAuthorityUnavailableReason: options?.cronCreatorAuthorityUnavailableReason,
            runId: options?.runId,
            selfRemoveOnlyJobId: options?.cronSelfRemoveOnlyJobId,
          }),
          createSessionsTool({
            agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            agentSessionId: options?.sessionId,
            requesterAgentIdOverride: sessionAgentId,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
          }),
          createScreenTool({
            agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            agentId: sessionAgentId,
          }),
          ...(options?.sandboxed
            ? []
            : [
                createTerminalTool({
                  agentId: sessionAgentId,
                  agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
                  runId: options?.runId,
                }),
                createPortalTool(),
              ]),
        ]),
    ...(!embedded && taskKey && options?.taskSuggestionDeliveryMode === "gateway"
      ? createTaskSuggestionTools({
          sessionKey: taskKey,
          agentId: sessionAgentId,
          cwd: resolveWorkspaceRoot(options?.cwd ?? options?.workspaceDir ?? inferredWorkspaceDir),
        })
      : []),
    ...(messageTool && includeMessageTool ? [messageTool] : []),
    // Discord owns show_widget; registering the core tool would collide.
    ...(options?.agentChannel === "discord" || !isCoreCanvasHostEnabled(resolvedConfig)
      ? []
      : [
          createShowWidgetTool({
            sessionId: options?.sessionId,
            agentId: sessionAgentId,
            agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
          }),
        ]),
    ...collectPresentOpenClawTools([heartbeatTool]),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: resolvedConfig,
      agentId: sessionAgentId,
      agentAccountId: options?.agentAccountId,
    }),
    ...(includeTranscriptsTool
      ? [createTranscriptsTool({ agentId: sessionAgentId, config: resolvedConfig })]
      : []),
    ...collectPresentOpenClawTools([imageGenerateTool, musicGenerateTool, videoGenerateTool]),
    ...(embedded
      ? []
      : [
          createGatewayTool(),
          ...createOpenClawDelegateToolsForRun({ ...options, sessionAgentId }),
        ]),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: sessionAgentId,
    }),
    createGetGoalTool({
      agentSessionKey: options?.agentSessionKey,
      runSessionKey: options?.runSessionKey,
      sessionAgentId,
      config: resolvedConfig,
    }),
    createCreateGoalTool({
      agentSessionKey: options?.agentSessionKey,
      runSessionKey: options?.runSessionKey,
      sessionAgentId,
      config: resolvedConfig,
    }),
    createUpdateGoalTool({
      agentSessionKey: options?.agentSessionKey,
      runSessionKey: options?.runSessionKey,
      sessionAgentId,
      config: resolvedConfig,
    }),
    ...(options?.sandboxed
      ? []
      : [
          createConfiguredSkillWorkshopTool({
            workspaceDir,
            config: resolvedConfig,
            agentId: sessionAgentId,
            sessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            runId: options?.runId,
            messageId: options?.currentMessageId,
            run: options?.skillWorkshop,
          }),
        ]),
    ...(includeUpdatePlanTool ? [createUpdatePlanTool()] : []),
    ...swarmToolGroups.structuredOutput,
    ...(includeAskUserTool
      ? [
          createAskUserTool({
            agentId: sessionAgentId,
            sessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            runId: options?.runId,
          }),
        ]
      : []),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: sessionAgentId,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: effectiveCallGateway,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: sessionAgentId,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: effectiveCallGateway,
    }),
    createSessionsSearchTool({
      agentId: sessionAgentId,
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: effectiveCallGateway,
    }),
    ...(embedded
      ? []
      : [
          createConversationsListTool({
            agentId: sessionAgentId,
            agentSessionId: options?.sessionId,
            agentSessionKey: options?.agentSessionKey,
            config: resolvedConfig,
            senderIsOwner: options?.senderIsOwner,
          }),
          createConversationsSendTool({
            agentId: sessionAgentId,
            agentSessionId: options?.sessionId,
            agentSessionKey: options?.agentSessionKey,
            config: resolvedConfig,
            senderIsOwner: options?.senderIsOwner,
          }),
          createConversationsTurnTool({
            agentId: sessionAgentId,
            agentSessionId: options?.sessionId,
            agentSessionKey: options?.agentSessionKey,
            config: resolvedConfig,
            senderIsOwner: options?.senderIsOwner,
          }),
          // No explicit callGateway: the tool defaults to the same in-process
          // caller, and an injected override would disable the trusted creation
          // stamp for materialized agent roots (opts.callGateway === undefined
          // is the gate in ensureConfiguredAgentMainSession).
          createSessionsSendTool({
            agentId: sessionAgentId,
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
          }),
        ]),
    ...(!embedded || options?.allowGatewaySubagentBinding === true
      ? [
          createSessionsSpawnTool({
            agentSessionKey: options?.agentSessionKey,
            requesterTurnRunId: options?.runId,
            completionOwnerKey: options?.runSessionKey,
            agentChannel: options?.agentChannel,
            agentAccountId: options?.agentAccountId,
            agentTo: options?.agentTo,
            agentThreadId: options?.agentThreadId,
            currentMessagingTarget: options?.currentMessagingTarget,
            currentChannelId: options?.currentChannelId,
            currentThreadTs: options?.currentThreadTs,
            currentMessageId: options?.currentMessageId,
            agentGroupId: options?.agentGroupId,
            agentGroupChannel: options?.agentGroupChannel,
            agentGroupSpace: options?.agentGroupSpace,
            agentMemberRoleIds: options?.agentMemberRoleIds,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
            requesterAgentIdOverride: sessionAgentId,
            requesterRunId: options?.runId,
            swarmCollector: options?.swarmCollector,
            workspaceDir: spawnWorkspaceDir,
            inheritedToolAllowlist: options?.inheritedToolAllowlist,
            inheritedToolDenylist: options?.inheritedToolDenylist,
          }),
        ]
      : []),
    ...swarmToolGroups.agentsWait,
    createSessionsYieldTool({
      sessionId: options?.sessionId,
      onBeforeYield: createRequesterYieldCallback({
        requesterSessionKey,
        requesterAgentId: sessionAgentId,
        requesterTurnRunId,
      }),
      onYield: options?.onYield,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
      agentId: sessionAgentId,
      config: resolvedConfig,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: sessionAgentId,
      runSessionKey: options?.runSessionKey,
      config: resolvedConfig,
      sandboxed: options?.sandboxed,
      activeModelProvider: options?.modelProvider,
      activeModelId: options?.modelId,
      metadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
      activeDeliveryContext: {
        channel: options?.agentChannel,
        to: options?.currentChannelId ?? options?.agentTo,
        accountId: options?.agentAccountId,
        threadId: options?.currentThreadTs ?? options?.agentThreadId,
      },
    }),
    ...collectPresentOpenClawTools([webSearchTool, webFetchTool, imageTool, pdfTool]),
  ];
  options?.recordToolPrepStage?.("openclaw-tools:core-tool-list");
  let allTools = tools;
  if (!options?.disablePluginTools) {
    const existingToolNames = new Set<string>();
    for (const tool of tools) {
      existingToolNames.add(tool.name);
    }
    allTools = [
      ...tools,
      ...resolveOpenClawPluginToolsForOptions({
        options: { ...options, activeProjectKeys },
        resolvedConfig,
        existingToolNames,
      }),
    ];
    options?.recordToolPrepStage?.("openclaw-tools:plugin-tools");
  }

  allTools = filterToolsByClientCaps(allTools, options?.clientCaps);
  options?.recordToolPrepStage?.("openclaw-tools:client-capabilities");

  const hookAgentId = options?.requesterAgentIdOverride ?? sessionAgentId;
  const wrapGatewayCallerIdentity = createGatewayToolCallerWrapper(
    hookAgentId,
    options ? { ...options, agentAccountId: gatewayCallerAccountId } : options,
  );

  if (options?.wrapBeforeToolCallHook === false) {
    return allTools.map(wrapGatewayCallerIdentity);
  }
  const defaultHookContext: HookContext = {
    ...(hookAgentId ? { agentId: hookAgentId } : {}),
    ...(resolvedConfig ? { config: resolvedConfig } : {}),
    ...(options?.agentSessionKey ? { sessionKey: options.agentSessionKey } : {}),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.currentChannelId ? { channelId: options.currentChannelId } : {}),
    loopDetection: resolveToolLoopDetectionConfig({ cfg: resolvedConfig, agentId: hookAgentId }),
  };
  const hookContext = { ...defaultHookContext, ...options?.beforeToolCallHookContext };
  options?.recordToolPrepStage?.("openclaw-tools:tool-hooks");
  return allTools
    .map((tool) =>
      isToolWrappedWithBeforeToolCallHook(tool)
        ? tool
        : wrapToolWithBeforeToolCallHook(tool, hookContext),
    )
    .map(wrapGatewayCallerIdentity);
}
