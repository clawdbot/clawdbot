// Skill Workshop diagnostics explain which effective policy layer hides its agent tool.
import { listAgentEntriesWithSource, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  resolveConversationCapabilityProfile,
  type ResolvedConversationCapabilityProfile,
} from "../../agents/conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "../../agents/embedded-agent-runner/effective-tool-policy.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { resolveProviderToolPolicyEntry } from "../../agents/provider-tool-policy.js";
import { isToolAllowedByPolicyName } from "../../agents/tool-policy-match.js";
import type { ToolPolicyFilterEvent } from "../../agents/tool-policy-pipeline.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentToolsConfig } from "../../config/types.tools.js";
import { normalizeAgentId } from "../../routing/session-key.js";

const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

type SkillWorkshopToolPolicyDiagnostic = {
  agentId: string;
  source: string;
  detail: string;
  fix: string;
  message: string;
};

type AgentToolsLocation = {
  path: string;
  tools: AgentToolsConfig;
};

function findAgentTools(config: OpenClawConfig, agentId: string): AgentToolsLocation | undefined {
  const listed = listAgentEntriesWithSource(config).find(
    ({ entry }) => normalizeAgentId(entry.id) === normalizeAgentId(agentId),
  );
  if (!listed?.entry.tools) {
    return undefined;
  }
  const path =
    listed.source.kind === "entries"
      ? `agents.entries.${listed.source.key}.tools`
      : `agents.list[${listed.source.index}].tools`;
  return { path, tools: listed.entry.tools };
}

function providerPolicyPath(params: {
  tools: AgentToolsConfig | OpenClawConfig["tools"] | undefined;
  basePath: string;
  capabilityProfile: ResolvedConversationCapabilityProfile;
}): { path: string; profile?: string; ownsAlsoAllow: boolean } | undefined {
  const entry = resolveProviderToolPolicyEntry({
    byProvider: params.tools?.byProvider,
    modelProvider: params.capabilityProfile.model.provider,
    modelId: params.capabilityProfile.model.id,
  });
  return entry
    ? {
        path: `${params.basePath}.byProvider[${JSON.stringify(entry.key)}]`,
        profile: entry.policy.profile,
        ownsAlsoAllow: Array.isArray(entry.policy.alsoAllow),
      }
    : undefined;
}

function profileAlsoAllowPath(params: {
  config: OpenClawConfig;
  agent: AgentToolsLocation | undefined;
  profileOwnerPath: string;
}): string {
  if (Array.isArray(params.agent?.tools.alsoAllow)) {
    return `${params.agent.path}.alsoAllow`;
  }
  if (Array.isArray(params.config.tools?.alsoAllow)) {
    return "tools.alsoAllow";
  }
  return `${params.profileOwnerPath}.alsoAllow`;
}

function providerProfileAlsoAllowPath(params: {
  globalProvider: ReturnType<typeof providerPolicyPath>;
  agentProvider: ReturnType<typeof providerPolicyPath>;
  profileOwnerPath: string;
}): string {
  if (params.agentProvider?.ownsAlsoAllow) {
    return `${params.agentProvider.path}.alsoAllow`;
  }
  if (params.globalProvider?.ownsAlsoAllow) {
    return `${params.globalProvider.path}.alsoAllow`;
  }
  return `${params.profileOwnerPath}.alsoAllow`;
}

function policyDeniesWorkshop(event: ToolPolicyFilterEvent): boolean {
  return !isToolAllowedByPolicyName(SKILL_WORKSHOP_TOOL_NAME, {
    deny: event.policy.deny,
  });
}

function describeExclusion(params: {
  config: OpenClawConfig;
  agentId: string;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  event: ToolPolicyFilterEvent;
}): Pick<SkillWorkshopToolPolicyDiagnostic, "source" | "detail" | "fix"> {
  const label = params.event.step.label;
  const agent = findAgentTools(params.config, params.agentId);
  const globalProvider = providerPolicyPath({
    tools: params.config.tools,
    basePath: "tools",
    capabilityProfile: params.capabilityProfile,
  });
  const agentProvider = providerPolicyPath({
    tools: agent?.tools,
    basePath: agent?.path ?? "agents.list[].tools",
    capabilityProfile: params.capabilityProfile,
  });

  if (label.startsWith("tools.profile")) {
    const policyPath = agent?.tools.profile ? agent.path : "tools";
    const source = `${policyPath}.profile`;
    const grant = profileAlsoAllowPath({
      config: params.config,
      agent,
      profileOwnerPath: policyPath,
    });
    return {
      source,
      detail: `${source}: ${JSON.stringify(params.capabilityProfile.policy.profile ?? "unknown")} does not include ${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)}.`,
      fix: `Add ${grant}: [${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)}].`,
    };
  }

  if (label.startsWith("tools.byProvider.profile")) {
    const policyPath = agentProvider?.profile ? agentProvider.path : globalProvider?.path;
    const source = policyPath ? `${policyPath}.profile` : "tools.byProvider.profile";
    const grant = policyPath
      ? providerProfileAlsoAllowPath({
          globalProvider,
          agentProvider,
          profileOwnerPath: policyPath,
        })
      : "the matching tools.byProvider alsoAllow";
    return {
      source,
      detail: `${source}: ${JSON.stringify(params.capabilityProfile.policy.providerProfile ?? "unknown")} does not include ${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)}.`,
      fix: policyPath
        ? `Add ${grant}: [${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)}].`
        : `Add ${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)} to ${grant} list.`,
    };
  }

  const normalizedLabel = label.startsWith(`agents.${params.agentId}.tools.byProvider`)
    ? label.replace(
        `agents.${params.agentId}.tools.byProvider`,
        agentProvider?.path ?? `${agent?.path ?? "agents.list[].tools"}.byProvider`,
      )
    : label.startsWith("tools.byProvider")
      ? label.replace("tools.byProvider", globalProvider?.path ?? "tools.byProvider")
      : label
          .replace(`agents.${params.agentId}.tools`, agent?.path ?? "agents.list[].tools")
          .replace("agent tools", agent?.path ?? "agents.list[].tools");
  if (policyDeniesWorkshop(params.event)) {
    const source = normalizedLabel.replace(/\.allow$/, ".deny");
    return {
      source,
      detail: `${source} denies ${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)}.`,
      fix: `Remove the matching ${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)} deny entry from ${source}.`,
    };
  }
  return {
    source: normalizedLabel,
    detail: `${normalizedLabel} does not include ${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)}.`,
    fix: `Add ${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)} to ${normalizedLabel}.`,
  };
}

type SkillWorkshopToolPolicyAvailability = {
  available: boolean;
  exclusion?: ToolPolicyFilterEvent;
};

function makeSkillWorkshopPolicyProbe(): AnyAgentTool {
  return {
    name: SKILL_WORKSHOP_TOOL_NAME,
    label: SKILL_WORKSHOP_TOOL_NAME,
    description: "Skill Workshop policy availability probe.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  } as AnyAgentTool;
}

/** Applies the real final tool-policy composition used by agent sessions and /learn. */
export function resolveSkillWorkshopToolPolicyAvailability(params: {
  config: OpenClawConfig;
  conversationCapabilityProfile: ResolvedConversationCapabilityProfile;
}): SkillWorkshopToolPolicyAvailability {
  let exclusion: ToolPolicyFilterEvent | undefined;
  const tools = applyFinalEffectiveToolPolicy({
    bundledTools: [makeSkillWorkshopPolicyProbe()],
    config: params.config,
    conversationCapabilityProfile: params.conversationCapabilityProfile,
    warn: () => {},
    toolPolicyAuditLogLevel: "debug",
    onFilter: (event) => {
      if (
        !exclusion &&
        event.before.some((tool) => tool.name === SKILL_WORKSHOP_TOOL_NAME) &&
        !event.after.some((tool) => tool.name === SKILL_WORKSHOP_TOOL_NAME)
      ) {
        exclusion = event;
      }
    },
  });
  return {
    available: tools.some((tool) => tool.name === SKILL_WORKSHOP_TOOL_NAME),
    ...(exclusion ? { exclusion } : {}),
  };
}

/** Returns an actionable diagnostic when an active Workshop tool is policy-hidden. */
export function detectSkillWorkshopToolPolicyDiagnostic(params: {
  config: OpenClawConfig;
  workshopEnabled: boolean;
  agentId?: string;
}): SkillWorkshopToolPolicyDiagnostic | null {
  if (!params.workshopEnabled) {
    return null;
  }
  const agentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(params.config));
  const model = resolveDefaultModelForAgent({ cfg: params.config, agentId });
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: params.config,
    agentId,
    modelProvider: model.provider,
    modelId: model.model,
  });
  const availability = resolveSkillWorkshopToolPolicyAvailability({
    config: params.config,
    conversationCapabilityProfile: capabilityProfile,
  });
  if (availability.available || !availability.exclusion) {
    return null;
  }
  const explanation = describeExclusion({
    config: params.config,
    agentId,
    capabilityProfile,
    event: availability.exclusion,
  });
  const prefix = `Skill Workshop is active, but ${JSON.stringify(SKILL_WORKSHOP_TOOL_NAME)} is hidden for agent ${JSON.stringify(agentId)}:`;
  return {
    agentId,
    ...explanation,
    message: `${prefix} ${explanation.detail} ${explanation.fix}`,
  };
}
