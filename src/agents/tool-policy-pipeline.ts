/**
 * Applies layered tool policy in runtime resolution order. Policy diagnostics
 * stay tied to the layer that introduced them, while plugin groups are
 * expanded only after unknown core/plugin entries are classified.
 */
import { filterToolsByPolicy } from "./agent-tools.policy.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { isKnownCoreToolId } from "./tool-catalog.js";
import { auditToolPolicyFilter, type ToolPolicyAuditLogLevel } from "./tool-policy-audit.js";
import {
  analyzeAllowlistByToolType,
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  type DeclaredToolAllowlistContext,
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

/** One named policy layer in the effective runtime tool policy pipeline. */
export type ToolPolicyPipelineStep = {
  policy: ToolPolicyLike | undefined;
  label: string;
  stripPluginOnlyAllowlist?: boolean;
  suppressUnavailableCoreToolWarning?: boolean;
  suppressUnavailableCoreToolWarningAllowlist?: string[];
  unavailableCoreToolReason?: string;
};

/** One policy application, exposed for diagnostics that need exclusion provenance. */
export type ToolPolicyFilterEvent = {
  step: ToolPolicyPipelineStep;
  policy: ToolPolicyLike;
  before: readonly AnyAgentTool[];
  after: readonly AnyAgentTool[];
};

/** Builds the default profile, provider, agent, group, and sender policy layers. */
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

/** Applies configured policy layers to a tool list and emits deduped warnings/audit events. */
export function applyToolPolicyPipeline(params: {
  tools: AnyAgentTool[];
  toolMeta: (tool: AnyAgentTool) => { pluginId: string } | undefined;
  warn: (message: string) => void;
  steps: ToolPolicyPipelineStep[];
  auditLogLevel?: ToolPolicyAuditLogLevel;
  declaredToolAllowlist?: DeclaredToolAllowlistContext;
  onFilter?: (event: ToolPolicyFilterEvent) => void;
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
      // Plugin-only allowlists are valid for deferred tools; warn only for entries that cannot match.
      const resolved = analyzeAllowlistByToolType(
        policy,
        pluginGroups,
        coreToolNames,
        params.declaredToolAllowlist,
      );
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
    if (!expanded) {
      continue;
    }
    const before = filtered;
    filtered = filterToolsByPolicy(before, expanded);
    params.onFilter?.({ step, policy: expanded, before, after: filtered });
    auditToolPolicyFilter({
      stepLabel: step.label,
      policy: expanded,
      before,
      after: filtered,
      logLevel: params.auditLogLevel,
    });
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

/** Clears process-local warning dedupe state between tests. */
function resetToolPolicyWarningCacheForTest(): void {
  seenToolPolicyWarnings.clear();
  toolPolicyWarningOrder.length = 0;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.toolPolicyWarningCacheTestApi")
  ] = { resetToolPolicyWarningCacheForTest };
}
