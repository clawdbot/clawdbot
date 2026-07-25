// Skill tool dispatch routes runtime skill tool calls through the active session context.
import { resolveEffectiveToolPolicy } from "../../agents/agent-tools.policy.js";
import type { AnyAgentTool } from "../../agents/agent-tools.types.js";
import { createOpenClawTools } from "../../agents/openclaw-tools.runtime.js";
import { resolveRequesterToolPolicies } from "../../agents/requester-tool-policy.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { buildDeclaredToolAllowlistContext } from "../../agents/tool-policy-declared-context.js";
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
import {
  replaceWithEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
} from "../../agents/tools/cron-tool.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { getPluginToolMeta } from "../../plugins/tools.js";
import { resolveGatewayMessageChannel } from "../../utils/message-channel.js";
import type { SkillCommandSpec } from "../types.js";

type SkillDispatchMessageContext = {
  surface?: string;
  provider?: string;
  accountId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  originatingTo?: string;
  to?: string;
  nativeChannelId?: string;
  messageThreadId?: string | number;
  memberRoleIds?: string[];
};

/**
 * Policy-enforcement seam for skill `command-dispatch: tool` invocations.
 * Keep this aligned with the normal tool surfaces so GHSA-mhm4-93fw-4qr2
 * stays closed across allow/deny, group, sandbox, and subagent policy layers.
 */
export function resolveSkillDispatchTools(params: {
  message: SkillDispatchMessageContext;
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
  skillCommand?: Pick<SkillCommandSpec, "name" | "skillFile" | "skillName" | "skillSource"> & {
    toolName?: string;
  };
  groupId?: string;
}): AnyAgentTool[] {
  const channel =
    resolveGatewayMessageChannel(params.message.surface) ??
    resolveGatewayMessageChannel(params.message.provider) ??
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
  const groupId = params.sessionEntry?.groupId ?? params.groupId;
  const requesterPolicies = resolveRequesterToolPolicies({
    config: params.cfg,
    sessionKey: params.sessionKey,
    subagentSessionKey: params.sessionKey,
    agentId: resolvedAgentId,
    spawnedBy: params.sessionEntry?.spawnedBy,
    messageProvider: channel,
    groupId,
    groupChannel: params.sessionEntry?.groupChannel,
    groupSpace: params.sessionEntry?.space,
    accountId: params.message.accountId,
    senderId: params.message.senderId ?? params.senderId,
    senderName: params.message.senderName,
    senderUsername: params.message.senderUsername,
    senderE164: params.message.senderE164,
  });
  const { groupPolicy, senderPolicy, subagentPolicy, inheritedToolPolicy } = requesterPolicies;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
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
  const explicitDenylist = collectExplicitDenylist(explicitPolicyList);
  const inheritedToolAllowlist: string[] = [];
  const cronCreatorToolAllowlist: CronCreatorToolAllowlistEntry[] = [];
  const beforeToolCallHookContext = params.skillCommand
    ? {
        cwd: params.workspaceDir,
        workspaceDir: params.workspaceDir,
        ...(params.sessionEntry?.skillsSnapshot
          ? { skillsSnapshot: params.sessionEntry.skillsSnapshot }
          : {}),
        skillCommand: {
          commandName: params.skillCommand.name,
          ...(params.skillCommand.skillFile ? { skillFile: params.skillCommand.skillFile } : {}),
          skillName: params.skillCommand.skillName,
          skillSource: params.skillCommand.skillSource ?? "unknown",
          ...(params.skillCommand.toolName ? { toolName: params.skillCommand.toolName } : {}),
        },
      }
    : undefined;
  const tools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: channel,
    agentAccountId: params.message.accountId,
    agentTo: params.message.originatingTo ?? params.message.to,
    agentThreadId: params.message.messageThreadId ?? undefined,
    nativeChannelId: params.message.nativeChannelId,
    agentGroupId: groupId,
    agentGroupChannel: params.sessionEntry?.groupChannel,
    agentGroupSpace: params.sessionEntry?.space,
    agentMemberRoleIds: params.message.memberRoleIds,
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
    pluginToolDenylist: explicitDenylist,
    cronCreatorToolAllowlist,
    inheritedToolAllowlist,
    inheritedToolDenylist: explicitDenylist,
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
    declaredToolAllowlist: buildDeclaredToolAllowlistContext({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      toolDenylist: explicitDenylist,
    }),
  });
  if (explicitPolicyList.some(hasRestrictiveAllowPolicy)) {
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, policyFiltered);
  }
  replaceWithEffectiveCronCreatorToolAllowlist(cronCreatorToolAllowlist, policyFiltered, (tool) =>
    getPluginToolMeta(tool),
  );
  return policyFiltered;
}
