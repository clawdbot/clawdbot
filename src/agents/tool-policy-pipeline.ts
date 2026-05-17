import { filterToolsByPolicy } from "./pi-tools.policy.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { isKnownCoreToolId } from "./tool-catalog.js";
import {
  analyzeAllowlistByToolType,
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  type ToolPolicyLike,
} from "./tool-policy.js";

const MAX_TOOL_POLICY_WARNING_CACHE = 256;
const seenToolPolicyWarnings = new Set<string>();
const toolPolicyWarningOrder: string[] = [];

function rememberToolPolicyWarning(warning: string): boolean {
  if (seenToolPolicyWarnings.has(warning)) {
    return false;
  }
  if (seenToolPolicyWarnings.size >= MAX_TOOL_POLICY_WARNING_CACHE) {
    const oldest = toolPolicyWarningOrder.shift();
    if (oldest) {
      seenToolPolicyWarnings.delete(oldest);
    }
  }
  seenToolPolicyWarnings.add(warning);
  toolPolicyWarningOrder.push(warning);
  return true;
}

export type ToolPolicyPipelineStep = {
  policy: ToolPolicyLike | undefined;
  label: string;
  stripPluginOnlyAllowlist?: boolean;
  suppressUnavailableCoreToolWarning?: boolean;
  suppressUnavailableCoreToolWarningAllowlist?: string[];
  unavailableCoreToolReason?: string;
};

export function buildDefaultToolPolicyPipelineSteps(params: {
  profilePolicy?: ToolPolicyLike;
  profile?: string;
  profileUnavailableCoreWarningAllowlist?: string[];
  providerProfilePolicy?: ToolPolicyLike;
  providerProfile?: string;
  providerProfileUnavailableCoreWarningAllowlist?: string[];
  globalPolicy?: ToolPolicyLike;
  globalProviderPolicy?: ToolPolicyLike;
  agentPolicy?: ToolPolicyLike;
  agentProviderPolicy?: ToolPolicyLike;
  groupPolicy?: ToolPolicyLike;
  senderPolicy?: ToolPolicyLike;
  agentId?: string;
  unavailableCoreToolReason?: string;
}): ToolPolicyPipelineStep[] {
  const agentId = params.agentId?.trim();
  const profile = params.profile?.trim();
  const providerProfile = params.providerProfile?.trim();
  const unavailableCoreToolReason = params.unavailableCoreToolReason?.trim();
  return [
    {
      policy: params.profilePolicy,
      label: profile ? `tools.profile (${profile})` : "tools.profile",
      stripPluginOnlyAllowlist: true,
      suppressUnavailableCoreToolWarningAllowlist: params.profileUnavailableCoreWarningAllowlist,
      unavailableCoreToolReason,
    },
    {
      policy: params.providerProfilePolicy,
      label: providerProfile
        ? `tools.byProvider.profile (${providerProfile})`
        : "tools.byProvider.profile",
      stripPluginOnlyAllowlist: true,
      suppressUnavailableCoreToolWarningAllowlist:
        params.providerProfileUnavailableCoreWarningAllowlist,
      unavailableCoreToolReason,
    },
    {
      policy: params.globalPolicy,
      label: "tools.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.globalProviderPolicy,
      label: "tools.byProvider.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.agentPolicy,
      label: agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.agentProviderPolicy,
      label: agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.groupPolicy,
      label: "group tools.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.senderPolicy,
      label: "tools.toolsBySender",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
  ];
}

export function applyToolPolicyPipeline(params: {
  tools: AnyAgentTool[];
  toolMeta: (tool: AnyAgentTool) => { pluginId: string } | undefined;
  warn: (message: string) => void;
  steps: ToolPolicyPipelineStep[];
}): AnyAgentTool[] {
  const coreToolNames = new Set(
    params.tools
      .filter((tool) => !params.toolMeta(tool))
      .map((tool) => normalizeToolName(tool.name))
      .filter(Boolean),
  );

  const pluginGroups = buildPluginToolGroups({
    tools: params.tools,
    toolMeta: params.toolMeta,
  });

  let filtered = params.tools;
  for (const step of params.steps) {
    if (!step.policy) {
      continue;
    }

    let policy: ToolPolicyLike | undefined = step.policy;
    if (step.stripPluginOnlyAllowlist) {
      const resolved = analyzeAllowlistByToolType(policy, pluginGroups, coreToolNames);
      if (resolved.unknownAllowlist.length > 0) {
        const unavailableCoreWarningAllowlist = new Set(
          (step.suppressUnavailableCoreToolWarningAllowlist ?? []).map((entry) =>
            normalizeToolName(entry),
          ),
        );
        const gatedCoreEntries = resolved.unknownAllowlist.filter((entry) =>
          isKnownCoreToolId(entry),
        );
        const warnableGatedCoreEntries = step.suppressUnavailableCoreToolWarning
          ? []
          : gatedCoreEntries.filter((entry) => !unavailableCoreWarningAllowlist.has(entry));
        const otherEntries = resolved.unknownAllowlist.filter(
          (entry) => !isKnownCoreToolId(entry) && !unavailableCoreWarningAllowlist.has(entry),
        );
        const warningEntries = [...warnableGatedCoreEntries, ...otherEntries];
        if (
          shouldWarnAboutUnknownAllowlist({
            hasGatedCoreEntries: warnableGatedCoreEntries.length > 0,
            hasOtherEntries: otherEntries.length > 0,
          })
        ) {
          const entries = warningEntries.join(", ");
          const suffix = describeUnknownAllowlistSuffix({
            pluginOnlyAllowlist: resolved.pluginOnlyAllowlist,
            hasGatedCoreEntries: warnableGatedCoreEntries.length > 0,
            hasOtherEntries: otherEntries.length > 0,
            unavailableCoreToolReason: step.unavailableCoreToolReason,
          });
          const warning = `tools: ${step.label} allowlist contains unknown entries (${entries}). ${suffix}`;
          if (rememberToolPolicyWarning(warning)) {
            params.warn(warning);
          }
        }
      }
      policy = resolved.policy;
    }

    const expanded = expandPolicyWithPluginGroups(policy, pluginGroups);
    filtered = expanded ? filterToolsByPolicy(filtered, expanded) : filtered;
  }
  return filtered;
}

function shouldWarnAboutUnknownAllowlist(params: {
  hasGatedCoreEntries: boolean;
  hasOtherEntries: boolean;
}): boolean {
  return params.hasGatedCoreEntries || params.hasOtherEntries;
}

function describeUnknownAllowlistSuffix(params: {
  pluginOnlyAllowlist: boolean;
  hasGatedCoreEntries: boolean;
  hasOtherEntries: boolean;
  unavailableCoreToolReason?: string;
}): string {
  const preface = params.pluginOnlyAllowlist
    ? "Allowlist contains only plugin entries; core tools will not be available."
    : "";
  const unavailableCoreToolReason = params.unavailableCoreToolReason?.trim();
  const unavailableCoreDetail = unavailableCoreToolReason
    ? `These entries are shipped core tools but unavailable here: ${unavailableCoreToolReason}.`
    : "These entries are shipped core tools but unavailable in the current runtime/provider/model/config.";
  const mixedUnavailableCoreDetail = unavailableCoreToolReason
    ? `Some entries are shipped core tools but unavailable here: ${unavailableCoreToolReason}; other entries won't match any tool unless the plugin is enabled.`
    : "Some entries are shipped core tools but unavailable in the current runtime/provider/model/config; other entries won't match any tool unless the plugin is enabled.";
  const detail =
    params.hasGatedCoreEntries && params.hasOtherEntries
      ? mixedUnavailableCoreDetail
      : params.hasGatedCoreEntries
        ? unavailableCoreDetail
        : "These entries won't match any tool unless the plugin is enabled.";
  return preface ? `${preface} ${detail}` : detail;
}

export function resetToolPolicyWarningCacheForTest(): void {
  seenToolPolicyWarnings.clear();
  toolPolicyWarningOrder.length = 0;
}
