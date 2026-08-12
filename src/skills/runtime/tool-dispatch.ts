// Skill tool dispatch routes runtime skill tool calls through the active session context.
import type { AnyAgentTool } from "../../agents/agent-tools.types.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import {
  buildConversationToolPolicyPipelineSteps,
  resolveConversationToolPolicies,
} from "../../agents/conversation-tool-policy-pipeline.js";
import { createOpenClawTools } from "../../agents/openclaw-tools.runtime.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { buildDeclaredToolAllowlistContext } from "../../agents/tool-policy-declared-context.js";
import { applyToolPolicyPipeline } from "../../agents/tool-policy-pipeline.js";
import {
  hasRestrictiveAllowPolicy,
  replaceWithEffectiveToolAllowlist,
} from "../../agents/tool-policy.js";
import {
  replaceWithEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
} from "../../agents/tools/cron-tool.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { getPluginToolMeta } from "../../plugins/tools.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
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
 * Keep this aligned with normal tool surfaces across sender, group, sandbox,
 * and subagent policy layers.
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
  senderIsOwner: boolean;
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
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  const groupId = params.sessionEntry?.groupId ?? params.groupId;
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: params.cfg,
    sessionKey: params.sessionKey,
    sessionId: params.sessionEntry?.sessionId,
    agentId: params.agentId,
    agentDir: params.agentDir,
    agentAccountId: params.message.accountId,
    messageProvider: channel,
    messageChannel: channel,
    messageTo: params.message.originatingTo ?? params.message.to,
    messageThreadId: params.message.messageThreadId,
    currentChannelId: params.currentChannelId,
    currentMessagingTarget: params.message.originatingTo ?? params.message.to,
    groupId,
    groupChannel: params.sessionEntry?.groupChannel,
    groupSpace: params.sessionEntry?.space,
    memberRoleIds: params.message.memberRoleIds,
    spawnedBy: params.sessionEntry?.spawnedBy,
    senderId: params.message.senderId ?? params.senderId,
    senderName: params.message.senderName,
    senderUsername: params.message.senderUsername,
    senderE164: params.message.senderE164,
    senderIsOwner: params.senderIsOwner,
    modelProvider: params.provider,
    modelId: params.model,
    workspaceDir: params.workspaceDir,
    skillsSnapshot: params.sessionEntry?.skillsSnapshot,
    sandboxToolPolicy: sandboxPolicy,
  });
  const conversationPolicies = resolveConversationToolPolicies({ capabilityProfile });
  const ownerOnlyCoreToolPolicy = !params.senderIsOwner
    ? { deny: [...GATEWAY_OWNER_ONLY_CORE_TOOLS] }
    : undefined;
  const explicitDenylist = [
    ...capabilityProfile.policy.explicitToolDenylist,
    ...(ownerOnlyCoreToolPolicy?.deny ?? []),
  ];
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
    senderIsOwner: params.senderIsOwner,
    sessionId: params.sessionEntry?.sessionId,
    currentChannelId: params.currentChannelId,
    ...(beforeToolCallHookContext ? { beforeToolCallHookContext } : {}),
    modelProvider: params.provider,
    modelId: params.model,
    pluginToolAllowlist: capabilityProfile.policy.pluginToolDiscoveryAllowlist,
    pluginToolDenylist: explicitDenylist,
    cronCreatorToolAllowlist,
    inheritedToolAllowlist,
    inheritedToolDenylist: explicitDenylist,
  });
  const policyFiltered = applyToolPolicyPipeline({
    tools,
    toolMeta: (tool) => getPluginToolMeta(tool),
    warn: logVerbose,
    steps: buildConversationToolPolicyPipelineSteps({
      capabilityProfile,
      policies: conversationPolicies,
      additionalStepsAfterSandbox: [
        { policy: ownerOnlyCoreToolPolicy, label: "gateway sender owner-only tools" },
      ],
      includeRuntimeToolPolicy: false,
    }),
    declaredToolAllowlist: buildDeclaredToolAllowlistContext({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      toolDenylist: explicitDenylist,
    }),
  });
  if (capabilityProfile.policy.inheritancePolicies.some(hasRestrictiveAllowPolicy)) {
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, policyFiltered);
  }
  replaceWithEffectiveCronCreatorToolAllowlist(cronCreatorToolAllowlist, policyFiltered, (tool) =>
    getPluginToolMeta(tool),
  );
  return policyFiltered;
}
