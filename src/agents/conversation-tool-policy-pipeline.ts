import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
  type ToolPolicyPipelineStep,
} from "./tool-policy-pipeline.js";
import { mergeAlsoAllowPolicy, type ToolPolicyLike } from "./tool-policy.js";

type ResolvedConversationToolPolicies = {
  profilePolicy?: ToolPolicyLike;
  providerProfilePolicy?: ToolPolicyLike;
  globalPolicy?: ToolPolicyLike;
  globalProviderPolicy?: ToolPolicyLike;
  agentPolicy?: ToolPolicyLike;
  agentProviderPolicy?: ToolPolicyLike;
  groupPolicy?: ToolPolicyLike;
  senderPolicy?: ToolPolicyLike;
  sandboxPolicy?: ToolPolicyLike;
  subagentPolicy?: ToolPolicyLike;
  runtimeToolPolicy?: ToolPolicyLike;
  inheritedToolPolicy?: ToolPolicyLike;
};

function mergePolicyAllowlist<TPolicy extends ToolPolicyLike>(
  policy: TPolicy | undefined,
  alsoAllow: readonly string[] | undefined,
): TPolicy | undefined {
  return mergeAlsoAllowPolicy(policy, alsoAllow ? [...alsoAllow] : undefined);
}

/**
 * Resolves the shared policy layers once so local and remote fixed tool surfaces cannot
 * diverge on profile `alsoAllow`, sender, sandbox, delegation, or runtime-cap semantics.
 */
export function resolveConversationToolPolicies(params: {
  capabilityProfile: ResolvedConversationCapabilityProfile;
  additionalProfileAllow?: readonly string[];
  additionalPolicyAllow?: readonly string[];
}): ResolvedConversationToolPolicies {
  const policy = params.capabilityProfile.policy;
  const profileAllow = [
    ...(policy.profileAlsoAllow ?? []),
    ...(params.additionalProfileAllow ?? []),
  ];
  const providerProfileAllow = [
    ...(policy.providerProfileAlsoAllow ?? []),
    ...(params.additionalProfileAllow ?? []),
  ];
  return {
    profilePolicy: mergePolicyAllowlist(policy.profilePolicy, profileAllow),
    providerProfilePolicy: mergePolicyAllowlist(policy.providerProfilePolicy, providerProfileAllow),
    globalPolicy: mergePolicyAllowlist(policy.globalPolicy, params.additionalPolicyAllow),
    globalProviderPolicy: mergePolicyAllowlist(
      policy.globalProviderPolicy,
      params.additionalPolicyAllow,
    ),
    agentPolicy: mergePolicyAllowlist(policy.agentPolicy, params.additionalPolicyAllow),
    agentProviderPolicy: mergePolicyAllowlist(
      policy.agentProviderPolicy,
      params.additionalPolicyAllow,
    ),
    groupPolicy: mergePolicyAllowlist(policy.groupPolicy, params.additionalPolicyAllow),
    senderPolicy: mergePolicyAllowlist(policy.senderPolicy, params.additionalPolicyAllow),
    sandboxPolicy: mergePolicyAllowlist(policy.sandboxPolicy, params.additionalPolicyAllow),
    subagentPolicy: mergePolicyAllowlist(policy.subagentPolicy, params.additionalPolicyAllow),
    runtimeToolPolicy: policy.runtimeToolPolicyForInheritance,
    inheritedToolPolicy: policy.inheritedToolPolicy,
  };
}

/** Builds the canonical ordered policy pipeline for a resolved conversation. */
export function buildConversationToolPolicyPipelineSteps(params: {
  capabilityProfile: ResolvedConversationCapabilityProfile;
  policies: ResolvedConversationToolPolicies;
  additionalStepsAfterSandbox?: ToolPolicyPipelineStep[];
  includeRuntimeToolPolicy: boolean;
  unavailableCoreToolReason?: string;
}): ToolPolicyPipelineStep[] {
  const profile = params.capabilityProfile.policy;
  return [
    ...buildDefaultToolPolicyPipelineSteps({
      profilePolicy: params.policies.profilePolicy,
      profile: profile.profile,
      profileUnavailableCoreWarningAllowlist: profile.profilePolicy?.allow,
      providerProfilePolicy: params.policies.providerProfilePolicy,
      providerProfile: profile.providerProfile,
      providerProfileUnavailableCoreWarningAllowlist: profile.providerProfilePolicy?.allow,
      globalPolicy: params.policies.globalPolicy,
      globalProviderPolicy: params.policies.globalProviderPolicy,
      agentPolicy: params.policies.agentPolicy,
      agentProviderPolicy: params.policies.agentProviderPolicy,
      groupPolicy: params.policies.groupPolicy,
      senderPolicy: params.policies.senderPolicy,
      agentId: profile.agentId,
      unavailableCoreToolReason: params.unavailableCoreToolReason,
    }),
    {
      policy: params.policies.sandboxPolicy,
      label: "sandbox tools.allow",
      unavailableCoreToolReason: params.unavailableCoreToolReason,
    },
    ...(params.additionalStepsAfterSandbox ?? []),
    {
      policy: params.policies.subagentPolicy,
      label: "subagent tools.allow",
      unavailableCoreToolReason: params.unavailableCoreToolReason,
    },
    ...(params.includeRuntimeToolPolicy
      ? [
          {
            policy: params.policies.runtimeToolPolicy,
            label: "runtime tools.allow",
            unavailableCoreToolReason: params.unavailableCoreToolReason,
          },
        ]
      : []),
    {
      policy: params.policies.inheritedToolPolicy,
      label: "inherited tools",
      unavailableCoreToolReason: params.unavailableCoreToolReason,
    },
  ];
}

/** Projects a fixed runtime catalog through the exact conversation policy pipeline. */
export function projectConversationToolNames<TName extends string>(params: {
  capabilityProfile: ResolvedConversationCapabilityProfile;
  toolNames: readonly TName[];
  warn: (message: string) => void;
}): TName[] {
  const policies = resolveConversationToolPolicies({
    capabilityProfile: params.capabilityProfile,
  });
  const tools = params.toolNames.map((name) => ({ name }));
  return applyToolPolicyPipeline({
    tools,
    toolMeta: () => undefined,
    warn: params.warn,
    steps: buildConversationToolPolicyPipelineSteps({
      capabilityProfile: params.capabilityProfile,
      policies,
      includeRuntimeToolPolicy: true,
    }),
  }).map((tool) => tool.name);
}
