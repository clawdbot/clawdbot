import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { resolveEffectiveToolPolicy, resolveGroupToolPolicy } from "./agent-tools.policy.js";
import { resolveRequesterToolPolicies } from "./requester-tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import { resolveSenderToolPolicy } from "./sender-tool-policy.js";
import { isToolAllowedByPolicies } from "./tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "./tool-policy.js";

export type WebSearchToolPolicyParams = {
  config?: OpenClawConfig;
  modelProvider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
  sandboxToolPolicy?: SandboxToolPolicy;
  messageProvider?: string;
  agentAccountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  inputProvenance?: InputProvenance;
  trustedInternalHandoff?: boolean;
  scheduledToolPolicy?: ScheduledToolPolicyContext;
};

type WebSearchToolPolicyResolution = {
  allowed: boolean;
  persistentAllowed: boolean;
};

/** Resolves current and sender-independent policy for the managed web_search tool. */
export function resolveWebSearchToolPolicy(
  params: WebSearchToolPolicyParams,
): WebSearchToolPolicyResolution {
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
  } = resolveEffectiveToolPolicy({
    config: params.config,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow);
  const providerProfilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(providerProfile),
    providerProfileAlsoAllow,
  );
  const groupPolicyParams = {
    config: params.config,
    sessionKey: params.scheduledToolPolicy?.ownerSessionKey ?? params.sessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.scheduledToolPolicy?.ownerAccountId ?? params.agentAccountId,
    requireConfiguredAccount: params.scheduledToolPolicy?.mode === "account",
    senderPolicyMode: params.scheduledToolPolicy ? ("never" as const) : ("always" as const),
  };
  const senderPolicyParams = {
    config: params.config,
    agentId,
    messageProvider: params.messageProvider,
  };
  const requesterPolicies = resolveRequesterToolPolicies({
    ...groupPolicyParams,
    agentId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    inputProvenance: params.inputProvenance,
    trustedInternalHandoff: params.trustedInternalHandoff,
    senderPolicyMode: params.scheduledToolPolicy ? "never" : "always",
    groupPolicySessionKey: params.scheduledToolPolicy?.ownerSessionKey,
    requireConfiguredGroupAccount: params.scheduledToolPolicy?.mode === "account",
  });
  const persistentGroupPolicy = requesterPolicies.delegated
    ? undefined
    : resolveGroupToolPolicy(groupPolicyParams);
  const persistentSenderPolicy =
    requesterPolicies.delegated || params.scheduledToolPolicy
      ? undefined
      : resolveSenderToolPolicy(senderPolicyParams);
  const fixedPolicies = [
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
  ];
  const trailingPolicies = [
    params.sandboxToolPolicy,
    requesterPolicies.subagentPolicy,
    requesterPolicies.inheritedToolPolicy,
  ];
  return {
    allowed: isToolAllowedByPolicies("web_search", [
      ...fixedPolicies,
      requesterPolicies.groupPolicy,
      requesterPolicies.senderPolicy,
      ...trailingPolicies,
    ]),
    persistentAllowed: isToolAllowedByPolicies("web_search", [
      ...fixedPolicies,
      persistentGroupPolicy,
      persistentSenderPolicy,
      ...trailingPolicies,
    ]),
  };
}
