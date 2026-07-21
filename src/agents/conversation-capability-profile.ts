/**
 * Resolves the conversation-scoped runtime facts that tool and harness policy
 * hot paths share. Keep this internal: it prepares existing config/state, not a
 * new public access-profile config surface.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { ChatType } from "../channels/chat-type.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { SkillSnapshot } from "../skills/types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import {
  resolveEffectiveToolPolicy,
  resolveTrustedGroupId,
  sessionKeyNamesGroupConversation,
} from "./agent-tools.policy.js";
import {
  resolveRequesterToolPolicies,
  type RequesterToolPolicySource,
} from "./requester-tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import type { PromptMode } from "./system-prompt.types.js";
import {
  collectExplicitAllowlist,
  collectExplicitDenylist,
  resolveToolProfilePolicy,
  type ToolPolicyLike,
} from "./tool-policy.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

type ConversationCapabilityScope = "direct" | "shared" | "unknown";

export type ConversationCapabilityProfileParams = {
  config?: OpenClawConfig;
  sessionKey?: string;
  /** Live conversation key when a sandbox/policy key is used for tool filtering. */
  runSessionKey?: string;
  /** Session key used for subagent capability inheritance when it differs from sessionKey. */
  sandboxSessionKey?: string;
  sessionId?: string;
  runId?: string;
  agentId?: string;
  agentDir?: string;
  agentAccountId?: string | null;
  messageProvider?: string | null;
  messageChannel?: string | null;
  chatType?: string;
  messageTo?: string | null;
  messageThreadId?: string | number | null;
  currentChannelId?: string | null;
  currentMessagingTarget?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  memberRoleIds?: readonly string[];
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  senderIsOwner?: boolean;
  modelProvider?: string;
  modelId?: string;
  modelApi?: string;
  modelContextWindowTokens?: number;
  modelHasVision?: boolean;
  workspaceDir?: string;
  cwd?: string;
  spawnWorkspaceDir?: string;
  isCanonicalWorkspace?: boolean;
  promptMode?: PromptMode;
  skillsSnapshot?: SkillSnapshot;
  sandboxToolPolicy?: SandboxToolPolicy;
  runtimeToolAllowlist?: string[];
  /** Persist the runtime allowlist as real parent authority on spawned children. */
  inheritRuntimeToolAllowlist?: boolean;
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  inputProvenance?: InputProvenance;
  /** Trusted in-process completion handoff; public callers cannot set this fact. */
  trustedInternalHandoff?: boolean;
};

export type ResolvedConversationCapabilityProfile = {
  agentId?: string;
  serviceIdentity: {
    agentId?: string;
    agentDir?: string;
    accountId?: string | null;
    runId?: string;
    sessionId?: string;
  };
  model: {
    provider?: string;
    id?: string;
    api?: string;
    contextWindowTokens?: number;
    hasVision?: boolean;
  };
  conversation: {
    scope: ConversationCapabilityScope;
    chatType?: ChatType;
    sessionKey?: string;
    policySessionKey?: string;
    runSessionKey?: string;
    sessionId?: string;
    messageProvider?: string | null;
    messageChannel?: string | null;
    messageTo?: string | null;
    messageThreadId?: string | number | null;
    currentChannelId?: string | null;
    currentMessagingTarget?: string | null;
    currentThreadTs?: string | null;
    currentMessageId?: string | number | null;
    groupId?: string | null;
    groupChannel?: string | null;
    groupSpace?: string | null;
    memberRoleIds?: readonly string[];
    spawnedBy?: string | null;
  };
  sender: {
    id?: string | null;
    name?: string | null;
    username?: string | null;
    e164?: string | null;
    isOwner?: boolean;
  };
  workspace: {
    workspaceDir?: string;
    cwd?: string;
    spawnWorkspaceDir?: string;
    workspaceRoot: string;
    runtimeRoot: string;
    spawnWorkspaceRoot?: string;
    instructionRoot?: string;
    isCanonicalWorkspace?: boolean;
  };
  instructions: {
    agentDir?: string;
    workspaceDir?: string;
    promptMode?: PromptMode;
    isCanonicalWorkspace?: boolean;
  };
  skills: {
    snapshot?: SkillSnapshot;
  };
  policy: {
    agentId?: string;
    sessionKey?: string;
    subagentSessionKey?: string;
    trustedGroup: {
      groupId: string | null | undefined;
      dropped: boolean;
    };
    profile?: string;
    providerProfile?: string;
    profilePolicy?: ToolPolicyLike;
    providerProfilePolicy?: ToolPolicyLike;
    profileAlsoAllow?: string[];
    providerProfileAlsoAllow?: string[];
    globalPolicy?: SandboxToolPolicy;
    globalProviderPolicy?: SandboxToolPolicy;
    agentPolicy?: SandboxToolPolicy;
    agentProviderPolicy?: SandboxToolPolicy;
    groupPolicy?: SandboxToolPolicy;
    senderPolicy?: SandboxToolPolicy;
    sandboxPolicy?: SandboxToolPolicy;
    subagentPolicy?: SandboxToolPolicy;
    inheritedToolPolicy?: SandboxToolPolicy;
    delegated: boolean;
    requesterPolicySource: RequesterToolPolicySource;
    runtimeToolPolicyForInheritance?: ToolPolicyLike;
    inheritancePolicies: Array<ToolPolicyLike | undefined>;
    explicitToolAllowlist: string[];
    /** Explicit config/runtime grants only; excludes built-in profile expansion. */
    explicitToolOverrideAllowlist: string[];
    explicitToolDenylist: string[];
    runtimePluginToolGrant?: RuntimePluginToolGrant;
  };
};

export function resolveConversationCapabilityProfile(
  params: ConversationCapabilityProfileParams,
): ResolvedConversationCapabilityProfile {
  const messageProvider = params.messageProvider;
  const effective = resolveEffectiveToolPolicy({
    config: params.config,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const trustedGroup = resolveTrustedGroupId({
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    groupId: params.groupId,
  });
  // Group channel/space labels have no session-bound counterpart to verify
  // against; mask them whenever the trust check dropped the caller group id.
  const trustedGroupChannel = trustedGroup.dropped ? null : params.groupChannel;
  const trustedGroupSpace = trustedGroup.dropped ? null : params.groupSpace;
  // Owner WebChat intentionally has no external sender identity. Its trusted
  // owner state must not fall through to the wildcard policy for guests.
  const isOwnerInternalSession =
    params.senderIsOwner === true &&
    normalizeMessageChannel(messageProvider ?? params.messageChannel) === INTERNAL_MESSAGE_CHANNEL;
  const subagentSessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const requesterPolicies = resolveRequesterToolPolicies({
    config: params.config,
    sessionKey: params.sessionKey,
    subagentSessionKey,
    agentId: effective.agentId,
    spawnedBy: params.spawnedBy,
    messageProvider,
    groupId: trustedGroup.groupId,
    groupChannel: trustedGroupChannel,
    groupSpace: trustedGroupSpace,
    accountId: params.agentAccountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    inputProvenance: params.inputProvenance,
    trustedInternalHandoff: params.trustedInternalHandoff,
    senderPolicyMode: isOwnerInternalSession ? "never" : "always",
  });
  const { groupPolicy, senderPolicy, subagentPolicy, inheritedToolPolicy } = requesterPolicies;
  const profilePolicy = resolveToolProfilePolicy(effective.profile);
  const providerProfilePolicy = resolveToolProfilePolicy(effective.providerProfile);
  const configuredOverridePolicies = [
    effective.globalPolicy,
    effective.globalProviderPolicy,
    effective.agentPolicy,
    effective.agentProviderPolicy,
    groupPolicy,
    senderPolicy,
    params.sandboxToolPolicy,
    subagentPolicy,
  ];
  const runtimeToolPolicy = params.runtimeToolAllowlist
    ? { allow: params.runtimeToolAllowlist }
    : undefined;
  const runtimeToolPolicyForInheritance =
    params.inheritRuntimeToolAllowlist === true ? runtimeToolPolicy : undefined;
  const runtimeToolAlsoAllowlist = uniqueStrings(
    (params.runtimePluginToolGrant?.toolNames ?? []).map((entry) => entry.trim()).filter(Boolean),
  );
  const mergeRuntimeToolAlsoAllowlist = (configured?: string[]) => {
    const merged = uniqueStrings([...(configured ?? []), ...runtimeToolAlsoAllowlist]);
    return merged.length > 0 ? merged : undefined;
  };
  const explicitOverridePolicies = [...configuredOverridePolicies, runtimeToolPolicy];
  const explicitToolAllowlistPolicies = [
    profilePolicy,
    providerProfilePolicy,
    ...configuredOverridePolicies,
    inheritedToolPolicy,
    runtimeToolPolicy,
  ];
  const inheritancePolicies = [
    profilePolicy,
    providerProfilePolicy,
    ...configuredOverridePolicies,
    inheritedToolPolicy,
    runtimeToolPolicyForInheritance,
  ];

  return {
    agentId: effective.agentId,
    serviceIdentity: {
      agentId: effective.agentId,
      agentDir: params.agentDir,
      accountId: params.agentAccountId,
      runId: params.runId,
      sessionId: params.sessionId,
    },
    model: {
      provider: params.modelProvider,
      id: params.modelId,
      api: params.modelApi,
      contextWindowTokens: params.modelContextWindowTokens,
      hasVision: params.modelHasVision,
    },
    conversation: {
      scope: resolveConversationScope({
        chatType: params.chatType,
        sessionKey: params.sessionKey,
        runSessionKey: params.runSessionKey,
        trustedGroup,
        groupChannel: trustedGroupChannel,
        groupSpace: trustedGroupSpace,
      }),
      chatType: normalizeChatType(params.chatType),
      sessionKey: params.runSessionKey ?? params.sessionKey,
      policySessionKey: params.sessionKey,
      runSessionKey: params.runSessionKey,
      sessionId: params.sessionId,
      messageProvider,
      messageChannel: params.messageChannel,
      messageTo: params.messageTo,
      messageThreadId: params.messageThreadId,
      currentChannelId: params.currentChannelId,
      currentMessagingTarget: params.currentMessagingTarget,
      currentThreadTs: params.currentThreadTs,
      currentMessageId: params.currentMessageId,
      groupId: trustedGroup.groupId,
      groupChannel: trustedGroupChannel,
      groupSpace: trustedGroupSpace,
      memberRoleIds: params.memberRoleIds,
      spawnedBy: params.spawnedBy,
    },
    sender: {
      id: params.senderId,
      name: params.senderName,
      username: params.senderUsername,
      e164: params.senderE164,
      isOwner: params.senderIsOwner,
    },
    workspace: {
      workspaceDir: params.workspaceDir,
      cwd: params.cwd,
      spawnWorkspaceDir: params.spawnWorkspaceDir,
      workspaceRoot: resolveWorkspaceRoot(params.workspaceDir),
      runtimeRoot: resolveWorkspaceRoot(params.cwd ?? params.workspaceDir),
      spawnWorkspaceRoot: params.spawnWorkspaceDir
        ? resolveWorkspaceRoot(params.spawnWorkspaceDir)
        : undefined,
      instructionRoot: params.agentDir ?? params.workspaceDir,
      isCanonicalWorkspace: params.isCanonicalWorkspace,
    },
    instructions: {
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      promptMode: params.promptMode,
      isCanonicalWorkspace: params.isCanonicalWorkspace,
    },
    skills: {
      snapshot: params.skillsSnapshot,
    },
    policy: {
      agentId: effective.agentId,
      sessionKey: params.sessionKey,
      subagentSessionKey,
      trustedGroup,
      profile: effective.profile,
      providerProfile: effective.providerProfile,
      profilePolicy,
      providerProfilePolicy,
      profileAlsoAllow: mergeRuntimeToolAlsoAllowlist(effective.profileAlsoAllow),
      providerProfileAlsoAllow: mergeRuntimeToolAlsoAllowlist(effective.providerProfileAlsoAllow),
      globalPolicy: effective.globalPolicy,
      globalProviderPolicy: effective.globalProviderPolicy,
      agentPolicy: effective.agentPolicy,
      agentProviderPolicy: effective.agentProviderPolicy,
      groupPolicy,
      senderPolicy,
      sandboxPolicy: params.sandboxToolPolicy,
      subagentPolicy,
      inheritedToolPolicy,
      delegated: requesterPolicies.delegated,
      requesterPolicySource: requesterPolicies.requesterPolicySource,
      runtimeToolPolicyForInheritance,
      inheritancePolicies,
      explicitToolAllowlist: collectExplicitAllowlist(explicitToolAllowlistPolicies),
      explicitToolOverrideAllowlist: collectExplicitAllowlist(explicitOverridePolicies),
      explicitToolDenylist: collectExplicitDenylist(explicitToolAllowlistPolicies),
      runtimePluginToolGrant: params.runtimePluginToolGrant,
    },
  };
}

function resolveConversationScope(params: {
  chatType?: string;
  sessionKey?: string;
  runSessionKey?: string;
  trustedGroup: { groupId: string | null | undefined; dropped: boolean };
  groupChannel?: string | null;
  groupSpace?: string | null;
}): ConversationCapabilityScope {
  const chatType = normalizeChatType(params.chatType);
  if (chatType === "direct") {
    return "direct";
  }
  if (chatType === "group" || chatType === "channel") {
    return "shared";
  }
  // Without a live chat type, classify only from server-derived session keys
  // and trust-checked group facts. A caller-supplied group id that
  // resolveTrustedGroupId dropped must not flip an unknown-audience
  // conversation to "shared": downstream audience and credential decisions
  // read this field, and the profile already publishes that group as null.
  if (
    sessionKeyNamesGroupConversation(params.runSessionKey) ||
    sessionKeyNamesGroupConversation(params.sessionKey)
  ) {
    return "shared";
  }
  if (params.trustedGroup.dropped) {
    return "unknown";
  }
  return params.trustedGroup.groupId?.trim() ||
    params.groupChannel?.trim() ||
    params.groupSpace?.trim()
    ? "shared"
    : "unknown";
}
