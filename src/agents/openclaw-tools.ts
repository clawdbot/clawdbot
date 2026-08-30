import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { createShowWidgetTool, hasRegisteredShowWidgetKinds } from "../canvas/widget-tool.js";
import { selectApplicableRuntimeConfig } from "../config/config.js";
import { resolveControlUiSessionLinkBase } from "../config/control-ui-link-base.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { getActiveRuntimeWebToolsMetadataFromState } from "../secrets/runtime-web-tools-state.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "./agent-scope.js";
import { bindAssembledAgentToolActionDescriptor } from "./agent-tool-metadata.js";
import {
  type HookContext,
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { filterToolsByClientCaps } from "./openclaw-tools.client-caps.js";
import {
  isToolExplicitlyAllowedByFactoryPolicy,
  mergeFactoryPolicyList,
  resolveImageToolFactoryAvailable,
  resolveOptionalMediaToolFactoryPlan,
} from "./openclaw-tools.media-factory-plan.js";
import { createMediaGenerationAsyncStartCallback } from "./openclaw-tools.media-yield.js";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.nodes-workspace-guard.js";
import {
  collectPresentOpenClawTools,
  shouldIncludeAskUserToolForOpenClawTools,
  shouldIncludeProgressCardToolForOpenClawTools,
  shouldIncludeSecretsToolForOpenClawTools,
} from "./openclaw-tools.registration.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import { createOpenClawSwarmToolGroups } from "./openclaw-tools.swarm.js";
import { resolveTranscriptsTool } from "./openclaw-tools.transcripts.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { resolveWidgetPresentationForRun } from "./openclaw-tools.widget-presentation.js";
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
import { createDashboardTool } from "./tools/dashboard-tool.js";
import { createEmbeddedCallGateway } from "./tools/embedded-gateway-stub.js";
import { createGatewayToolCallerWrapper } from "./tools/gateway-caller-context.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createGitHubIdentityStatusTool } from "./tools/github-identity-status-tool.js";
import { createGitHubPublishTool } from "./tools/github-publish-tool.js";
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
import { createProgressCardTool } from "./tools/progress-card-tool.js";
import { createScreenTool } from "./tools/screen-tool.js";
import { createSecretsTool } from "./tools/secrets-tool.js";
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
import { createTtsTool } from "./tools/tts-tool.js";
import { createVideoGenerateTool } from "./tools/video-generate-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

export { filterToolsByClientCaps } from "./openclaw-tools.client-caps.js";
export function createOpenClawTools(options?: OpenClawToolsOptions): AnyAgentTool[] {
  const resolvedConfig = options?.config;
  const sessionConfig = options?.sessionConfigSource === "runtime" ? undefined : resolvedConfig;
  const activeProjectKeys = options?.preparedModelRuntime?.activeProjectKeys ?? [];
  const runtimeSnapshot = getActiveSecretsRuntimeConfigSnapshot();
  const availabilityConfig = selectApplicableRuntimeConfig({
    inputConfig: resolvedConfig,
    runtimeConfig: runtimeSnapshot?.config,
    runtimeSourceConfig: runtimeSnapshot?.sourceConfig,
  });
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: options?.runSessionKey ?? options?.agentSessionKey,
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
  const spawnWorkspaceDir = resolveWorkspaceRoot(options?.spawnWorkspaceDir ?? workspaceDir);
  options?.recordToolPrepStage?.("openclaw-tools:session-workspace");
  const widgetPresentation = resolveWidgetPresentationForRun(options);
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
    requesterOrigin: widgetPresentation.deliveryContext ?? undefined,
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
    hostnameAllowlistRef: options?.webFetchHostnameAllowlistRef,
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
        sandboxContainerWorkdir: options?.sandboxContainerWorkdir,
        sandboxFsBridge: options?.sandboxFsBridge,
        sandboxWorkspaceMediaReadAllowed: options?.sandboxWorkspaceMediaReadAllowed,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
        deferSourceMessageToolDelivery: options?.deferSourceMessageToolDelivery,
        sourceReplyOnly: options?.sourceReplyOnly,
        inboundEventKind: options?.inboundEventKind,
        requesterSenderId: options?.requesterSenderId ?? undefined,
        senderIsOwner: options?.senderIsOwner,
        conversationReadOrigin: options?.conversationReadOrigin,
        workspaceDir,
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
  const sessionLookupToolOptions = {
    agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
    sandboxed: options?.sandboxed,
    config: sessionConfig,
    callGateway: embedded ? createEmbeddedCallGateway() : callAgentToolGatewayRequest,
    sessionLinkBase: resolveControlUiSessionLinkBase(resolvedConfig),
  };
  const progressCardTool = shouldIncludeProgressCardToolForOpenClawTools({
    ...options,
    agentId: sessionAgentId,
  })
    ? createProgressCardTool({
        agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
      })
    : null;
  const transcriptsTool = resolveTranscriptsTool(resolvedConfig, sessionAgentId, options);
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
                  registerRunCleanup: options?.registerRunCleanup,
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
            config: sessionConfig,
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
                  sessionId: options?.sessionId,
                  config: resolvedConfig,
                  execSession: options?.execSession,
                  execOverrides: options?.execOverrides,
                  runId: options?.runId,
                  approvalReviewerDeviceIds: options?.approvalReviewerDeviceIds,
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
    ...(!isCoreCanvasHostEnabled(resolvedConfig) &&
    !hasRegisteredShowWidgetKinds() &&
    !widgetPresentation.currentChannelPresenter
      ? []
      : [
          createShowWidgetTool({
            sessionId: options?.sessionId,
            agentId: sessionAgentId,
            agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            inlineHostEnabled: isCoreCanvasHostEnabled(resolvedConfig),
            inlineClientAvailable: options?.clientCaps?.includes("inline-widgets") === true,
            presenters: widgetPresentation.presenters,
            presenterContext: widgetPresentation.context,
          }),
        ]),
    ...collectPresentOpenClawTools([heartbeatTool]),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: resolvedConfig,
      agentId: sessionAgentId,
      agentAccountId: options?.agentAccountId,
    }),
    ...(options?.githubPublicationAvailable !== undefined
      ? [createGitHubIdentityStatusTool()]
      : []),
    ...(options?.githubPublicationAvailable === true ? [createGitHubPublishTool()] : []),
    ...collectPresentOpenClawTools([transcriptsTool]),
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
            modelContextWindowTokens: options?.modelContextWindowTokens,
          }),
        ]),
    ...collectPresentOpenClawTools([progressCardTool]),
    ...swarmToolGroups.structuredOutput,
    ...(shouldIncludeAskUserToolForOpenClawTools({
      config: resolvedConfig,
      agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
      pluginToolDenylist: options?.pluginToolDenylist,
    })
      ? [
          createAskUserTool({
            agentId: sessionAgentId,
            sessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            runId: options?.runId,
          }),
        ]
      : []),
    ...(shouldIncludeSecretsToolForOpenClawTools({
      config: resolvedConfig,
      agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
      pluginToolDenylist: options?.pluginToolDenylist,
    })
      ? [
          createSecretsTool({
            agentId: sessionAgentId,
            sessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            runId: options?.runId,
          }),
        ]
      : []),
    createSessionsListTool({
      ...sessionLookupToolOptions,
      requesterAgentIdOverride: sessionAgentId,
    }),
    createSessionsHistoryTool({
      ...sessionLookupToolOptions,
      requesterAgentIdOverride: sessionAgentId,
    }),
    createSessionsSearchTool({ ...sessionLookupToolOptions, agentId: sessionAgentId }),
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
          // Keep the in-process caller so materialized agent roots retain their creation stamp.
          createSessionsSendTool({
            agentId: sessionAgentId,
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            sandboxed: options?.sandboxed,
            config: sessionConfig,
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
            sessionPermissionPolicy: options?.sessionPermissionPolicy,
            inheritedToolAllowlist: options?.inheritedToolAllowlist,
            inheritedToolDenylist: options?.inheritedToolDenylist,
          }),
        ]
      : []),
    ...swarmToolGroups.agentsWait,
    createSessionsYieldTool({
      sessionId: options?.sessionId,
      claimYield: createRequesterYieldCallback({
        requesterSessionKey: trimmedRunSessionKey || options?.agentSessionKey,
        requesterAgentId: sessionAgentId,
        requesterTurnRunId: options?.runId,
        claimYieldCompletion: options?.claimYieldCompletion,
      }),
      onYield: options?.onYield,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
      agentId: sessionAgentId,
      config: sessionConfig,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: sessionAgentId,
      runSessionKey: options?.runSessionKey,
      config: sessionConfig,
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
    allTools = [
      ...tools,
      ...resolveOpenClawPluginToolsForOptions({
        options: { ...options, activeProjectKeys },
        resolvedConfig,
        existingToolNames: new Set(tools.map((tool) => tool.name)),
      }),
    ];
    options?.recordToolPrepStage?.("openclaw-tools:plugin-tools");
  }

  allTools = filterToolsByClientCaps(allTools, options?.clientCaps);
  options?.recordToolPrepStage?.("openclaw-tools:client-capabilities");
  for (const tool of allTools) {
    bindAssembledAgentToolActionDescriptor(tool);
  }

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
