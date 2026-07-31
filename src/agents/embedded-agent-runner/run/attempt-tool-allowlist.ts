import type { ResolvedConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { collectExplicitToolAllowlistSources } from "../../tool-allowlist-guard.js";

export function collectAttemptExplicitToolAllowlistSources(params: {
  // The attempt's single resolved profile: keeps these allowlist *sources*
  // in lockstep with the policy that actually constructed and filtered the
  // run's tools, instead of re-resolving with divergent session inputs.
  capabilityProfile: ResolvedConversationCapabilityProfile;
  toolsAllow?: string[];
}) {
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    sandboxPolicy,
    subagentPolicy,
    inheritedToolPolicy,
  } = params.capabilityProfile.policy;
  return collectExplicitToolAllowlistSources([
    { label: "tools.allow", allow: globalPolicy?.allow },
    { label: "tools.byProvider.allow", allow: globalProviderPolicy?.allow },
    {
      label: agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
      allow: agentPolicy?.allow,
    },
    {
      label: agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
      allow: agentProviderPolicy?.allow,
    },
    { label: "group tools.allow", allow: groupPolicy?.allow },
    { label: "sandbox tools.allow", allow: sandboxPolicy?.allow },
    { label: "subagent tools.allow", allow: subagentPolicy?.allow },
    { label: "inherited tools.allow", allow: inheritedToolPolicy?.allow },
    { label: "runtime toolsAllow", allow: params.toolsAllow, enforceWhenToolsDisabled: true },
  ]);
}
