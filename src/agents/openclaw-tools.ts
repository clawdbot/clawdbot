/** Builds the per-run built-in and plugin tool inventory. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { createShowWidgetTool } from "../canvas/widget-tool.js";
import { selectApplicableRuntimeConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { resolveTranscriptsConfig } from "../transcripts/config.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "./agent-scope.js";
import {
  type HookContext,
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { createOpenClawContinuationTools } from "./openclaw-tools.continuation.js";
import {
  isToolExplicitlyAllowedByFactoryPolicy,
  mergeFactoryPolicyList,
  resolveImageToolFactoryAvailable,
  resolveOptionalMediaToolFactoryPlan,
} from "./openclaw-tools.media-factory-plan.js";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.nodes-workspace-guard.js";
import type { CreateOpenClawToolsOptions } from "./openclaw-tools.options.js";
import {
  collectPresentOpenClawTools,
  shouldIncludeAskUserToolForOpenClawTools,
  shouldIncludeUpdatePlanToolForOpenClawTools,
} from "./openclaw-tools.registration.js";
import { createOpenClawSwarmToolGroups } from "./openclaw-tools.swarm.js";
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
import {
  createCreateGoalTool,
  createGetGoalTool,
  createUpdateGoalTool,
} from "./tools/goal-tools.js";
import { createHeartbeatResponseTool } from "./tools/heartbeat-response-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createMobileUiTool } from "./tools/mobile-ui-tool.js";
import { createMusicGenerateTool } from "./tools/music-generate-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createOpenClawDelegateToolsForRun } from "./tools/openclaw-delegate-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
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
/**
 * Drops tools whose requiredClientCaps the originating gateway client did not
 * declare. Capability availability is a hard fact, not policy: every tool
 * assembly path (core, plugin-only plans) must apply it or gated tools leak
 * onto surfaces that cannot render them.
 */
export function filterToolsByClientCaps(
  tools: AnyAgentTool[],
  declaredClientCaps: string[] | undefined,
): AnyAgentTool[] {
  const clientCaps = new Set(declaredClientCaps ?? []);
  return tools.filter(
    (tool) => !tool.requiredClientCaps?.some((requiredCap) => !clientCaps.has(requiredCap)),
  );
}
export function createOpenClawTools(options?: CreateOpenClawToolsOptions): AnyAgentTool[] {
  const resolvedConfig = options?.config;
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
  const effectiveRequesterAgentId = sessionAgentId;
  const swarmToolGroups = createOpenClawSwarmToolGroups({
    config: resolvedConfig,
    effectiveRequesterAgentId,
    agentSessionKey: options?.agentSessionKey,
    runSessionKey: options?.runSessionKey,
    runId: options?.runId,
    swarmCollector: options?.swarmCollector,
    swarmOutputSchema: options?.swarmOutputSchema,
  });
  // Fall back to the session agent workspace so plugin loading stays workspace-stable
  // even when a caller forgets to thread workspaceDir explicitly.
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
  const spawnWorkspaceDir = resolveWorkspaceRoot(
    options?.spawnWorkspaceDir ?? options?.workspaceDir ?? inferredWorkspaceDir,
  );
  const runtimeCwd = resolveWorkspaceRoot(
    options?.cwd ?? options?.workspaceDir ?? inferredWorkspaceDir,
  );
  options?.recordToolPrepStage?.("openclaw-tools:session-workspace");
  const deliveryContext = normalizeDeliveryContext({
    channel: options?.agentChannel,
    to: options?.agentTo,
    accountId: options?.agentAccountId,
    threadId: options?.agentThreadId,
  });
  const runtimeWebTools = getActiveRuntimeWebToolsMetadata();
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
  });
  const trimmedRunSessionKey = options?.runSessionKey?.trim();
  const mediaGenerationAgentSessionKey =
    trimmedRunSessionKey && isCronRunSessionKey(trimmedRunSessionKey)
      ? trimmedRunSessionKey
      : options?.agentSessionKey;
  const mediaGenerationAsyncStartCallback = mediaGenerationAgentSessionKey
    ? isCronRunSessionKey(mediaGenerationAgentSessionKey)
      ? undefined
      : options?.onYield
    : options?.onYield;
  const taskSuggestionSessionKey = normalizeOptionalString(
    options?.runSessionKey ?? options?.agentSessionKey,
  );
  const requesterSessionKey = options?.agentSessionKey;
  const requesterTurnRunId = options?.runId;
  const imageToolAgentDir = options?.agentDir;
  const imageTool = resolveImageToolFactoryAvailable({
    config: availabilityConfig ?? resolvedConfig,
    agentDir: imageToolAgentDir,
    workspaceDir,
    modelHasVision: options?.modelHasVision,
    authStore: options?.authProfileStore,
  })
    ? createImageTool({
        config: availabilityConfig ?? options?.config,
        agentId: sessionAgentId,
        agentDir: imageToolAgentDir!,
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
  const imageGenerateTool = optionalMediaTools.imageGenerate
    ? createImageGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        authProfileStore: options?.authProfileStore,
        agentSessionKey: mediaGenerationAgentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
        onAsyncTaskStarted: mediaGenerationAsyncStartCallback,
      })
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:image-generate-tool");
  const videoGenerateTool = optionalMediaTools.videoGenerate
    ? createVideoGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        authProfileStore: options?.authProfileStore,
        agentSessionKey: mediaGenerationAgentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
        onAsyncTaskStarted: mediaGenerationAsyncStartCallback,
      })
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:video-generate-tool");
  const musicGenerateTool = optionalMediaTools.musicGenerate
    ? createMusicGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        authProfileStore: options?.authProfileStore,
        agentSessionKey: mediaGenerationAgentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
        onAsyncTaskStarted: mediaGenerationAsyncStartCallback,
      })
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
        runId: options?.runId,
        agentId: sessionAgentId,
        sessionId: options?.sessionId,
        messageActionTurnCapability: options?.messageActionTurnCapability,
        config: options?.config,
        currentChannelId: options?.currentChannelId,
        currentChatType: options?.currentChatType,
        currentMessagingTarget: options?.currentMessagingTarget,
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
        inboundEventKind: options?.inboundEventKind,
        requesterSenderId: options?.requesterSenderId ?? undefined,
        senderIsOwner: options?.senderIsOwner,
        conversationReadOrigin: options?.conversationReadOrigin,
      });
  const heartbeatTool = options?.enableHeartbeatTool ? createHeartbeatResponseTool() : null;
  options?.recordToolPrepStage?.("openclaw-tools:message-tool");
  const nodesToolBase = createNodesTool({
    agentSessionKey: options?.agentSessionKey,
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
  const messageExplicitlyAllowed = isToolExplicitlyAllowedByFactoryPolicy({
    toolName: "message",
    allowlist: explicitFactoryAllowlist,
    denylist: explicitFactoryDenylist,
  });
  const includeMessageTool =
    !embedded ||
    options?.sourceReplyDeliveryMode === "message_tool_only" ||
    messageExplicitlyAllowed;
  const includeSubagentSpawnTool = !embedded || options?.allowGatewaySubagentBinding === true;
  const effectiveCallGateway = embedded ? createEmbeddedCallGateway() : callGateway;
  const includeUpdatePlanTool = shouldIncludeUpdatePlanToolForOpenClawTools({
    config: resolvedConfig,
    agentSessionKey: options?.agentSessionKey,
    agentId: options?.requesterAgentIdOverride,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
    pluginToolAllowlist: options?.pluginToolAllowlist,
    pluginToolDenylist: options?.pluginToolDenylist,
  });
  // isEmbeddedMode() marks the TUI-embedded host, not the embedded agent runner;
  // gating on it would hide ask_user from every normal gateway run.
  const includeAskUserTool = shouldIncludeAskUserToolForOpenClawTools({
    config: resolvedConfig,
    agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
    pluginToolDenylist: options?.pluginToolDenylist,
  });
  const includeTranscriptsTool = resolveTranscriptsConfig(resolvedConfig?.transcripts).enabled;
  const tools: AnyAgentTool[] = [
    createDashboardTool({
      agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
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
                  // Run ids survive attempt/session reconstruction but do not
                  // span later assistant runs that may reuse a provider call id.
                  idempotencyScope: options?.runId,
                  contextEpoch: options?.computerContextEpoch,
                }),
              ]),
          createCronTool({
            agentSessionKey: options?.agentSessionKey,
            currentDeliveryContext: {
              channel: options?.agentChannel,
              to: options?.currentChannelId ?? options?.agentTo,
              accountId: options?.agentAccountId,
              threadId: options?.currentThreadTs ?? options?.agentThreadId,
            },
            creatorToolAllowlist: options?.cronCreatorToolAllowlist,
            runId: options?.runId,
            ...(options?.cronSelfRemoveOnlyJobId
              ? { selfRemoveOnlyJobId: options.cronSelfRemoveOnlyJobId }
              : {}),
          }),
          createSessionsTool({
            agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
          }),
          createScreenTool({
            agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
          }),
          ...(options?.sandboxed
            ? []
            : [
                createTerminalTool({
                  agentId: sessionAgentId,
                  agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
                }),
              ]),
        ]),
    ...(!embedded && taskSuggestionSessionKey && options?.taskSuggestionDeliveryMode === "gateway"
      ? createTaskSuggestionTools({
          sessionKey: taskSuggestionSessionKey,
          agentId: sessionAgentId,
          cwd: runtimeCwd,
        })
      : []),
    ...(messageTool && includeMessageTool ? [messageTool] : []),
    // Discord sessions get the Discord plugin's own show_widget (Activities
    // delivery); registering the core tool there would collide on the name.
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
    ...(includeTranscriptsTool ? [createTranscriptsTool({ config: resolvedConfig })] : []),
    ...collectPresentOpenClawTools([imageGenerateTool, musicGenerateTool, videoGenerateTool]),
    ...(embedded
      ? []
      : [
          createGatewayTool(),
          ...createOpenClawDelegateToolsForRun({ ...options, sessionAgentId }),
        ]),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
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
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: effectiveCallGateway,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
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
          createSessionsSendTool({
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
            callGateway,
          }),
        ]),
    ...(includeSubagentSpawnTool
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
            requesterAgentIdOverride: effectiveRequesterAgentId,
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
      onBeforeYield:
        requesterSessionKey && requesterTurnRunId
          ? async () => {
              const { markRequesterTurnYielded } = await import("./subagent-registry.js");
              markRequesterTurnYielded({ requesterSessionKey, requesterTurnRunId });
            }
          : undefined,
      onYield: options?.onYield,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
      config: resolvedConfig,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      runSessionKey: options?.runSessionKey,
      config: resolvedConfig,
      sandboxed: options?.sandboxed,
      activeModelProvider: options?.modelProvider,
      activeModelId: options?.modelId,
      activeDeliveryContext: {
        channel: options?.agentChannel,
        to: options?.currentChannelId ?? options?.agentTo,
        accountId: options?.agentAccountId,
        threadId: options?.currentThreadTs ?? options?.agentThreadId,
      },
    }),
    ...collectPresentOpenClawTools([webSearchTool, webFetchTool, imageTool, pdfTool]),
    ...createOpenClawContinuationTools({
      config: resolvedConfig,
      agentSessionKey: options?.agentSessionKey,
      runSessionKey: options?.runSessionKey,
      sessionId: options?.sessionId,
      runId: options?.runId,
      drainsContinuationDelegateQueue: options?.drainsContinuationDelegateQueue,
      disableContinuationTools: options?.disableContinuationTools,
      continueWorkOpts: options?.continueWorkOpts,
      requestCompactionOpts: options?.requestCompactionOpts,
    }),
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
        options,
        resolvedConfig,
        existingToolNames,
      }),
    ];
    options?.recordToolPrepStage?.("openclaw-tools:plugin-tools");
  }

  allTools = filterToolsByClientCaps(allTools, options?.clientCaps);
  options?.recordToolPrepStage?.("openclaw-tools:client-capabilities");

  const hookAgentId = options?.requesterAgentIdOverride ?? sessionAgentId;
  const wrapGatewayCallerIdentity = createGatewayToolCallerWrapper(hookAgentId, options);

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
  const hookContext = {
    ...defaultHookContext,
    ...options?.beforeToolCallHookContext,
  };
  options?.recordToolPrepStage?.("openclaw-tools:tool-hooks");
  return allTools
    .map((tool) =>
      isToolWrappedWithBeforeToolCallHook(tool)
        ? tool
        : wrapToolWithBeforeToolCallHook(tool, hookContext),
    )
    .map(wrapGatewayCallerIdentity);
}
