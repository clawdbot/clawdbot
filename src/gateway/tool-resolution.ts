// Gateway-scoped tool resolution for HTTP and loopback tool surfaces.
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "../agents/agent-scope.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { filterToolsByMessageProvider } from "../agents/agent-tools.message-provider-policy.js";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ExecElevatedDefaults } from "../agents/bash-tools.exec-types.js";
import { nodeExecSchema } from "../agents/bash-tools.schemas.js";
import {
  resolveExecDefaults,
  type ExecPolicyOverrides,
  type ExecSessionDefaults,
} from "../agents/exec-defaults.js";
import { createLazyExecTool, resolveExecToolConfig } from "../agents/lazy-exec-tool.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import { resolveRequesterToolPolicies } from "../agents/requester-tool-policy.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import type { ScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import { buildDeclaredToolAllowlistContext } from "../agents/tool-policy-declared-context.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../agents/tool-policy-pipeline.js";
import {
  collectExplicitAllowlist,
  collectExplicitDenylist,
  hasRestrictiveAllowPolicy,
  mergeAlsoAllowPolicy,
  normalizeToolPolicyName,
  replaceWithEffectiveToolAllowlist,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  replaceWithEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
} from "../agents/tools/cron-tool.js";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { ConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import { logWarn } from "../logger.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../security/dangerous-tools.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";

type GatewayScopedToolSurface = "http" | "loopback";

/** Resolve the tools visible to a gateway caller after agent, channel, and surface policy. */
export function resolveGatewayScopedTools(params: {
  cfg: OpenClawConfig;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  sessionKey: string;
  runtimePolicySessionKey?: string;
  runtimePolicyAgentId?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  workspaceDir?: string;
  cwd?: string;
  modelProvider?: string;
  modelId?: string;
  onYield?: (message: string) => Promise<void> | void;
  messageProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentInboundAudio?: boolean;
  clientCaps?: string[];
  accountId?: string;
  inboundEventKind?: InboundEventKind;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  sourceReplyOnly?: boolean;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  requireExplicitMessageTarget?: boolean;
  agentTo?: string;
  agentThreadId?: string;
  senderIsOwner?: boolean;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  allowGatewaySubagentBinding?: boolean;
  allowMediaInvokeCommands?: boolean;
  surface?: GatewayScopedToolSurface;
  excludeToolNames?: Iterable<string>;
  /** Server-minted coding tools that must be mediated through the loopback surface. */
  mediatedToolNames?: Iterable<string>;
  disablePluginTools?: boolean;
  gatewayRequestedTools?: string[];
  /** Add the CLI-only, node-forced exec tool before applying the shared policy pipeline. */
  includeNodeExecTool?: boolean;
  execSession?: ExecSessionDefaults;
  execOverrides?: ExecPolicyOverrides;
  bashElevated?: ExecElevatedDefaults;
  trigger?: string;
  approvalReviewerDeviceId?: string;
  channelContext?: PluginHookChannelContext;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  spawnedBy?: string;
  scheduledToolPolicy?: ScheduledToolPolicyContext;
}) {
  const runtimePolicySessionKey = params.runtimePolicySessionKey?.trim() || params.sessionKey;
  const sessionAgentId = resolveSessionAgentIds({
    config: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  }).sessionAgentId;
  const hasSeparateRuntimePolicyIdentity = Boolean(
    params.runtimePolicySessionKey?.trim() || params.runtimePolicyAgentId?.trim(),
  );
  const runtimePolicyAgentId = hasSeparateRuntimePolicyIdentity
    ? resolveSessionAgentIds({
        config: params.cfg,
        sessionKey: runtimePolicySessionKey,
        agentId: params.runtimePolicyAgentId,
      }).sessionAgentId
    : sessionAgentId;
  const {
    agentId: resolvedPolicyAgentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    config: params.cfg,
    sessionKey: runtimePolicySessionKey,
    agentId: runtimePolicyAgentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const policyAgentId = resolvedPolicyAgentId ?? runtimePolicyAgentId;
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const surface = params.surface ?? "http";
  const nodeExecSurface = surface === "loopback" && params.includeNodeExecTool === true;
  const gatewayRequestedTools = params.gatewayRequestedTools ?? [];
  const messageProvider = params.messageProvider?.trim().toLowerCase();
  const sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined =
    params.sourceReplyDeliveryMode ??
    (params.inboundEventKind === "room_event" && messageProvider !== "webchat"
      ? "message_tool_only"
      : undefined);
  const runtimeAlsoAllow = sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [];
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, [
    ...(profileAlsoAllow ?? []),
    ...gatewayRequestedTools,
    ...runtimeAlsoAllow,
  ]);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(providerProfilePolicy, [
    ...(providerProfileAlsoAllow ?? []),
    ...gatewayRequestedTools,
    ...runtimeAlsoAllow,
  ]);
  const senderId = params.channelContext?.sender?.id;
  // Only immutable Gateway-launched grants can opt into node exec. Match the
  // embedded runner's wildcard sender policy while preserving owner WebChat.
  const isOwnerInternalSession =
    nodeExecSurface &&
    params.senderIsOwner === true &&
    normalizeMessageChannel(params.messageProvider) === INTERNAL_MESSAGE_CHANNEL;
  const requesterPolicies = resolveRequesterToolPolicies({
    config: params.cfg,
    sessionKey: runtimePolicySessionKey,
    subagentSessionKey: runtimePolicySessionKey,
    agentId: policyAgentId,
    spawnedBy: params.spawnedBy,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.scheduledToolPolicy?.ownerAccountId ?? params.accountId ?? null,
    senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderPolicyMode: params.scheduledToolPolicy
      ? "never"
      : nodeExecSurface
        ? isOwnerInternalSession
          ? "never"
          : "always"
        : "when-sender-id",
    groupPolicySessionKey: params.scheduledToolPolicy?.ownerSessionKey,
    requireConfiguredGroupAccount: params.scheduledToolPolicy?.mode === "account",
  });
  const { groupPolicy, senderPolicy, subagentPolicy, inheritedToolPolicy } = requesterPolicies;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: sessionAgentId,
    classificationSessionKey: runtimePolicySessionKey,
    classificationAgentId: policyAgentId,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  const excludedToolNames = params.excludeToolNames ? Array.from(params.excludeToolNames) : [];
  const mediatedToolNames = new Set(
    Array.from(params.mediatedToolNames ?? [], (name) => normalizeToolPolicyName(name)).filter(
      Boolean,
    ),
  );
  const gatewayToolsCfg = params.cfg.gateway?.tools;
  const defaultGatewayDeny =
    surface === "http"
      ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter(
          // Config allow entries may use legacy tool names (e.g. "cron");
          // normalize both sides so they still lift the matching default deny.
          (name) =>
            !gatewayToolsCfg?.allow?.some(
              (allowed) => normalizeToolPolicyName(allowed) === normalizeToolPolicyName(name),
            ),
        )
      : [];
  const ownerOnlyGatewayDeny =
    params.senderIsOwner === false || (surface === "http" && params.senderIsOwner !== true)
      ? [...GATEWAY_OWNER_ONLY_CORE_TOOLS]
      : [];
  // HTTP callers start with additional surface denies because they cross auth only.
  const workspaceDir =
    params.workspaceDir?.trim() || resolveAgentWorkspaceDir(params.cfg, sessionAgentId);
  const explicitDenylist = collectExplicitDenylist([
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    senderPolicy,
    sandboxPolicy,
    subagentPolicy,
    inheritedToolPolicy,
    defaultGatewayDeny.length > 0 ? { deny: defaultGatewayDeny } : undefined,
    ownerOnlyGatewayDeny.length > 0 ? { deny: ownerOnlyGatewayDeny } : undefined,
    Array.isArray(gatewayToolsCfg?.deny) ? { deny: gatewayToolsCfg.deny } : undefined,
  ]);
  const inheritedToolDenylist = [...explicitDenylist];
  // Passed by reference to sessions_spawn and populated after the final policy
  // pass so child sessions inherit the actual parent tool surface.
  const inheritedToolAllowlist: string[] = [];
  const cronCreatorToolAllowlist: CronCreatorToolAllowlistEntry[] = [];
  const shouldInheritEffectiveToolAllowlist = [
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    senderPolicy,
    sandboxPolicy,
    subagentPolicy,
    inheritedToolPolicy,
    gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : undefined,
  ].some(hasRestrictiveAllowPolicy);

  const openClawTools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    runId: params.runId,
    requesterAgentIdOverride: sessionAgentId,
    agentChannel: params.messageProvider ?? undefined,
    agentAccountId: params.accountId,
    inboundEventKind: params.inboundEventKind,
    sourceReplyDeliveryMode,
    sourceReplyOnly: params.sourceReplyOnly,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    agentTo: params.agentTo,
    agentThreadId: params.agentThreadId,
    currentChannelId: params.currentChannelId ?? params.agentTo,
    currentThreadTs: params.currentThreadTs ?? params.agentThreadId,
    currentMessageId: params.currentMessageId,
    currentInboundAudio: params.currentInboundAudio,
    sessionId: params.sessionId,
    onYield: params.onYield,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    senderIsOwner: params.senderIsOwner,
    conversationReadOrigin: params.conversationReadOrigin,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    allowMediaInvokeCommands: params.allowMediaInvokeCommands,
    disablePluginTools: params.disablePluginTools,
    wrapBeforeToolCallHook: false,
    config: params.cfg,
    agentDir: params.agentDir,
    authProfileStore: params.authProfileStore,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    clientCaps: params.clientCaps,
    workspaceDir,
    sandboxed: sandboxRuntime.sandboxed,
    pluginToolAllowlist: collectExplicitAllowlist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      senderPolicy,
      sandboxPolicy,
      subagentPolicy,
      inheritedToolPolicy,
      gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : undefined,
    ]),
    pluginToolDenylist: explicitDenylist,
    cronCreatorToolAllowlist,
    inheritedToolAllowlist,
    inheritedToolDenylist,
  });
  const execDefaults =
    nodeExecSurface || mediatedToolNames.size > 0
      ? resolveExecDefaults({
          cfg: params.cfg,
          sessionEntry: params.execSession,
          execOverrides: params.execOverrides,
          agentId: policyAgentId,
          sessionKey: runtimePolicySessionKey,
          sandboxAvailable: sandboxRuntime.sandboxed,
        })
      : undefined;
  const nodeExecDefaults =
    nodeExecSurface && execDefaults?.canRequestNode === true ? execDefaults : undefined;
  const includeNodeExecTool = nodeExecDefaults !== undefined;
  const execConfig = includeNodeExecTool
    ? resolveExecToolConfig({ cfg: params.cfg, agentId: policyAgentId })
    : undefined;
  const includeMediatedBaseCodingTools = ["read", "write", "edit"].some((name) =>
    mediatedToolNames.has(name),
  );
  const includeMediatedShellTools = ["apply_patch", "exec", "process"].some((name) =>
    mediatedToolNames.has(name),
  );
  const mediatedCodingTools =
    surface === "loopback" && (includeMediatedBaseCodingTools || includeMediatedShellTools)
      ? createOpenClawCodingTools({
          config: params.cfg,
          agentId: policyAgentId,
          sessionKey: runtimePolicySessionKey,
          runSessionKey: params.sessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          workspaceDir,
          cwd: params.cwd?.trim() || workspaceDir,
          modelProvider: params.modelProvider,
          modelId: params.modelId,
          messageProvider: params.messageProvider,
          messageChannel: params.messageProvider,
          clientCaps: params.clientCaps,
          agentAccountId: params.accountId,
          currentChannelId: params.currentChannelId,
          currentThreadTs: params.currentThreadTs,
          currentMessageId: params.currentMessageId,
          currentInboundAudio: params.currentInboundAudio,
          channelContext: params.channelContext,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          senderId: params.channelContext?.sender?.id,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
          senderIsOwner: params.senderIsOwner,
          trigger: params.trigger,
          approvalReviewerDeviceId: params.approvalReviewerDeviceId,
          sourceReplyDeliveryMode,
          taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
          inboundEventKind: params.inboundEventKind,
          requireExplicitMessageTarget: params.requireExplicitMessageTarget,
          runtimeToolAllowlist: [...mediatedToolNames],
          exec: execDefaults
            ? {
                host: execDefaults.host,
                mode: execDefaults.mode,
                security: execDefaults.security,
                ask: execDefaults.ask,
                node: execDefaults.node,
                elevated: params.bashElevated,
              }
            : undefined,
          scheduledToolPolicy: params.scheduledToolPolicy,
          toolConstructionPlan: {
            includeBaseCodingTools: includeMediatedBaseCodingTools,
            includeShellTools: includeMediatedShellTools,
            includeChannelTools: false,
            includeOpenClawTools: false,
            includePluginTools: false,
          },
          // The MCP dispatcher is the shared hook and abort boundary for these tools.
          wrapBeforeToolCallHook: false,
          toolPolicyAuditLogLevel: "debug",
        })
      : [];
  // CLI backends already own their local shell. This extra surface is deliberately
  // fixed to node so it cannot become a second path to Gateway-local execution.
  const baseTools = nodeExecSurface
    ? openClawTools.filter((tool) => tool.name.trim().toLowerCase() !== "exec")
    : openClawTools;
  const toolsWithMediatedCoding = [
    // Once a name is server-minted as mediated, only the canonical coding
    // factory may supply it. A policy-filtered tool must not fall back to a
    // coincidentally named Gateway/plugin implementation.
    ...baseTools.filter((tool) => !mediatedToolNames.has(normalizeToolPolicyName(tool.name))),
    ...mediatedCodingTools,
  ];
  const allTools = nodeExecDefaults
    ? [
        ...toolsWithMediatedCoding,
        createLazyExecTool(
          {
            host: "node",
            mode: nodeExecDefaults.mode,
            security: nodeExecDefaults.security,
            ask: nodeExecDefaults.ask,
            trigger: params.trigger,
            node: nodeExecDefaults.node,
            pathPrepend: execConfig?.pathPrepend,
            safeBins: execConfig?.safeBins,
            strictInlineEval: execConfig?.strictInlineEval,
            commandHighlighting: execConfig?.commandHighlighting,
            safeBinTrustedDirs: execConfig?.safeBinTrustedDirs,
            safeBinProfiles: execConfig?.safeBinProfiles,
            reviewer: execConfig?.reviewer,
            config: params.cfg,
            agentId: policyAgentId,
            elevated: params.bashElevated,
            cwd: workspaceDir,
            allowBackground: false,
            scopeKey: params.sessionKey,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            sessionStore: params.cfg.session?.store,
            mainKey: params.cfg.session?.mainKey,
            sessionScope: params.cfg.session?.scope,
            eventRouting: resolveEventSessionRoutingPolicy({
              cfg: params.cfg,
              sessionKey: params.sessionKey,
              channel: params.messageProvider,
              accountId: params.accountId,
            }),
            messageProvider: params.messageProvider,
            currentChannelId: params.currentChannelId ?? params.agentTo,
            currentThreadTs: params.currentThreadTs ?? params.agentThreadId,
            channelContext: params.channelContext,
            accountId: params.accountId,
            approvalReviewerDeviceId: params.approvalReviewerDeviceId,
            backgroundMs: execConfig?.backgroundMs,
            timeoutSec: execConfig?.timeoutSec,
            approvalRunningNoticeMs: execConfig?.approvalRunningNoticeMs,
            notifyOnExit: execConfig?.notifyOnExit,
            notifyOnExitEmptySuccess: execConfig?.notifyOnExitEmptySuccess,
          },
          {
            description:
              "Execute a shell command on a connected OpenClaw node. This tool is node-only; use the CLI native shell for Gateway-local commands. Commands run synchronously. Set node when multiple nodes are available.",
            displaySummary: "Run commands on a connected node",
            parameters: nodeExecSchema,
          },
        ),
      ]
    : toolsWithMediatedCoding;

  const toolsForMessageProvider = filterToolsByMessageProvider(allTools, params.messageProvider);
  const policyFiltered = applyToolPolicyPipeline({
    tools: toolsForMessageProvider,
    toolMeta: (tool: AnyAgentTool) => getPluginToolMeta(tool),
    warn: logWarn,
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        profilePolicy: profilePolicyWithAlsoAllow,
        profile,
        profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
        providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
        providerProfile,
        providerProfileUnavailableCoreWarningAllowlist: providerProfilePolicy?.allow,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        senderPolicy,
        agentId: policyAgentId,
      }),
      { policy: sandboxPolicy, label: "sandbox tools.allow" },
      { policy: subagentPolicy, label: "subagent tools.allow" },
      { policy: inheritedToolPolicy, label: "inherited tools" },
    ],
    declaredToolAllowlist: buildDeclaredToolAllowlistContext({
      config: params.cfg,
      workspaceDir,
      toolDenylist: explicitDenylist,
    }),
  });

  const gatewayDenySet = new Set([
    ...defaultGatewayDeny,
    ...ownerOnlyGatewayDeny,
    ...(Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : []),
    ...excludedToolNames,
  ]);
  const tools = policyFiltered.filter((tool) => !gatewayDenySet.has(tool.name));
  // The loopback exec tool is node-only. Do not let a raw `exec` capability get
  // reinterpreted as generic Gateway/sandbox exec by spawned sessions or cron jobs.
  const inheritableTools = includeNodeExecTool
    ? tools.filter((tool) => tool.name.trim().toLowerCase() !== "exec")
    : tools;
  if (shouldInheritEffectiveToolAllowlist) {
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, inheritableTools);
  }
  replaceWithEffectiveCronCreatorToolAllowlist(cronCreatorToolAllowlist, inheritableTools, (tool) =>
    getPluginToolMeta(tool),
  );

  return {
    agentId: sessionAgentId,
    tools,
    workspaceDir,
  };
}
