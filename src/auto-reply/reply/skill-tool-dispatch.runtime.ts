import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../../agents/agent-tools.policy.js";
import type { AnyAgentTool } from "../../agents/agent-tools.types.js";
import { createOpenClawTools } from "../../agents/openclaw-tools.runtime.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSenderToolPolicy } from "../../agents/sender-tool-policy.js";
import type { SkillCommandSpec } from "../../agents/skills.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../agents/subagent-capabilities.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../../agents/tool-policy-pipeline.js";
import {
  collectExplicitDenylist,
  collectExplicitAllowlist,
  hasRestrictiveAllowPolicy,
  mergeAlsoAllowPolicy,
  replaceWithEffectiveToolAllowlist,
  resolveToolProfilePolicy,
} from "../../agents/tool-policy.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { getPluginToolMeta } from "../../plugins/tools.js";
import { resolveGatewayMessageChannel } from "../../utils/message-channel.js";
import type { MsgContext } from "../templating.js";
import { extractExplicitGroupId } from "./group-id.js";

/**
 * Policy-enforcement seam for skill `command-dispatch: tool` invocations.
 * Keep this aligned with the normal tool surfaces so GHSA-mhm4-93fw-4qr2
 * stays closed across allow/deny, group, sandbox, and subagent policy layers.
 */
export function resolveSkillDispatchTools(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  workspaceDir: string;
  provider: string;
  model: string;
  senderId?: string;
  currentChannelId?: string;
  skillCommand?: Pick<SkillCommandSpec, "name" | "skillName" | "skillSource"> & {
    toolName?: string;
  };
}): AnyAgentTool[] {
  const channel =
    resolveGatewayMessageChannel(params.ctx.Surface) ??
    resolveGatewayMessageChannel(params.ctx.Provider) ??
    undefined;
  const {
    agentId: resolvedAgentId,
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
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    modelProvider: params.provider,
    modelId: params.model,
  });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const groupId = params.sessionEntry?.groupId ?? extractExplicitGroupId(params.ctx.From);
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    spawnedBy: params.sessionEntry?.spawnedBy,
    messageProvider: channel,
    groupId,
    groupChannel: params.sessionEntry?.groupChannel,
    groupSpace: params.sessionEntry?.space,
    accountId: params.ctx.AccountId,
    senderId: params.ctx.SenderId ?? params.senderId,
    senderName: params.ctx.SenderName,
    senderUsername: params.ctx.SenderUsername,
    senderE164: params.ctx.SenderE164,
  });
  const senderPolicy = resolveSenderToolPolicy({
    config: params.cfg,
    agentId: resolvedAgentId,
    messageProvider: channel,
    senderId: params.ctx.SenderId ?? params.senderId,
    senderName: params.ctx.SenderName,
    senderUsername: params.ctx.SenderUsername,
    senderE164: params.ctx.SenderE164,
  });
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
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
  const explicitPolicyList = [
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
  ];
  const inheritedToolAllowlist: string[] = [];
  const beforeToolCallHookContext = params.skillCommand
    ? {
        cwd: params.workspaceDir,
        workspaceDir: params.workspaceDir,
        ...(params.sessionEntry?.skillsSnapshot
          ? { skillsSnapshot: params.sessionEntry.skillsSnapshot }
          : {}),
        skillCommand: {
          commandName: params.skillCommand.name,
          skillName: params.skillCommand.skillName,
          skillSource: params.skillCommand.skillSource ?? "unknown",
          ...(params.skillCommand.toolName ? { toolName: params.skillCommand.toolName } : {}),
        },
      }
    : undefined;
  const tools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: channel,
    agentAccountId: params.ctx.AccountId,
    agentTo: params.ctx.OriginatingTo ?? params.ctx.To,
    agentThreadId: params.ctx.MessageThreadId ?? undefined,
    agentGroupId: groupId,
    agentGroupChannel: params.sessionEntry?.groupChannel,
    agentGroupSpace: params.sessionEntry?.space,
    agentMemberRoleIds: params.ctx.MemberRoleIds,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    allowGatewaySubagentBinding: true,
    sandboxed: sandboxRuntime.sandboxed,
    requesterAgentIdOverride: params.agentId,
    requesterSenderId: params.senderId,
    sessionId: params.sessionEntry?.sessionId,
    currentChannelId: params.currentChannelId,
    ...(beforeToolCallHookContext ? { beforeToolCallHookContext } : {}),
    modelProvider: params.provider,
    modelId: params.model,
    pluginToolAllowlist: collectExplicitAllowlist(explicitPolicyList),
    pluginToolDenylist: collectExplicitDenylist(explicitPolicyList),
    inheritedToolAllowlist,
    inheritedToolDenylist: collectExplicitDenylist(explicitPolicyList),
  });
  const policyFiltered = applyToolPolicyPipeline({
    tools,
    toolMeta: (tool) => getPluginToolMeta(tool),
    warn: logVerbose,
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
        agentId: resolvedAgentId,
      }),
      { policy: sandboxPolicy, label: "sandbox tools.allow" },
      { policy: subagentPolicy, label: "subagent tools.allow" },
      { policy: inheritedToolPolicy, label: "inherited tools" },
    ],
  });
  if (explicitPolicyList.some(hasRestrictiveAllowPolicy)) {
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, policyFiltered);
  }
  return policyFiltered;
}
