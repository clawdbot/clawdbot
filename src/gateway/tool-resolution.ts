import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../agents/pi-tools.policy.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../agents/subagent-capabilities.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../agents/tool-policy-pipeline.js";
import {
  collectExplicitAllowlist,
  collectExplicitDenylist,
  hasRestrictiveAllowPolicy,
  mergeAlsoAllowPolicy,
  replaceWithEffectiveToolAllowlist,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { InboundTurnKind } from "../channels/turn/kind.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { DEFAULT_GATEWAY_HTTP_TOOL_DENY } from "../security/dangerous-tools.js";

type GatewayScopedToolSurface = "http" | "loopback";

export function resolveGatewayScopedTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  messageProvider?: string;
  accountId?: string;
  inboundTurnKind?: InboundTurnKind;
  agentTo?: string;
  agentThreadId?: string;
  allowGatewaySubagentBinding?: boolean;
  allowMediaInvokeCommands?: boolean;
  surface?: GatewayScopedToolSurface;
  excludeToolNames?: Iterable<string>;
  disablePluginTools?: boolean;
  senderIsOwner?: boolean;
  gatewayRequestedTools?: string[];
}) {
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({ config: params.cfg, sessionKey: params.sessionKey });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const gatewayRequestedTools = params.gatewayRequestedTools ?? [];
  const sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined =
    params.inboundTurnKind === "room_event" ? "message_tool_only" : undefined;
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
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    accountId: params.accountId ?? null,
  });
  const subagentStore = resolveSubagentCapabilityStore(params.sessionKey, {
    cfg: params.cfg,
  });
  const subagentPolicy = isSubagentEnvelopeSession(params.sessionKey, {
    cfg: params.cfg,
    store: subagentStore,
  })
    ? resolveSubagentToolPolicyForSession(params.cfg, params.sessionKey, {
        store: subagentStore,
      })
    : undefined;
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(params.cfg, params.sessionKey, {
    store: subagentStore,
  });
  const excludedToolNames = params.excludeToolNames ? Array.from(params.excludeToolNames) : [];
  const surface = params.surface ?? "http";
  const gatewayToolsCfg = params.cfg.gateway?.tools;
  const defaultGatewayDeny =
    surface === "http"
      ? DEFAULT_GATEWAY_HTTP_TOOL_DENY.filter((name) => !gatewayToolsCfg?.allow?.includes(name))
      : [];
  const workspaceDir = resolveAgentWorkspaceDir(
    params.cfg,
    agentId ?? resolveDefaultAgentId(params.cfg),
  );
  const explicitDenylist = collectExplicitDenylist([
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    subagentPolicy,
    inheritedToolPolicy,
    defaultGatewayDeny.length > 0 ? { deny: defaultGatewayDeny } : undefined,
    Array.isArray(gatewayToolsCfg?.deny) ? { deny: gatewayToolsCfg.deny } : undefined,
    excludedToolNames.length > 0 ? { deny: excludedToolNames } : undefined,
  ]);
  const inheritedToolDenylist = [...explicitDenylist];
  // Passed by reference to sessions_spawn and populated after the final policy
  // pass so child sessions inherit the actual parent tool surface.
  const inheritedToolAllowlist: string[] = [];
  const shouldInheritEffectiveToolAllowlist = [
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    subagentPolicy,
    inheritedToolPolicy,
    gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : undefined,
  ].some(hasRestrictiveAllowPolicy);

  const allTools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: params.messageProvider ?? undefined,
    agentAccountId: params.accountId,
    inboundTurnKind: params.inboundTurnKind,
    sourceReplyDeliveryMode,
    agentTo: params.agentTo,
    agentThreadId: params.agentThreadId,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    allowMediaInvokeCommands: params.allowMediaInvokeCommands,
    disablePluginTools: params.disablePluginTools,
    wrapBeforeToolCallHook: false,
    senderIsOwner: params.senderIsOwner,
    config: params.cfg,
    workspaceDir,
    pluginToolAllowlist: collectExplicitAllowlist([
      profilePolicy,
      providerProfilePolicy,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      subagentPolicy,
      inheritedToolPolicy,
      gatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : undefined,
    ]),
    pluginToolDenylist: explicitDenylist,
    inheritedToolAllowlist,
    inheritedToolDenylist,
  });

  const policyFiltered = applyToolPolicyPipeline({
    tools: allTools,
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
        agentId,
      }),
      { policy: subagentPolicy, label: "subagent tools.allow" },
      { policy: inheritedToolPolicy, label: "inherited tools" },
    ],
  });

  const gatewayDenySet = new Set([
    ...defaultGatewayDeny,
    ...(Array.isArray(gatewayToolsCfg?.deny) ? gatewayToolsCfg.deny : []),
    ...excludedToolNames,
  ]);
  const tools = policyFiltered.filter((tool) => !gatewayDenySet.has(tool.name));
  if (shouldInheritEffectiveToolAllowlist) {
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, tools);
  }

  return {
    agentId,
    tools,
  };
}
