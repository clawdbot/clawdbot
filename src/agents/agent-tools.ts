/**
 * Builds the effective OpenClaw agent tool surface.
 * Assembles core, shell, channel, OpenClaw, plugin, and Tool Search tools, then
 * applies sandbox, profile, provider, sender, group, and sub-agent policy.
 */
import path from "node:path";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../auto-reply/heartbeat-tool-response.js";
import type { ChatType } from "../channels/chat-type.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { resolveEventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import { applyExecPolicyLayer } from "../infra/exec-policy.js";
import { logWarn } from "../logger.js";
import type {
  PluginHookChannelContext,
  PluginHookToolRequesterContext,
} from "../plugins/hook-types.js";
import { appendRuntimePluginToolGrant } from "../plugins/tool-grant-allowlist.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../security/dangerous-tools.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { SkillSnapshot, SkillUsagePath } from "../skills/types.js";
import type { SkillWorkshopRunOptions } from "../skills/workshop/types.js";
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  type ToolOutcomeObserver,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { applyDeferredFollowupToolDescriptions } from "./agent-tools.deferred-followup.js";
import { filterToolsByMessageProvider } from "./agent-tools.message-provider-policy.js";
import {
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  createOpenClawReadTool,
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  wrapReadToolWithSkillContent,
  wrapToolMemoryFlushAppendOnlyWrite,
  wrapToolWorkspaceRootGuard,
  wrapToolWorkspaceRootGuardWithOptions,
} from "./agent-tools.read.js";
import {
  getActiveAgentRingZeroTools,
  mergeAgentRingZeroTools,
} from "./agent-tools.ring-zero-context.js";
import { normalizeToolParameters } from "./agent-tools.schema.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { isApplyPatchAllowedForModel } from "./apply-patch-model-policy.js";
import { createApplyPatchTool } from "./apply-patch.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { describeProcessTool } from "./bash-tools.descriptions.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import type { ProcessToolDefaults } from "./bash-tools.process.js";
import { processSchema } from "./bash-tools.schemas.js";
import { listChannelAgentTools } from "./channel-tools.js";
import { shouldSuppressManagedWebSearchTool } from "./codex-native-web-search.js";
import {
  resolveConversationCapabilityProfile,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import type { ConversationRecallContext } from "./conversation-recall.types.js";
import {
  buildConversationToolPolicyPipelineSteps,
  resolveConversationToolPolicies,
} from "./conversation-tool-policy-pipeline.js";
import type { OpenClawCodingToolConstructionPlan } from "./core-tool-factory-descriptors.js";
import { applyDelegationCapability, type DelegationCapability } from "./delegation-capability.js";
import { resolveImageSanitizationLimits } from "./image-sanitization.js";
import { createLazyExecTool, resolveExecToolConfig } from "./lazy-exec-tool.js";
import {
  filterLocalModelLeanTools,
  resolveLocalModelLeanPreserveToolNames,
} from "./local-model-lean.js";
import type { ModelAuthMode } from "./model-auth.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { createOpenClawTools, filterToolsByClientCaps } from "./openclaw-tools.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import type { SandboxContext } from "./sandbox.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./sandbox/constants.js";
import { resolveReadOnlyWorkspaceSkillMounts } from "./sandbox/workspace-mounts.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import { createCodingTools, createReadTool } from "./sessions/index.js";
import { PROCESS_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import { createToolFsPolicy, resolveToolFsConfig } from "./tool-fs-policy.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";
import { buildDeclaredToolAllowlistContext } from "./tool-policy-declared-context.js";
import { isToolAllowedByPolicies } from "./tool-policy-match.js";
import { applyToolPolicyPipeline } from "./tool-policy-pipeline.js";
import {
  expandToolGroups,
  hasRestrictiveAllowPolicy,
  normalizeToolName,
  replaceWithEffectiveToolAllowlist,
} from "./tool-policy.js";
import {
  createToolSearchTools,
  resolveToolSearchConfig,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "./tool-search.js";
import {
  replaceWithEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
} from "./tools/cron-tool.js";
import { wrapToolWithGatewayCallerIdentity } from "./tools/gateway-caller-context.js";

const MEMORY_FLUSH_ALLOWED_TOOL_NAMES = new Set(["read", "write"]);

type GuardContainerMount = {
  containerRoot: string;
  hostRoot: string;
};

function readOnlySandboxReadMounts(
  sandbox: SandboxContext | null | undefined,
): GuardContainerMount[] | undefined {
  if (!sandbox) {
    return undefined;
  }
  const mounts: GuardContainerMount[] = [];
  if (sandbox.workspaceAccess === "ro" && sandbox.agentWorkspaceDir !== sandbox.workspaceDir) {
    mounts.push({
      containerRoot: SANDBOX_AGENT_WORKSPACE_MOUNT,
      hostRoot: sandbox.agentWorkspaceDir,
    });
  }
  if (sandbox.workspaceAccess === "rw") {
    mounts.push(
      ...resolveReadOnlyWorkspaceSkillMounts({
        workspaceDir: sandbox.workspaceDir,
        agentWorkspaceDir: sandbox.agentWorkspaceDir,
        skillsWorkspaceDir: sandbox.skillsWorkspaceDir,
        workdir: sandbox.containerWorkdir,
        workspaceAccess: sandbox.workspaceAccess,
      }).map((mount) => ({
        containerRoot: mount.containerPath,
        hostRoot: mount.hostPath,
      })),
    );
  }
  return mounts.length > 0 ? mounts : undefined;
}

function resolveSkillReadRoots(skillsSnapshot?: SkillSnapshot): string[] | undefined {
  const roots = new Set<string>();
  for (const skill of skillsSnapshot?.resolvedSkills ?? []) {
    const baseDir = typeof skill.baseDir === "string" ? skill.baseDir.trim() : "";
    const filePath = typeof skill.filePath === "string" ? skill.filePath.trim() : "";
    const root = baseDir || (filePath ? path.dirname(filePath) : "");
    if (!root || !path.isAbsolute(root)) {
      continue;
    }
    roots.add(path.resolve(root));
  }
  if (roots.size === 0) {
    return undefined;
  }
  return Array.from(roots);
}

type BashToolsModule = typeof import("./bash-tools.js");

const bashToolsModuleLoader = createLazyImportLoader<BashToolsModule>(
  () => import("./bash-tools.js"),
);

function loadBashToolsModule(): Promise<BashToolsModule> {
  return bashToolsModuleLoader.load();
}

function createLazyProcessTool(defaults?: ProcessToolDefaults): AnyAgentTool {
  let loadedTool: AnyAgentTool | undefined;
  const loadTool = async () => {
    if (!loadedTool) {
      const { createProcessTool } = await loadBashToolsModule();
      loadedTool = createProcessTool(defaults) as unknown as AnyAgentTool;
    }
    return loadedTool;
  };

  return {
    name: "process",
    label: "process",
    displaySummary: PROCESS_TOOL_DISPLAY_SUMMARY,
    description: describeProcessTool({ hasCronTool: defaults?.hasCronTool === true }),
    parameters: processSchema,
    execute: async (...args: Parameters<AnyAgentTool["execute"]>) =>
      (await loadTool()).execute(...args),
  } as AnyAgentTool;
}

/** Resolve the process-tool isolation key for exec/process session state. */
export function resolveProcessToolScopeKey(params: {
  scopeKey?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): string | undefined {
  const explicitScopeKey = params.scopeKey?.trim();
  if (explicitScopeKey) {
    return explicitScopeKey;
  }
  const sessionKey = params.sessionKey?.trim();
  if (sessionKey) {
    return sessionKey;
  }
  const sessionId = params.sessionId?.trim();
  if (sessionId) {
    return sessionId;
  }
  const agentId = params.agentId?.trim();
  return agentId ? `agent:${agentId}` : undefined;
}

function applyModelProviderToolPolicy(
  toolsInput: AnyAgentTool[],
  params?: {
    config?: OpenClawConfig;
    modelProvider?: string;
    modelApi?: string;
    modelId?: string;
    agentId?: string;
    sessionKey?: string;
    agentDir?: string;
    modelCompat?: ModelCompatConfig;
    suppressManagedWebSearch?: boolean;
    runtimeToolAllowlist?: string[];
    localModelLeanPreserveToolNames?: string[];
  },
): AnyAgentTool[] {
  let tools = toolsInput;
  tools = filterLocalModelLeanTools({
    tools,
    config: params?.config,
    agentId: params?.agentId,
    sessionKey: params?.sessionKey,
    preserveToolNames: params?.localModelLeanPreserveToolNames ?? params?.runtimeToolAllowlist,
  });

  if (
    params?.suppressManagedWebSearch !== false &&
    shouldSuppressManagedWebSearchTool({
      config: params?.config,
      modelProvider: params?.modelProvider,
      modelApi: params?.modelApi,
      modelId: params?.modelId,
      agentId: params?.agentId,
      sessionKey: params?.sessionKey,
      agentDir: params?.agentDir,
    })
  ) {
    return tools.filter((tool) => tool.name !== "web_search");
  }

  return tools;
}

export { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";

/** Public options for building one plugin-owned agent tool surface. */
type OpenClawCodingToolsOptions = {
  agentId?: string;
  exec?: ExecToolDefaults & ProcessToolDefaults;
  messageProvider?: string;
  /** Canonical transport channel when tool-policy provider differs from delivery channel. */
  messageChannel?: string;
  /** Capabilities declared by the gateway client that originated this run. */
  clientCaps?: string[];
  /** Out-of-band plugin bindings attached by the run initiator. */
  toolBindings?: Readonly<Record<string, unknown>>;
  /** Trusted runtime-only authorization for one bounded cross-conversation recall pass. */
  conversationRecall?: ConversationRecallContext;
  /** Normalized conversation kind when the caller already has channel metadata. */
  chatType?: ChatType;
  /** Specific ingress provider used only for transport tool availability. */
  toolPolicyMessageProvider?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  /** Trusted platform-native conversation id for the active inbound turn. */
  nativeChannelId?: string;
  /** Opaque host-issued capability for current-turn channel message actions. */
  messageActionTurnCapability?: string;
  sandbox?: SandboxContext | null;
  sessionKey?: string;
  /**
   * The actual live run session key. When the tool set is constructed with a
   * sandbox/policy session key, this allows `session_status({sessionKey:"current"})`
   * to resolve to the live run session instead of the stale sandbox key.
   */
  runSessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  /**
   * Explicit one-shot local CLI runs should not keep plugin-owned process
   * resources alive after emitting their result.
   */
  oneShotCliRun?: boolean;
  /** Stable run identifier for this agent invocation. */
  runId?: string;
  /** Device-scoped operator session allowed to review approvals initiated by this run. */
  approvalReviewerDeviceId?: string;
  /** Diagnostic trace context for hook/log correlation during this run. */
  trace?: DiagnosticTraceContext;
  /** What initiated this run (for trigger-specific tool restrictions). */
  trigger?: string;
  /** Stable cron job identifier populated for cron-triggered runs. */
  jobId?: string;
  /** Relative workspace path that memory-triggered writes may append to. */
  memoryFlushWritePath?: string;
  agentDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  /** Task working directory for coding tools. Defaults to workspaceDir. */
  cwd?: string;
  workspaceDir?: string;
  /**
   * Workspace directory that spawned subagents should inherit.
   * When sandboxing uses a copied workspace (`ro` or `none`), workspaceDir is the
   * sandbox copy but subagents should inherit the real agent workspace instead.
   * Defaults to workspaceDir when not set.
   */
  spawnWorkspaceDir?: string;
  config?: OpenClawConfig;
  abortSignal?: AbortSignal;
  /** Disable hook-owned diagnostics when an outer runtime owns tool diagnostics. */
  emitBeforeToolCallDiagnostics?: boolean;
  /** Skip hook wrapping when an outer tool-call boundary owns hook execution. */
  wrapBeforeToolCallHook?: boolean;
  /**
   * Provider of the currently selected model (used for provider-specific tool quirks).
   * Example: "anthropic", "openai", "google", "openai".
   */
  modelProvider?: string;
  /** Model id for the current provider (used for model-specific tool gating). */
  modelId?: string;
  /** Internal review-run restrictions and proposal provenance. */
  skillWorkshop?: SkillWorkshopRunOptions;
  /** Attempt-local authority to start or redirect delegated work. */
  delegationCapability?: DelegationCapability;
  /** Model API for the current provider (used for provider-native tool arbitration). */
  modelApi?: string;
  /** Model context window in tokens (used to scale read-tool output budget). */
  modelContextWindowTokens?: number;
  /** Resolved runtime model compatibility hints. */
  modelCompat?: ModelCompatConfig;
  /** If false, keep OpenClaw web_search even when a provider-native search tool is active. */
  suppressManagedWebSearch?: boolean;
  /**
   * Auth mode for the current provider. We only need this for Anthropic OAuth
   * tool-name blocking quirks.
   */
  modelAuthMode?: ModelAuthMode;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Routable target for the current conversation when it differs from the native channel ID. */
  currentMessagingTarget?: string;
  /** Normalized conversation id exposed to tool hooks. Defaults to currentChannelId. */
  hookChannelId?: string;
  /** Channel-owned sender/chat metadata exposed to subprocess environments. */
  channelContext?: PluginHookChannelContext;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Current inbound message id for action fallbacks (e.g. Telegram react). */
  currentMessageId?: string | number;
  /** True when the current inbound turn carried audio media. */
  currentInboundAudio?: boolean;
  /** Dynamic audio state for runs that can accept steered input after tool creation. */
  hasCurrentInboundAudio?: () => boolean;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Trusted provider role ids for the requester in this group turn. */
  memberRoleIds?: string[];
  /** Parent session key for subagent group policy inheritance. */
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** Allow plugin tools for this run to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
  /** Runtime-scoped explicit allowlist used to materialize matching plugin tools. */
  runtimeToolAllowlist?: string[];
  /** True when runtimeToolAllowlist is real parent authority that child sessions inherit. */
  inheritRuntimeToolAllowlist?: boolean;
  /** Mutable cron creator cap ref for callers that append final runtime tools later. */
  cronCreatorToolAllowlistRef?: CronCreatorToolAllowlistEntry[];
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /** Mutable model-context generation used to expire screenshot coordinate frames. */
  computerContextEpoch?: { value: number };
  /** Require explicit message targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
  /** Visible source replies must be sent through the message tool when set to message_tool_only. */
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** Action sink available for model-proposed follow-up tasks. */
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  inboundEventKind?: InboundEventKind;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
  /** Collector runs never open operator approval flows. */
  swarmCollector?: boolean;
  /** Synthetic structured_output schema for collector runs. */
  swarmOutputSchema?: Record<string, unknown>;
  /** Keep the message tool available even when the selected profile omits it. */
  forceMessageTool?: boolean;
  /** Include the heartbeat response tool for structured heartbeat outcomes. */
  enableHeartbeatTool?: boolean;
  /** Keep the heartbeat response tool available even when the selected profile omits it. */
  forceHeartbeatTool?: boolean;
  /** If false, build plugin tools only while preserving the shared policy pipeline. */
  includeCoreTools?: boolean;
  /** Include Tool Search control tools when enabled for this run. */
  includeToolSearchControls?: boolean;
  /** Executes cataloged tools through the active agent run lifecycle. */
  toolSearchCatalogExecutor?: ToolSearchCatalogToolExecutor;
  /** Runtime-local Tool Search catalog ref shared with attempt compaction. */
  toolSearchCatalogRef?: ToolSearchCatalogRef;
  /** Limits which tool families are materialized before the shared policy pipeline runs. */
  toolConstructionPlan?: OpenClawCodingToolConstructionPlan;
  /** Ring-zero OpenClaw tool; set only by the OpenClaw agent runner. */
  systemAgentTool?: import("./tools/system-agent-tool.js").SystemAgentToolOptions;
  /** Trusted sender identity bit for command/channel-action auth and owner-gated plugin tools. */
  senderIsOwner?: boolean;
  /** Auth profiles already loaded for this run; used for prompt-time tool availability. */
  authProfileStore?: AuthProfileStore;
  /** Callback invoked when sessions_yield tool is called. */
  onYield?: (message: string) => Promise<void> | void;
  /** Optional instrumentation callback for tool preparation stage timing. */
  recordToolPrepStage?: (name: string) => void;
  /** Lower routine policy-removal audits for diagnostic-only tool probes. */
  toolPolicyAuditLogLevel?: "info" | "debug";
  /** Live observer called after wrapped tool outcomes are recorded. */
  onToolOutcome?: ToolOutcomeObserver;
  /** Supplies run-global model-call ordering for parallel tool outcomes. */
  allocateToolOutcomeOrdinal?: (toolCallId?: string) => number;
  /** Runtime-only resolved skill paths that the read tool may load under workspaceOnly. */
  skillsSnapshot?: SkillSnapshot;
  /** Original identities for sandbox-materialized skill instruction paths. */
  skillUsagePaths?: SkillUsagePath[];
  /** Prepared conversation-scoped facts for callers that already resolved this run context. */
  conversationCapabilityProfile?: ResolvedConversationCapabilityProfile;
  inputProvenance?: InputProvenance;
  /** Trusted in-process completion handoff; never derived from model-facing input. */
  trustedInternalHandoff?: boolean;
  /** Trusted server-stamped authority for an explicitly capped scheduled run. */
  scheduledToolPolicy?: ScheduledToolPolicyContext;
};

function createOpenClawCodingToolsInternal(options?: OpenClawCodingToolsOptions): AnyAgentTool[] {
  const execToolName = "exec";
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
  const isMemoryFlushRun = options?.trigger === "memory";
  if (isMemoryFlushRun && !options?.memoryFlushWritePath) {
    throw new Error("memoryFlushWritePath required for memory-triggered tool runs");
  }
  const memoryFlushWritePath = isMemoryFlushRun ? options.memoryFlushWritePath : undefined;
  const cronSelfRemoveOnlyJobId =
    options?.trigger === "cron" && options.jobId?.trim() ? options.jobId.trim() : undefined;
  // Prefer the already-resolved sandbox context policy. Recomputing from
  // sessionKey/config can lose the real sandbox agent when callers pass a
  // legacy alias like `main` instead of an agent session key.
  const sandboxToolPolicy = sandbox?.tools;
  const capabilityProfile =
    options?.conversationCapabilityProfile ??
    resolveConversationCapabilityProfile({
      config: options?.config,
      sessionKey: options?.sessionKey,
      runSessionKey: options?.runSessionKey,
      sessionId: options?.sessionId,
      runId: options?.runId,
      agentId: options?.agentId,
      agentDir: options?.agentDir,
      agentAccountId: options?.agentAccountId,
      messageProvider: options?.messageProvider,
      messageChannel: options?.messageChannel,
      chatType: options?.chatType,
      messageTo: options?.messageTo,
      messageThreadId: options?.messageThreadId,
      currentChannelId: options?.currentChannelId,
      currentMessagingTarget: options?.currentMessagingTarget,
      currentThreadTs: options?.currentThreadTs,
      currentMessageId: options?.currentMessageId,
      groupId: options?.groupId,
      groupChannel: options?.groupChannel,
      groupSpace: options?.groupSpace,
      memberRoleIds: options?.memberRoleIds,
      spawnedBy: options?.spawnedBy,
      senderId: options?.senderId,
      senderName: options?.senderName,
      senderUsername: options?.senderUsername,
      senderE164: options?.senderE164,
      senderIsOwner: options?.senderIsOwner,
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      modelApi: options?.modelApi,
      modelContextWindowTokens: options?.modelContextWindowTokens,
      modelHasVision: options?.modelHasVision,
      workspaceDir: options?.workspaceDir,
      cwd: options?.cwd,
      spawnWorkspaceDir: options?.spawnWorkspaceDir,
      skillsSnapshot: options?.skillsSnapshot,
      sandboxToolPolicy,
      runtimeToolAllowlist: options?.runtimeToolAllowlist,
      inheritRuntimeToolAllowlist: options?.inheritRuntimeToolAllowlist,
      inputProvenance: options?.inputProvenance,
      trustedInternalHandoff: options?.trustedInternalHandoff,
      scheduledToolPolicy: options?.scheduledToolPolicy,
    });
  const { agentId, runtimePluginToolGrant } = capabilityProfile.policy;

  const enableHeartbeatTool =
    options?.enableHeartbeatTool === true ||
    (options?.trigger === "heartbeat" &&
      options?.config?.messages?.visibleReplies === "message_tool");
  const forceHeartbeatTool = options?.forceHeartbeatTool === true || enableHeartbeatTool;
  const toolSearchConfig = resolveToolSearchConfig(options?.config);
  const toolSearchControlsEnabled =
    options?.includeToolSearchControls === true && toolSearchConfig.enabled;
  const toolSearchControlAllowlist = toolSearchControlsEnabled
    ? [
        TOOL_SEARCH_CODE_MODE_TOOL_NAME,
        TOOL_SEARCH_RAW_TOOL_NAME,
        TOOL_DESCRIBE_RAW_TOOL_NAME,
        TOOL_CALL_RAW_TOOL_NAME,
      ]
    : [];
  const runtimeToolAllowlistIncludesMessage = expandToolGroups(
    options?.runtimeToolAllowlist ?? [],
  ).some((toolName) => {
    const normalized = normalizeToolName(toolName);
    return normalized === "*" || normalized === "message";
  });
  const localModelLeanPreserveToolNames = resolveLocalModelLeanPreserveToolNames({
    toolNames: capabilityProfile.policy.explicitToolOverrideAllowlist,
    forceMessageTool: options?.forceMessageTool,
    sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
  });
  const runtimeProfileAlsoAllow = [
    ...(options?.forceMessageTool || options?.sourceReplyDeliveryMode === "message_tool_only"
      ? ["message"]
      : []),
    ...(runtimeToolAllowlistIncludesMessage ? ["message"] : []),
    ...(forceHeartbeatTool ? [HEARTBEAT_RESPONSE_TOOL_NAME] : []),
    ...toolSearchControlAllowlist,
  ];
  const conversationToolPolicies = resolveConversationToolPolicies({
    capabilityProfile,
    additionalProfileAllow: runtimeProfileAlsoAllow,
    additionalPolicyAllow: toolSearchControlAllowlist,
  });
  // Prefer sessionKey for process isolation scope to prevent cross-session process visibility/killing.
  // Fallback to agentId if no sessionKey is available (e.g. legacy or global contexts).
  const scopeKey = resolveProcessToolScopeKey({
    scopeKey: options?.exec?.scopeKey,
    sessionKey: options?.sessionKey,
    sessionId: options?.sessionId,
    agentId,
  });
  const allowBackground = isToolAllowedByPolicies("process", [
    conversationToolPolicies.profilePolicy,
    conversationToolPolicies.providerProfilePolicy,
    conversationToolPolicies.globalPolicy,
    conversationToolPolicies.globalProviderPolicy,
    conversationToolPolicies.agentPolicy,
    conversationToolPolicies.agentProviderPolicy,
    conversationToolPolicies.groupPolicy,
    conversationToolPolicies.senderPolicy,
    conversationToolPolicies.sandboxPolicy,
    conversationToolPolicies.subagentPolicy,
    conversationToolPolicies.inheritedToolPolicy,
  ]);
  options?.recordToolPrepStage?.("tool-policy");
  const execConfig = resolveExecToolConfig({ cfg: options?.config, agentId });
  const fsConfig = resolveToolFsConfig({ cfg: options?.config, agentId });
  const fsPolicy = createToolFsPolicy({
    workspaceOnly: isMemoryFlushRun || fsConfig.workspaceOnly,
  });
  const sandboxRoot = sandbox?.workspaceDir;
  const sandboxFsBridge = sandbox?.fsBridge;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  const workspaceRoot = capabilityProfile.workspace.workspaceRoot;
  const runtimeRoot = capabilityProfile.workspace.runtimeRoot;
  const codingRoot = sandboxRoot ?? runtimeRoot;
  const memoryFlushWriteRoot = sandboxRoot ?? workspaceRoot;
  const includeCoreTools = options?.includeCoreTools !== false;
  const toolConstructionPlan = options?.toolConstructionPlan ?? {
    includeBaseCodingTools: includeCoreTools,
    includeShellTools: includeCoreTools,
    includeChannelTools: includeCoreTools,
    includeOpenClawTools: includeCoreTools,
    includePluginTools: true,
  };
  const includeBaseCodingTools = includeCoreTools && toolConstructionPlan.includeBaseCodingTools;
  const includeShellTools = includeCoreTools && toolConstructionPlan.includeShellTools;
  const includeOpenClawTools = includeCoreTools && toolConstructionPlan.includeOpenClawTools;
  const includeChannelTools = toolConstructionPlan.includeChannelTools;
  const includePluginTools = toolConstructionPlan.includePluginTools;
  const workspaceOnly = fsPolicy.workspaceOnly;
  const skillReadRoots = sandboxRoot ? undefined : resolveSkillReadRoots(options?.skillsSnapshot);
  const applyPatchConfig = execConfig.applyPatch;
  // Secure by default: apply_patch is workspace-contained unless explicitly disabled.
  // (tools.fs.workspaceOnly is a separate umbrella flag for read/write/edit/apply_patch.)
  const applyPatchWorkspaceOnly = workspaceOnly || applyPatchConfig?.workspaceOnly !== false;
  const applyPatchEnabled =
    applyPatchConfig?.enabled !== false &&
    isApplyPatchAllowedForModel({
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      allowModels: applyPatchConfig?.allowModels,
    });

  if (sandboxRoot && !sandboxFsBridge) {
    throw new Error("Sandbox filesystem bridge is unavailable.");
  }
  const imageSanitization = resolveImageSanitizationLimits(options?.config);
  options?.recordToolPrepStage?.("workspace-policy");

  const base: AnyAgentTool[] = [];
  if (includeBaseCodingTools) {
    for (const tool of createCodingTools(codingRoot) as unknown as AnyAgentTool[]) {
      if (tool.name === "read") {
        if (sandboxRoot) {
          const sandboxed = createSandboxedReadTool({
            root: sandboxRoot,
            bridge: sandboxFsBridge!,
            modelContextWindowTokens: options?.modelContextWindowTokens,
            imageSanitization,
          });
          const guarded = workspaceOnly
            ? wrapToolWorkspaceRootGuardWithOptions(sandboxed, sandboxRoot, {
                additionalContainerMounts: readOnlySandboxReadMounts(sandbox),
                containerWorkdir: sandbox.containerWorkdir,
              })
            : sandboxed;
          base.push(
            wrapReadToolWithSkillContent(guarded, options?.skillsSnapshot?.resolvedSkills, {
              modelContextWindowTokens: options?.modelContextWindowTokens,
              imageSanitization,
            }),
          );
          continue;
        }
        const freshReadTool = createReadTool(codingRoot);
        const wrapped = createOpenClawReadTool(freshReadTool, {
          modelContextWindowTokens: options?.modelContextWindowTokens,
          imageSanitization,
        });
        const guarded = workspaceOnly
          ? wrapToolWorkspaceRootGuardWithOptions(wrapped, codingRoot, {
              additionalRoots: skillReadRoots,
            })
          : wrapped;
        base.push(
          wrapReadToolWithSkillContent(guarded, options?.skillsSnapshot?.resolvedSkills, {
            modelContextWindowTokens: options?.modelContextWindowTokens,
            imageSanitization,
          }),
        );
        continue;
      }
      if (tool.name === "bash" || tool.name === execToolName) {
        continue;
      }
      if (tool.name === "write") {
        if (sandboxRoot) {
          continue;
        }
        const wrapped = createHostWorkspaceWriteTool(codingRoot, { workspaceOnly });
        base.push(workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, codingRoot) : wrapped);
        continue;
      }
      if (tool.name === "edit") {
        if (sandboxRoot) {
          continue;
        }
        const wrapped = createHostWorkspaceEditTool(codingRoot, { workspaceOnly });
        base.push(workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, codingRoot) : wrapped);
        continue;
      }
      base.push(tool);
    }
  }
  options?.recordToolPrepStage?.("base-coding-tools");
  const { cleanupMs: cleanupMsOverride, ...execDefaults } = options?.exec ?? {};
  const effectiveExecPolicy = applyExecPolicyLayer(execConfig, options?.exec);
  const execTool = includeShellTools
    ? createLazyExecTool({
        ...execDefaults,
        host: options?.exec?.host ?? execConfig.host,
        mode: effectiveExecPolicy.mode,
        security: effectiveExecPolicy.security,
        ask: effectiveExecPolicy.ask,
        config: options?.exec?.config ?? options?.config,
        reviewer: options?.exec?.reviewer ?? execConfig.reviewer,
        trigger: options?.trigger,
        node: options?.exec?.node ?? execConfig.node,
        pathPrepend: options?.exec?.pathPrepend ?? execConfig.pathPrepend,
        safeBins: options?.exec?.safeBins ?? execConfig.safeBins,
        strictInlineEval: options?.exec?.strictInlineEval ?? execConfig.strictInlineEval,
        commandHighlighting: options?.exec?.commandHighlighting ?? execConfig.commandHighlighting,
        safeBinTrustedDirs: options?.exec?.safeBinTrustedDirs ?? execConfig.safeBinTrustedDirs,
        safeBinProfiles: options?.exec?.safeBinProfiles ?? execConfig.safeBinProfiles,
        agentId,
        cwd: codingRoot,
        allowBackground,
        scopeKey,
        sessionKey: options?.sessionKey,
        runId: options?.runId,
        // Detached completions return to the live session, not the sandbox policy scope.
        notifySessionKey: options?.runSessionKey ?? options?.sessionKey,
        sessionId: options?.sessionId,
        sessionStore: options?.config?.session?.store,
        mainKey: options?.config?.session?.mainKey,
        sessionScope: options?.config?.session?.scope,
        eventRouting: resolveEventSessionRoutingPolicy({
          cfg: options?.config,
          sessionKey: options?.runSessionKey ?? options?.sessionKey,
          channel: options?.messageProvider,
          accountId: options?.agentAccountId,
        }),
        messageProvider: options?.messageProvider,
        currentChannelId: options?.currentChannelId,
        currentThreadTs: options?.currentThreadTs,
        channelContext: options?.channelContext,
        accountId: options?.agentAccountId,
        approvalReviewerDeviceId: options?.approvalReviewerDeviceId,
        nonInteractiveApproval: options?.swarmCollector,
        backgroundMs: options?.exec?.backgroundMs ?? execConfig.backgroundMs,
        timeoutSec: options?.exec?.timeoutSec ?? execConfig.timeoutSec,
        approvalRunningNoticeMs:
          options?.exec?.approvalRunningNoticeMs ?? execConfig.approvalRunningNoticeMs,
        notifyOnExit: options?.exec?.notifyOnExit ?? execConfig.notifyOnExit,
        notifyOnExitEmptySuccess:
          options?.exec?.notifyOnExitEmptySuccess ?? execConfig.notifyOnExitEmptySuccess,
        sandbox: sandbox
          ? {
              containerName: sandbox.containerName,
              workspaceDir: sandbox.workspaceDir,
              containerWorkdir: sandbox.containerWorkdir,
              workdirValidation: sandbox.backend?.workdirValidation,
              validateWorkdir: sandbox.backend?.validateWorkdir?.bind(sandbox.backend),
              discardPreparedWorkdir: sandbox.backend?.discardPreparedWorkdir?.bind(
                sandbox.backend,
              ),
              workdirRoots: sandbox.backend?.workdirRoots,
              env: sandbox.backend?.env ?? sandbox.docker.env,
              buildExecSpec: sandbox.backend?.buildExecSpec.bind(sandbox.backend),
              finalizeExec: sandbox.backend?.finalizeExec?.bind(sandbox.backend),
            }
          : undefined,
      })
    : null;
  const processTool = includeShellTools
    ? createLazyProcessTool({
        cleanupMs: cleanupMsOverride ?? execConfig.cleanupMs,
        scopeKey,
      })
    : null;
  const applyPatchTool =
    !includeShellTools || !applyPatchEnabled || (sandboxRoot && !allowWorkspaceWrites)
      ? null
      : createApplyPatchTool({
          cwd: codingRoot,
          sandbox:
            sandboxRoot && allowWorkspaceWrites
              ? { root: sandboxRoot, bridge: sandboxFsBridge! }
              : undefined,
          workspaceOnly: applyPatchWorkspaceOnly,
        });
  options?.recordToolPrepStage?.("shell-tools");
  const ownerOnlyCoreToolDenylist =
    options?.senderIsOwner === false ? [...GATEWAY_OWNER_ONLY_CORE_TOOLS] : [];
  const ownerOnlyCoreToolPolicy =
    ownerOnlyCoreToolDenylist.length > 0 ? { deny: ownerOnlyCoreToolDenylist } : undefined;
  const pluginToolAllowlist = appendRuntimePluginToolGrant(
    capabilityProfile.policy.explicitToolAllowlist,
    runtimePluginToolGrant,
  );
  const pluginToolDenylist = [
    ...capabilityProfile.policy.explicitToolDenylist,
    ...ownerOnlyCoreToolDenylist,
  ];
  const inheritedToolDenylist = [...pluginToolDenylist];
  // Passed by reference to sessions_spawn and populated after the final policy
  // pass so child sessions inherit the actual parent tool surface.
  const inheritedToolAllowlist: string[] = [];
  const toolPolicyInheritanceSources = capabilityProfile.policy.inheritancePolicies;
  const shouldInheritEffectiveToolAllowlist =
    toolPolicyInheritanceSources.some(hasRestrictiveAllowPolicy);
  const cronCreatorToolAllowlist = options?.cronCreatorToolAllowlistRef ?? [];
  const gatewayCallerAccountId =
    options?.scheduledToolPolicy?.ownerAccountId ?? options?.agentAccountId;
  // Plugin-only plans bypass createOpenClawTools, so the capability gate must
  // apply here too or narrow allowlists leak gated tools onto capless surfaces.
  const pluginToolCallerIdentity =
    agentId && options?.sessionKey?.trim()
      ? {
          agentId,
          sessionKey: options.sessionKey.trim(),
          turnSourceChannel: resolveGatewayMessageChannel(
            options.messageChannel ?? options.messageProvider,
          ),
          turnSourceTo:
            options.currentMessagingTarget ?? options.currentChannelId ?? options.messageTo,
          turnSourceAccountId: gatewayCallerAccountId,
          turnSourceThreadId: options.currentThreadTs ?? options.messageThreadId,
        }
      : undefined;
  const pluginToolsOnly = filterToolsByClientCaps(
    includeOpenClawTools || !includePluginTools
      ? []
      : resolveOpenClawPluginToolsForOptions({
          options: {
            agentSessionKey: options?.sessionKey,
            agentChannel: resolveGatewayMessageChannel(
              options?.messageChannel ?? options?.messageProvider,
            ),
            agentAccountId: options?.agentAccountId,
            agentTo: options?.messageTo,
            agentThreadId: options?.messageThreadId,
            nativeChannelId: options?.nativeChannelId,
            agentDir: options?.agentDir,
            workspaceDir: workspaceRoot,
            config: options?.config,
            fsPolicy,
            requesterSenderId: options?.senderId,
            senderIsOwner: options?.senderIsOwner,
            sessionId: options?.sessionId,
            conversationRecall: options?.conversationRecall,
            oneShotCliRun: options?.oneShotCliRun,
            sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
            allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
            sandboxed: Boolean(sandbox),
            pluginToolAllowlist,
            pluginToolDenylist,
            currentChannelId: options?.currentChannelId,
            currentMessagingTarget: options?.currentMessagingTarget,
            currentThreadTs: options?.currentThreadTs,
            currentMessageId: options?.currentMessageId,
            modelProvider: options?.modelProvider,
            modelId: options?.modelId,
            modelHasVision: options?.modelHasVision,
            requireExplicitMessageTarget: options?.requireExplicitMessageTarget,
            disableMessageTool: options?.disableMessageTool || options?.swarmCollector,
            requesterAgentIdOverride: agentId,
            allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
            clientCaps: options?.clientCaps,
            toolBindings: options?.toolBindings,
            authProfileStore: options?.authProfileStore,
          },
          resolvedConfig: options?.config,
        }),
    options?.clientCaps,
  ).map((tool) => wrapToolWithGatewayCallerIdentity(tool, pluginToolCallerIdentity));
  const ringZeroTools = includeOpenClawTools ? getActiveAgentRingZeroTools() : [];
  const toolSearchTools =
    toolSearchControlsEnabled && ringZeroTools.length === 0
      ? createToolSearchTools({
          config: options?.config,
          runtimeConfig: options?.config,
          agentId,
          sessionKey: options?.sessionKey,
          sessionId: options?.sessionId,
          runId: options?.runId,
          catalogRef: options?.toolSearchCatalogRef,
          abortSignal: options?.abortSignal,
          executeTool: options?.toolSearchCatalogExecutor,
        })
      : [];
  const tools: AnyAgentTool[] = [
    ...base,
    ...(includeBaseCodingTools && sandboxRoot
      ? allowWorkspaceWrites
        ? [
            workspaceOnly
              ? wrapToolWorkspaceRootGuardWithOptions(
                  createSandboxedEditTool({ root: sandboxRoot, bridge: sandboxFsBridge! }),
                  sandboxRoot,
                  {
                    containerWorkdir: sandbox.containerWorkdir,
                  },
                )
              : createSandboxedEditTool({ root: sandboxRoot, bridge: sandboxFsBridge! }),
            workspaceOnly
              ? wrapToolWorkspaceRootGuardWithOptions(
                  createSandboxedWriteTool({ root: sandboxRoot, bridge: sandboxFsBridge! }),
                  sandboxRoot,
                  {
                    containerWorkdir: sandbox.containerWorkdir,
                  },
                )
              : createSandboxedWriteTool({ root: sandboxRoot, bridge: sandboxFsBridge! }),
          ]
        : []
      : []),
    ...(includeShellTools && applyPatchTool ? [applyPatchTool as unknown as AnyAgentTool] : []),
    ...(execTool ? [execTool as unknown as AnyAgentTool] : []),
    ...(processTool ? [processTool as unknown as AnyAgentTool] : []),
    // Channel docking: include channel-defined agent tools (login, etc.).
    ...(includeChannelTools ? listChannelAgentTools({ cfg: options?.config }) : []),
    ...(includeOpenClawTools
      ? mergeAgentRingZeroTools(
          ringZeroTools,
          createOpenClawTools({
            ...(options?.systemAgentTool ? { systemAgentTool: options.systemAgentTool } : {}),
            sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
            allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
            agentSessionKey: options?.sessionKey,
            runId: options?.runId,
            runSessionKey: options?.runSessionKey,
            agentChannel: resolveGatewayMessageChannel(
              options?.messageChannel ?? options?.messageProvider,
            ),
            agentAccountId: options?.agentAccountId,
            gatewayCallerAccountId,
            agentTo: options?.messageTo,
            agentThreadId: options?.messageThreadId,
            nativeChannelId: options?.nativeChannelId,
            messageActionTurnCapability: options?.messageActionTurnCapability,
            agentGroupId: options?.groupId ?? null,
            agentGroupChannel: options?.groupChannel ?? null,
            agentGroupSpace: options?.groupSpace ?? null,
            agentMemberRoleIds: options?.memberRoleIds,
            agentDir: options?.agentDir,
            preparedModelRuntime: options?.preparedModelRuntime,
            sandboxRoot,
            sandboxContainerWorkdir: sandbox?.containerWorkdir,
            sandboxFsBridge,
            fsPolicy,
            workspaceDir: workspaceRoot,
            spawnWorkspaceDir: capabilityProfile.workspace.spawnWorkspaceRoot,
            // Sandboxes execute against copied roots, but accepted suggestions create host
            // worktrees. Unsandboxed task-repo sessions must stay on their runtime cwd.
            cwd: sandbox
              ? (capabilityProfile.workspace.spawnWorkspaceRoot ?? runtimeRoot)
              : runtimeRoot,
            sandboxed: Boolean(sandbox),
            config: options?.config,
            clientCaps: options?.clientCaps,
            toolBindings: options?.toolBindings,
            pluginToolAllowlist,
            pluginToolDenylist,
            cronCreatorToolAllowlist,
            currentChannelId: options?.currentChannelId,
            currentChatType: options?.chatType,
            currentMessagingTarget: options?.currentMessagingTarget,
            currentThreadTs: options?.currentThreadTs,
            currentMessageId: options?.currentMessageId,
            currentInboundAudio: options?.currentInboundAudio,
            hasCurrentInboundAudio: options?.hasCurrentInboundAudio,
            modelProvider: options?.modelProvider,
            modelId: options?.modelId,
            skillWorkshop: options?.skillWorkshop,
            replyToMode: options?.replyToMode,
            hasRepliedRef: options?.hasRepliedRef,
            modelHasVision: options?.modelHasVision,
            computerContextEpoch: options?.computerContextEpoch,
            requireExplicitMessageTarget: options?.requireExplicitMessageTarget,
            sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
            taskSuggestionDeliveryMode: options?.taskSuggestionDeliveryMode,
            inboundEventKind: options?.inboundEventKind,
            disableMessageTool: options?.disableMessageTool || options?.swarmCollector,
            swarmCollector: options?.swarmCollector,
            swarmOutputSchema: options?.swarmOutputSchema,
            enableHeartbeatTool,
            disablePluginTools: !includePluginTools,
            wrapBeforeToolCallHook: false,
            ...(cronSelfRemoveOnlyJobId ? { cronSelfRemoveOnlyJobId } : {}),
            requesterAgentIdOverride: agentId,
            requesterSenderId: options?.senderId,
            senderIsOwner: options?.senderIsOwner,
            authProfileStore: options?.authProfileStore,
            sessionId: options?.sessionId,
            conversationRecall: options?.conversationRecall,
            oneShotCliRun: options?.oneShotCliRun,
            inheritedToolAllowlist,
            inheritedToolDenylist,
            onYield: options?.onYield,
            allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
            recordToolPrepStage: options?.recordToolPrepStage,
          }),
        )
      : pluginToolsOnly),
    ...toolSearchTools,
  ];
  options?.recordToolPrepStage?.("openclaw-tools");
  const swarmStructuredOutputTool =
    options?.swarmCollector && options.swarmOutputSchema
      ? tools.find((tool) => tool.name === "structured_output")
      : undefined;
  const toolsForMemoryFlush: AnyAgentTool[] = isMemoryFlushRun && memoryFlushWritePath ? [] : tools;
  if (isMemoryFlushRun && memoryFlushWritePath) {
    for (const tool of tools) {
      if (!MEMORY_FLUSH_ALLOWED_TOOL_NAMES.has(tool.name)) {
        continue;
      }
      if (tool.name === "write") {
        toolsForMemoryFlush.push(
          wrapToolMemoryFlushAppendOnlyWrite(tool, {
            root: memoryFlushWriteRoot,
            relativePath: memoryFlushWritePath,
            containerWorkdir: sandbox?.containerWorkdir,
            sandbox:
              sandboxRoot && sandboxFsBridge
                ? { root: sandboxRoot, bridge: sandboxFsBridge }
                : undefined,
          }),
        );
        continue;
      }
      toolsForMemoryFlush.push(tool);
    }
  }
  const unavailableCoreToolReason =
    isMemoryFlushRun && memoryFlushWritePath
      ? "memory-triggered compaction runs expose only read and append-only write"
      : undefined;
  const toolsForMessageProvider = filterToolsByMessageProvider(
    toolsForMemoryFlush,
    options?.toolPolicyMessageProvider ?? options?.messageProvider,
  );
  options?.recordToolPrepStage?.("message-provider-policy");
  const toolsForModelProvider = applyModelProviderToolPolicy(toolsForMessageProvider, {
    config: options?.config,
    modelProvider: options?.modelProvider,
    modelApi: options?.modelApi,
    modelId: options?.modelId,
    agentId: options?.agentId,
    sessionKey: options?.sessionKey,
    agentDir: options?.agentDir,
    modelCompat: options?.modelCompat,
    suppressManagedWebSearch: options?.suppressManagedWebSearch,
    runtimeToolAllowlist: options?.runtimeToolAllowlist,
    localModelLeanPreserveToolNames,
  });
  options?.recordToolPrepStage?.("model-provider-policy");
  // Sender identity is primarily command/action auth, with one Gateway parity exception:
  // explicit non-owner callers never receive owner-only control-plane core tools.
  const subagentFiltered = applyToolPolicyPipeline({
    tools: toolsForModelProvider,
    toolMeta: (tool) => getPluginToolMeta(tool),
    warn: logWarn,
    steps: buildConversationToolPolicyPipelineSteps({
      capabilityProfile,
      policies: conversationToolPolicies,
      additionalStepsAfterSandbox: [
        {
          policy: ownerOnlyCoreToolPolicy,
          label: "gateway sender owner-only tools",
          unavailableCoreToolReason,
        },
      ],
      includeRuntimeToolPolicy: true,
      unavailableCoreToolReason,
    }),
    auditLogLevel: options?.toolPolicyAuditLogLevel,
    declaredToolAllowlist: buildDeclaredToolAllowlistContext({
      config: options?.config,
      metadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
      workspaceDir: workspaceRoot,
      toolDenylist: pluginToolDenylist,
    }),
  });
  // Host-bound ring-zero tools carry their own authority checks. Agent policy
  // must not deadlock setup, but the tools still receive schema/hook wrappers.
  const authorizedTools = applyDelegationCapability(
    mergeAgentRingZeroTools(ringZeroTools, subagentFiltered),
    options?.delegationCapability,
  ).filter(
    (tool) =>
      !options?.swarmCollector ||
      (tool.name !== "ask_user" && tool.name !== "sessions_send" && tool.name !== "sessions_yield"),
  );
  if (
    swarmStructuredOutputTool &&
    !authorizedTools.some((tool) => tool.name === swarmStructuredOutputTool.name)
  ) {
    // Collector output is a run contract, not an operator-configurable capability.
    authorizedTools.push(swarmStructuredOutputTool);
  }
  if (shouldInheritEffectiveToolAllowlist) {
    // Snapshot exporter only: this copies authorizedTools for descendants and
    // never filters the mandatory structured_output tool from this turn.
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, authorizedTools);
  }
  replaceWithEffectiveCronCreatorToolAllowlist(cronCreatorToolAllowlist, authorizedTools, (tool) =>
    getPluginToolMeta(tool),
  );
  options?.recordToolPrepStage?.("authorization-policy");
  // Always normalize tool JSON Schemas before handing them to OpenClaw model runtime.
  // Without this, some providers (notably OpenAI) will reject root-level union schemas.
  // Provider-specific cleaning: Gemini needs constraint keywords stripped, but Anthropic expects them.
  const normalized = authorizedTools.map((tool) =>
    normalizeToolParameters(tool, {
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      modelCompat: options?.modelCompat,
    }),
  );
  options?.recordToolPrepStage?.("schema-normalization");
  const turnSourceChannel = options?.messageChannel ?? options?.messageProvider;
  const turnSourceTo = options?.currentMessagingTarget ?? options?.currentChannelId;
  const requester = {
    ...(turnSourceChannel ? { channel: turnSourceChannel } : {}),
    ...(options?.agentAccountId ? { accountId: options.agentAccountId } : {}),
    ...(options?.senderId ? { senderId: options.senderId } : {}),
    ...(options?.senderIsOwner !== undefined ? { senderIsOwner: options.senderIsOwner } : {}),
    ...(options?.memberRoleIds?.length ? { roleIds: [...options.memberRoleIds] } : {}),
  } satisfies PluginHookToolRequesterContext;
  const hasRequester = Object.keys(requester).length > 0;
  const hookContext = {
    agentId,
    ...(options?.config ? { config: options.config } : {}),
    cwd: codingRoot,
    workspaceDir: workspaceRoot,
    ...(options?.skillsSnapshot ? { skillsSnapshot: options.skillsSnapshot } : {}),
    ...(options?.skillUsagePaths ? { skillUsagePaths: options.skillUsagePaths } : {}),
    ...(sandboxRoot && allowWorkspaceWrites
      ? { sandbox: { root: sandboxRoot, bridge: sandboxFsBridge! } }
      : {}),
    sessionKey: options?.sessionKey,
    sessionId: options?.sessionId,
    runId: options?.runId,
    approvalReviewerDeviceId: options?.approvalReviewerDeviceId,
    channelId: options?.hookChannelId ?? options?.currentChannelId,
    ...(hasRequester ? { requester } : {}),
    ...(turnSourceChannel ? { turnSourceChannel } : {}),
    ...(turnSourceTo ? { turnSourceTo } : {}),
    ...(options?.agentAccountId ? { turnSourceAccountId: options.agentAccountId } : {}),
    ...(options?.currentThreadTs ? { turnSourceThreadId: options.currentThreadTs } : {}),
    ...(options?.trace ? { trace: options.trace } : {}),
    loopDetection: resolveToolLoopDetectionConfig({ cfg: options?.config, agentId }),
    onToolOutcome: options?.onToolOutcome,
    allocateToolOutcomeOrdinal: options?.allocateToolOutcomeOrdinal,
  };
  const hookOptions = {
    emitDiagnostics: options?.emitBeforeToolCallDiagnostics,
    ...(options?.swarmCollector ? { approvalMode: "deny" as const } : {}),
  };
  // MCP and other outer dispatchers execute hooks at their shared call boundary.
  // Rewrapping here would run plugin authorization and mutation hooks twice.
  const withHooks =
    options?.wrapBeforeToolCallHook === false
      ? normalized
      : normalized.map((tool) =>
          isToolWrappedWithBeforeToolCallHook(tool)
            ? rewrapToolWithBeforeToolCallHook(tool, hookContext, hookOptions)
            : wrapToolWithBeforeToolCallHook(tool, hookContext, hookOptions),
        );
  options?.recordToolPrepStage?.("tool-hooks");
  const withAbort = options?.abortSignal
    ? withHooks.map((tool) => wrapToolWithAbortSignal(tool, options.abortSignal))
    : withHooks;
  options?.recordToolPrepStage?.("abort-wrappers");
  const withDeferredFollowupDescriptions = applyDeferredFollowupToolDescriptions(withAbort, {
    agentId,
  });
  options?.recordToolPrepStage?.("deferred-followup-descriptions");

  // NOTE: Keep canonical (lowercase) tool names here.
  // shared model runtime's Anthropic OAuth transport remaps tool names to Claude Code-style names
  // on the wire and maps them back for tool dispatch.
  return withDeferredFollowupDescriptions;
}

/** Build the runtime tool list exposed through the public agent harness SDK. */
export function createOpenClawCodingTools(options?: OpenClawCodingToolsOptions): AnyAgentTool[] {
  return createOpenClawCodingToolsInternal(options);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
