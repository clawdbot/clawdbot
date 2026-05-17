import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import { selectApplicableRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import {
  getActiveRuntimeWebToolsMetadata,
  getActiveSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "./agent-scope.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import {
  isToolExplicitlyAllowedByFactoryPolicy,
  mergeFactoryPolicyList,
  resolveImageToolFactoryAvailable,
  resolveOptionalMediaToolFactoryPlan,
} from "./openclaw-tools.media-factory-plan.js";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.nodes-workspace-guard.js";
import {
  collectPresentOpenClawTools,
  isUpdatePlanToolEnabledForOpenClawTools,
} from "./openclaw-tools.registration.js";
import {
  type HookContext,
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createEmbeddedCallGateway } from "./tools/embedded-gateway-stub.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createHeartbeatResponseTool } from "./tools/heartbeat-response-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createMusicGenerateTool } from "./tools/music-generate-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";
import { createVideoGenerateTool } from "./tools/video-generate-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

type OpenClawToolsDeps = {
  callGateway: typeof callGateway;
  config?: OpenClawConfig;
};

const defaultOpenClawToolsDeps: OpenClawToolsDeps = {
  callGateway,
};

let openClawToolsDeps: OpenClawToolsDeps = defaultOpenClawToolsDeps;

export function createOpenClawTools(
  options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    /**
     * The actual live run session key. When the tool is constructed with a sandbox/policy
     * session key, this allows `session_status({sessionKey:"current"})` to resolve to
     * the live run session instead of the stale sandbox key.
     */
    runSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    /** Delivery target for topic/thread routing. */
    agentTo?: string;
    /** Thread/topic identifier for routing replies to the originating thread. */
    agentThreadId?: string | number;
    agentDir?: string;
    sandboxRoot?: string;
    sandboxContainerWorkdir?: string;
    sandboxFsBridge?: SandboxFsBridge;
    fsPolicy?: ToolFsPolicy;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    pluginToolAllowlist?: string[];
    pluginToolDenylist?: string[];
    /** Current channel ID for auto-threading. */
    currentChannelId?: string;
    /** Current thread timestamp for auto-threading. */
    currentThreadTs?: string;
    /** Current inbound message id for action fallbacks. */
    currentMessageId?: string | number;
    /** Reply-to mode for auto-threading. */
    replyToMode?: "off" | "first" | "all" | "batched";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: { value: boolean };
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** Active model provider for provider-specific tool gating. */
    modelProvider?: string;
    /** Active model id for provider/model-specific tool gating. */
    modelId?: string;
    /** If true, nodes action="invoke" can call media-returning commands directly. */
    allowMediaInvokeCommands?: boolean;
    /** Explicit agent ID override for cron/hook sessions. */
    requesterAgentIdOverride?: string;
    /** Restrict the cron tool to self-removing this active cron job. */
    cronSelfRemoveOnlyJobId?: string;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** Visible source replies must be sent through the message tool when set to message_tool_only. */
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    inboundEventKind?: InboundEventKind;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
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
    /** Auth profiles already loaded for this run; used for prompt-time tool availability. */
    authProfileStore?: AuthProfileStore;
    /** Whether the requesting sender is an owner. */
    senderIsOwner?: boolean;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /**
     * Workspace directory to pass to spawned subagents for inheritance.
     * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
     * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
     * subagents inherit the real workspace path instead of the sandbox copy.
     */
    spawnWorkspaceDir?: string;
    /** Callback invoked when sessions_yield tool is called. */
    onYield?: (message: string) => Promise<void> | void;
    /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
    allowGatewaySubagentBinding?: boolean;
  } & SpawnedToolContext,
): AnyAgentTool[] {
  const resolvedConfig = options?.config ?? openClawToolsDeps.config;
  const runtimeSnapshot = getActiveSecretsRuntimeSnapshot();
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
        agentDir: imageToolAgentDir!,
        authProfileStore: options?.authProfileStore,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
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
        agentSessionKey: options?.agentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      })
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:image-generate-tool");
  const videoGenerateTool = optionalMediaTools.videoGenerate
    ? createVideoGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        authProfileStore: options?.authProfileStore,
        agentSessionKey: options?.agentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      })
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:video-generate-tool");
  const musicGenerateTool = optionalMediaTools.musicGenerate
    ? createMusicGenerateTool({
        config: options?.config,
        agentDir: options?.agentDir,
        authProfileStore: options?.authProfileStore,
        agentSessionKey: options?.agentSessionKey,
        requesterOrigin: deliveryContext ?? undefined,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      })
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:music-generate-tool");
  const pdfTool =
    optionalMediaTools.pdf && options?.agentDir?.trim()
      ? createPdfTool({
          config: options?.config,
          agentDir: options.agentDir,
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
        agentId: sessionAgentId,
        sessionId: options?.sessionId,
        config: options?.config,
        currentChannelId: options?.currentChannelId,
        currentChannelProvider: options?.agentChannel,
        currentThreadTs: options?.currentThreadTs,
        agentThreadId: options?.agentThreadId,
        currentMessageId: options?.currentMessageId,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sandboxRoot: options?.sandboxRoot,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
        inboundEventKind: options?.inboundEventKind,
        requesterSenderId: options?.requesterSenderId ?? undefined,
        senderIsOwner: options?.senderIsOwner,
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
  const effectiveCallGateway = embedded
    ? createEmbeddedCallGateway()
    : openClawToolsDeps.callGateway;
  const includeUpdatePlanTool =
    isToolExplicitlyAllowedByFactoryPolicy({
      toolName: "update_plan",
      allowlist: explicitFactoryAllowlist,
      denylist: explicitFactoryDenylist,
    }) ||
    isUpdatePlanToolEnabledForOpenClawTools({
      config: resolvedConfig,
      agentSessionKey: options?.agentSessionKey,
      agentId: options?.requesterAgentIdOverride,
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
    });
  const tools: AnyAgentTool[] = [
    ...(embedded
      ? []
      : [
          nodesTool,
          createCronTool({
            agentSessionKey: options?.agentSessionKey,
            currentDeliveryContext: {
              channel: options?.agentChannel,
              to: options?.currentChannelId ?? options?.agentTo,
              accountId: options?.agentAccountId,
              threadId: options?.currentThreadTs ?? options?.agentThreadId,
            },
            ...(options?.cronSelfRemoveOnlyJobId
              ? { selfRemoveOnlyJobId: options.cronSelfRemoveOnlyJobId }
              : {}),
          }),
        ]),
    ...(messageTool && includeMessageTool ? [messageTool] : []),
    ...collectPresentOpenClawTools([heartbeatTool]),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: resolvedConfig,
      agentId: sessionAgentId,
      agentAccountId: options?.agentAccountId,
    }),
    ...collectPresentOpenClawTools([imageGenerateTool, musicGenerateTool, videoGenerateTool]),
    ...(embedded
      ? []
      : [
          createGatewayTool({
            agentSessionKey: options?.agentSessionKey,
            config: options?.config,
          }),
        ]),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    ...(includeUpdatePlanTool ? [createUpdatePlanTool()] : []),
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
    ...(embedded
      ? []
      : [
          createSessionsSendTool({
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
            callGateway: openClawToolsDeps.callGateway,
          }),
          createSessionsSpawnTool({
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            agentAccountId: options?.agentAccountId,
            agentTo: options?.agentTo,
            agentThreadId: options?.agentThreadId,
            agentGroupId: options?.agentGroupId,
            agentGroupChannel: options?.agentGroupChannel,
            agentGroupSpace: options?.agentGroupSpace,
            agentMemberRoleIds: options?.agentMemberRoleIds,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
            requesterAgentIdOverride: options?.requesterAgentIdOverride,
            workspaceDir: spawnWorkspaceDir,
            inheritedToolAllowlist: options?.inheritedToolAllowlist,
            inheritedToolDenylist: options?.inheritedToolDenylist,
          }),
        ]),
    createSessionsYieldTool({
      sessionId: options?.sessionId,
      onYield: options?.onYield,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      runSessionKey: options?.runSessionKey,
      config: resolvedConfig,
      sandboxed: options?.sandboxed,
      activeModelProvider: options?.modelProvider,
      activeModelId: options?.modelId,
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
        options,
        resolvedConfig,
        existingToolNames,
      }),
    ];
    options?.recordToolPrepStage?.("openclaw-tools:plugin-tools");
  }

  if (options?.wrapBeforeToolCallHook === false) {
    return allTools;
  }
  const hookAgentId = options?.requesterAgentIdOverride ?? sessionAgentId;
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
  return allTools.map((tool) =>
    isToolWrappedWithBeforeToolCallHook(tool)
      ? tool
      : wrapToolWithBeforeToolCallHook(tool, hookContext),
  );
}

export const __testing = {
  resolveOptionalMediaToolFactoryPlan,
  setDepsForTest(overrides?: Partial<OpenClawToolsDeps>) {
    openClawToolsDeps = overrides
      ? {
          ...defaultOpenClawToolsDeps,
          ...overrides,
        }
      : defaultOpenClawToolsDeps;
  },
};
