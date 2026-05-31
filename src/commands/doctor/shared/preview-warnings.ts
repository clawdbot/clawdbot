import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord as hasRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../../../agents/agent-scope-config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { parseModelRef } from "../../../agents/model-selection-normalize.js";
import { pickSandboxToolPolicy } from "../../../agents/sandbox-tool-policy.js";
import {
  isToolAllowedByPolicies,
  isToolAllowedByPolicyName,
} from "../../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../../agents/tool-policy.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AgentToolsConfig, ToolsConfig } from "../../../config/types.tools.js";
import { collectChannelRouteTargets } from "../../../routing/channel-route-targets.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";

type ChannelDoctorModule = typeof import("./channel-doctor.js");

const channelDoctorModuleLoader = createLazyImportLoader<ChannelDoctorModule>(
  () => import("./channel-doctor.js"),
);

function loadChannelDoctorModule(): Promise<ChannelDoctorModule> {
  return channelDoctorModuleLoader.load();
}

function listAgentRecords(cfg: OpenClawConfig): Record<string, unknown>[] {
  return Array.isArray(cfg.agents?.list) ? cfg.agents.list.filter(hasRecord) : [];
}

function hasChannels(cfg: OpenClawConfig): boolean {
  return hasRecord(cfg.channels);
}

function hasPlugins(cfg: OpenClawConfig): boolean {
  return hasRecord(cfg.plugins);
}

function hasPluginLoadPaths(cfg: OpenClawConfig): boolean {
  const plugins = cfg.plugins;
  if (!hasRecord(plugins)) {
    return false;
  }
  const load = plugins.load;
  return hasRecord(load) && Array.isArray(load.paths) && load.paths.length > 0;
}

function hasSubagentAllowlistConfig(cfg: OpenClawConfig): boolean {
  if (Array.isArray(cfg.agents?.defaults?.subagents?.allowAgents)) {
    return true;
  }
  return listAgentRecords(cfg).some((agent) => {
    const subagents = hasRecord(agent.subagents) ? agent.subagents : undefined;
    return Array.isArray(subagents?.allowAgents);
  });
}

function hasExplicitChannelPluginBlockerConfig(cfg: OpenClawConfig): boolean {
  if (cfg.plugins?.enabled === false) {
    return true;
  }
  const entries = cfg.plugins?.entries;
  if (!hasRecord(entries)) {
    return false;
  }
  return Object.values(entries).some(
    (entry) => hasRecord(entry) && "enabled" in entry && entry.enabled === false,
  );
}

function hasToolsBySenderKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasToolsBySenderKey);
  }
  if (!hasRecord(value)) {
    return false;
  }
  if (hasRecord(value.toolsBySender)) {
    return true;
  }
  return Object.entries(value).some(
    ([key, nested]) => key !== "toolsBySender" && hasToolsBySenderKey(nested),
  );
}

function hasConfiguredSafeBins(cfg: OpenClawConfig): boolean {
  const globalExec = cfg.tools?.exec;
  if (
    hasRecord(globalExec) &&
    Array.isArray(globalExec.safeBins) &&
    globalExec.safeBins.length > 0
  ) {
    return true;
  }
  return listAgentRecords(cfg).some((agent) => {
    const agentExec = hasRecord(agent) && hasRecord(agent.tools) ? agent.tools.exec : undefined;
    return (
      hasRecord(agentExec) && Array.isArray(agentExec.safeBins) && agentExec.safeBins.length > 0
    );
  });
}

type VisibleReplyPolicyProvenance = "default" | "global-explicit" | "group-explicit";
type ToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  profile?: string;
};

function normalizeProviderPolicyKey(value: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0) {
    return normalizeProviderId(normalized);
  }
  const provider = normalizeProviderId(normalized.slice(0, slashIndex));
  const modelId = normalized.slice(slashIndex + 1);
  return modelId ? `${provider}/${modelId}` : provider;
}

function isCanonicalProviderPolicyKey(value: string): boolean {
  return normalizeLowercaseStringOrEmpty(value) === normalizeProviderPolicyKey(value);
}

function resolveProviderToolPolicy(params: {
  byProvider?: Record<string, ToolPolicyConfig>;
  modelProvider: string;
  modelId: string;
}): ToolPolicyConfig | undefined {
  if (!params.byProvider) {
    return undefined;
  }
  const lookup = new Map<string, { canonical: boolean; value: ToolPolicyConfig }>();
  for (const [key, value] of Object.entries(params.byProvider)) {
    const normalized = normalizeProviderPolicyKey(key);
    if (!normalized) {
      continue;
    }
    const canonical = isCanonicalProviderPolicyKey(key);
    const existing = lookup.get(normalized);
    if (!existing || (canonical && !existing.canonical)) {
      lookup.set(normalized, { canonical, value });
    }
  }

  const provider = normalizeProviderPolicyKey(params.modelProvider);
  const modelId = normalizeLowercaseStringOrEmpty(params.modelId);
  const fullModelId = modelId ? `${provider}/${modelId}` : undefined;
  return (fullModelId ? lookup.get(fullModelId)?.value : undefined) ?? lookup.get(provider)?.value;
}

function resolveMessageToolAvailability(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  globalTools?: ToolsConfig;
  agentTools?: AgentToolsConfig;
  runtimeAlsoAllow?: string[];
}): boolean {
  const agentConfig = params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  const modelRef = resolvePrimaryModelRef(params.cfg, agentConfig?.model);
  const providerPolicy = resolveProviderToolPolicy({
    byProvider: params.globalTools?.byProvider,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
  });
  const agentProviderPolicy = resolveProviderToolPolicy({
    byProvider: params.agentTools?.byProvider,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
  });
  const profile = params.agentTools?.profile ?? params.globalTools?.profile;
  const configuredAlsoAllow = Array.isArray(params.agentTools?.alsoAllow)
    ? params.agentTools.alsoAllow
    : Array.isArray(params.globalTools?.alsoAllow)
      ? params.globalTools.alsoAllow
      : [];
  const providerAlsoAllow = Array.isArray(agentProviderPolicy?.alsoAllow)
    ? agentProviderPolicy.alsoAllow
    : Array.isArray(providerPolicy?.alsoAllow)
      ? providerPolicy.alsoAllow
      : [];
  const profileAlsoAllow = [...configuredAlsoAllow, ...(params.runtimeAlsoAllow ?? [])];
  const providerProfileAlsoAllow = [...providerAlsoAllow, ...(params.runtimeAlsoAllow ?? [])];
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow);
  const providerProfilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(agentProviderPolicy?.profile ?? providerPolicy?.profile),
    providerProfileAlsoAllow,
  );
  return isToolAllowedByPolicies("message", [
    profilePolicy,
    providerProfilePolicy,
    pickSandboxToolPolicy(providerPolicy),
    pickSandboxToolPolicy(agentProviderPolicy),
    pickSandboxToolPolicy(params.globalTools),
    pickSandboxToolPolicy(params.agentTools),
  ]);
}

const SOURCE_REPLY_RUNTIME_MESSAGE_ALLOW = ["message"];

function resolvePrimaryModelRef(
  cfg: OpenClawConfig,
  agentModel?: NonNullable<ReturnType<typeof resolveAgentConfig>>["model"],
): { provider: string; model: string } {
  const raw =
    resolveAgentModelPrimaryValue(agentModel) ??
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ??
    DEFAULT_MODEL;
  return (
    parseModelRef(raw, DEFAULT_PROVIDER, { allowPluginNormalization: false }) ?? {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    }
  );
}

function resolveSourceReplyMessageToolAvailability(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  globalTools?: ToolsConfig;
  agentTools?: AgentToolsConfig;
}): boolean {
  return resolveMessageToolAvailability({
    ...params,
    runtimeAlsoAllow: SOURCE_REPLY_RUNTIME_MESSAGE_ALLOW,
  });
}

function sourceReplyRuntimeMayAllowMessageTool(cfg: OpenClawConfig): boolean {
  const groupPolicy = resolveGroupVisibleReplyProvenance(cfg);
  if (groupPolicy.value === "message_tool") {
    return true;
  }
  if (cfg.messages?.visibleReplies === "message_tool") {
    return true;
  }
  return false;
}

function collectMessageToolUnavailableTargets(
  cfg: OpenClawConfig,
  options: { sourceReplyRuntimeGrant?: boolean } = {},
): string[] {
  const agents = listAgentRecords(cfg);
  if (agents.length === 0) {
    const available = options.sourceReplyRuntimeGrant
      ? resolveSourceReplyMessageToolAvailability({ cfg, globalTools: cfg.tools })
      : resolveMessageToolAvailability({ cfg, globalTools: cfg.tools });
    return available ? [] : ["default tool policy"];
  }
  return agents.flatMap((agent) => {
    const agentId = typeof agent.id === "string" ? agent.id : "unknown";
    const available = options.sourceReplyRuntimeGrant
      ? resolveSourceReplyMessageToolAvailability({
          cfg,
          agentId,
          globalTools: cfg.tools,
          agentTools: agent.tools as AgentToolsConfig | undefined,
        })
      : resolveMessageToolAvailability({
          cfg,
          agentId,
          globalTools: cfg.tools,
          agentTools: agent.tools as AgentToolsConfig | undefined,
        });
    return available ? [] : [`agent "${agentId}"`];
  });
}

function resolveGroupVisibleReplyProvenance(cfg: OpenClawConfig): {
  path: "messages.groupChat.visibleReplies" | "messages.visibleReplies";
  provenance: VisibleReplyPolicyProvenance;
  value: "automatic" | "message_tool";
} {
  const groupVisibleReplies = cfg.messages?.groupChat?.visibleReplies;
  if (groupVisibleReplies) {
    return {
      path: "messages.groupChat.visibleReplies",
      provenance: "group-explicit",
      value: groupVisibleReplies,
    };
  }
  const globalVisibleReplies = cfg.messages?.visibleReplies;
  if (globalVisibleReplies) {
    return {
      path: "messages.visibleReplies",
      provenance: "global-explicit",
      value: globalVisibleReplies,
    };
  }
  return {
    path: "messages.groupChat.visibleReplies",
    provenance: "default",
    value: "automatic",
  };
}

function formatTargets(targets: string[]): string {
  if (targets.length <= 2) {
    return targets.join(" and ");
  }
  return `${targets.slice(0, 2).join(", ")}, and ${targets.length - 2} more`;
}

export function collectVisibleReplyToolPolicyWarnings(cfg: OpenClawConfig): string[] {
  const groupPolicy = resolveGroupVisibleReplyProvenance(cfg);
  const warnings: string[] = [];
  if (groupPolicy.value === "message_tool") {
    const targets = collectMessageToolUnavailableTargets(cfg, { sourceReplyRuntimeGrant: true });
    if (targets.length === 0) {
      return warnings;
    }
    warnings.push(
      `- ${groupPolicy.path} is set to "message_tool", but the message tool is unavailable for ${formatTargets(
        targets,
      )}; OpenClaw falls back to automatic visible replies, so normal replies may post to the source chat. Enable the message tool or set ${groupPolicy.path} to "automatic".`,
    );
  }

  const globalVisibleReplies = cfg.messages?.visibleReplies;
  if (globalVisibleReplies === "message_tool" && groupPolicy.path !== "messages.visibleReplies") {
    const targets = collectMessageToolUnavailableTargets(cfg, { sourceReplyRuntimeGrant: true });
    if (targets.length === 0) {
      return warnings;
    }
    warnings.push(
      `- messages.visibleReplies is set to "message_tool", but the message tool is unavailable for ${formatTargets(
        targets,
      )}; OpenClaw falls back to automatic direct-chat replies, so normal replies may post to the source chat. Enable the message tool or set messages.visibleReplies to "automatic".`,
    );
  }
  return warnings;
}

function formatChannelList(channels: string[]): string {
  if (channels.length <= 2) {
    return channels.map((channel) => `"${channel}"`).join(" and ");
  }
  return `${channels
    .slice(0, 2)
    .map((channel) => `"${channel}"`)
    .join(", ")}, and ${channels.length - 2} more`;
}

export function collectChannelBoundMessageToolPolicyWarnings(cfg: OpenClawConfig): string[] {
  return collectChannelRouteTargets(cfg).flatMap((target) => {
    const agentTools = resolveAgentConfig(cfg, target.agentId)?.tools;
    const runtimeMayAllowMessage = sourceReplyRuntimeMayAllowMessageTool(cfg);
    const messageToolAvailable = runtimeMayAllowMessage
      ? resolveSourceReplyMessageToolAvailability({
          cfg,
          agentId: target.agentId,
          globalTools: cfg.tools,
          agentTools,
        })
      : resolveMessageToolAvailability({
          cfg,
          agentId: target.agentId,
          globalTools: cfg.tools,
          agentTools,
        });
    if (messageToolAvailable) {
      return [];
    }
    return [
      `- Agent "${target.agentId}" is routed from channel ${formatChannelList(
        target.channels,
      )}, but the message tool is unavailable for that agent; explicit channel actions such as sendAttachment, upload-file, thread-reply, or reply can fail. Add "message" to the agent tool allowlist, add "group:messaging", or switch the agent to a profile that includes messaging tools.`,
    ];
  });
}

const PROFILE_CONFIGURED_TOOL_SECTIONS = [
  { key: "exec", label: "tools.exec", grants: ["exec", "process"] },
  { key: "fs", label: "tools.fs", grants: ["read", "write", "edit"] },
] as const;

type ConfiguredToolSectionGrantEntry = {
  label: string;
  grants: string[];
};

function collectConfiguredToolSectionGrantEntries(params: {
  tools?: Record<string, unknown> | null;
  pathLabel: string;
}): ConfiguredToolSectionGrantEntry[] {
  const entries: ConfiguredToolSectionGrantEntry[] = [];
  for (const section of PROFILE_CONFIGURED_TOOL_SECTIONS) {
    if (hasRecord(params.tools?.[section.key])) {
      entries.push({
        label: `${params.pathLabel}.${section.key}`,
        grants: [...section.grants],
      });
    }
  }
  return entries;
}

function formatQuotedList(values: string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function hasNonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.some((entry) => typeof entry === "string");
}

function readPreviewStringList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function formatProfileConfiguredSectionGrantAdvice(params: {
  pathLabel: string;
  grants: string[];
  hasAllow: boolean;
  provider?: boolean;
}): string {
  const providerSuffix = params.provider ? " for that provider" : "";
  if (params.hasAllow) {
    return `Add these grants to ${params.pathLabel}.allow and set ${params.pathLabel}.profile to "full" if these tools should be available${providerSuffix}.`;
  }
  return `Add ${params.pathLabel}.alsoAllow: [${formatQuotedList(
    params.grants,
  )}] if these tools should be available${providerSuffix}.`;
}

function collectProfileConfiguredToolSectionScopeWarnings(params: {
  tools?: Record<string, unknown> | null;
  inheritedTools?: Record<string, unknown> | null;
  pathLabel: string;
  inheritedPathLabel?: string;
  includeInheritedSections?: boolean;
  inheritedProfile?: string;
  inheritedAlsoAllow?: string[];
}): string[] {
  const tools = params.tools;
  const profile =
    (typeof tools?.profile === "string" ? tools.profile : undefined) ?? params.inheritedProfile;
  if (!profile) {
    return [];
  }
  const configuredEntries = [
    ...(params.includeInheritedSections && params.inheritedTools && params.inheritedPathLabel
      ? collectConfiguredToolSectionGrantEntries({
          tools: params.inheritedTools,
          pathLabel: params.inheritedPathLabel,
        })
      : []),
    ...collectConfiguredToolSectionGrantEntries({ tools, pathLabel: params.pathLabel }),
  ];
  if (configuredEntries.length === 0) {
    return [];
  }
  const alsoAllow = Array.isArray(tools?.alsoAllow)
    ? tools.alsoAllow.filter((entry): entry is string => typeof entry === "string")
    : params.inheritedAlsoAllow;
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), alsoAllow);
  const uncoveredEntries = configuredEntries
    .map((entry) => {
      const grants = entry.grants.filter(
        (toolName) => !isToolAllowedByPolicyName(toolName, profilePolicy),
      );
      return { grants, label: entry.label };
    })
    .filter((entry) => entry.grants.length > 0);
  if (uncoveredEntries.length === 0) {
    return [];
  }
  const uncoveredGrants = [...new Set(uncoveredEntries.flatMap((entry) => entry.grants))];
  const advice = formatProfileConfiguredSectionGrantAdvice({
    pathLabel: params.pathLabel,
    grants: uncoveredGrants,
    hasAllow: hasNonEmptyStringList(tools?.allow),
  });
  return [
    `- ${params.pathLabel}.profile is "${profile}" and ${uncoveredEntries
      .map((entry) => entry.label)
      .join(
        " / ",
      )} is configured, but configured sections no longer widen the active profile. ${advice}`,
  ];
}

function collectByProviderConfiguredToolSectionWarnings(params: {
  tools?: Record<string, unknown> | null;
  inheritedTools?: Record<string, unknown> | null;
  pathLabel: string;
  configuredEntries: ConfiguredToolSectionGrantEntry[];
}): string[] {
  const byProvider = hasRecord(params.tools?.byProvider) ? params.tools.byProvider : undefined;
  if (!byProvider || params.configuredEntries.length === 0) {
    return [];
  }
  const inheritedByProvider = hasRecord(params.inheritedTools?.byProvider)
    ? params.inheritedTools.byProvider
    : undefined;
  return Object.entries(byProvider).flatMap(([providerKey, policyValue]) => {
    const policy = hasRecord(policyValue) ? policyValue : undefined;
    if (!policy) {
      return [];
    }
    const profile = typeof policy.profile === "string" ? policy.profile : undefined;
    if (!profile) {
      return [];
    }
    const inheritedPolicy = resolveInheritedProviderPolicyForPreview(
      inheritedByProvider,
      providerKey,
    );
    const alsoAllow =
      readPreviewStringList(policy.alsoAllow) ?? readPreviewStringList(inheritedPolicy?.alsoAllow);
    const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), alsoAllow);
    const uncoveredEntries = params.configuredEntries
      .map((entry) => ({
        ...entry,
        grants: entry.grants.filter(
          (toolName) => !isToolAllowedByPolicyName(toolName, profilePolicy),
        ),
      }))
      .filter((entry) => entry.grants.length > 0);
    if (uncoveredEntries.length === 0) {
      return [];
    }
    const providerPath = `${params.pathLabel}.byProvider.${providerKey}`;
    const uncoveredGrants = [...new Set(uncoveredEntries.flatMap((entry) => entry.grants))];
    const advice = formatProfileConfiguredSectionGrantAdvice({
      pathLabel: providerPath,
      grants: uncoveredGrants,
      hasAllow: hasNonEmptyStringList(policy.allow),
      provider: true,
    });
    return [
      `- ${providerPath}.profile is "${profile}" and ${uncoveredEntries
        .map((entry) => entry.label)
        .join(
          " / ",
        )} is configured, but configured sections no longer widen the provider profile. ${advice}`,
    ];
  });
}

function resolveInheritedProviderPolicyForPreview(
  inheritedByProvider: Record<string, unknown> | undefined,
  providerKey: string,
): ToolPolicyConfig | undefined {
  if (!inheritedByProvider) {
    return undefined;
  }
  const normalized = normalizeProviderPolicyKey(providerKey);
  const slashIndex = normalized.indexOf("/");
  const modelProvider = slashIndex > 0 ? normalized.slice(0, slashIndex) : normalized;
  const modelId = slashIndex > 0 ? normalized.slice(slashIndex + 1) : "";
  const policy = resolveProviderToolPolicy({
    byProvider: inheritedByProvider as Record<string, ToolPolicyConfig>,
    modelProvider,
    modelId,
  });
  return policy && hasRecord(policy) ? policy : undefined;
}

function resolveProviderPolicyEntryForPreview(params: {
  byProvider?: Record<string, unknown>;
  modelProvider?: string;
  modelId?: string;
}): { key: string; policy: Record<string, unknown> } | undefined {
  if (!params.byProvider || !params.modelProvider) {
    return undefined;
  }
  const lookup = new Map<
    string,
    { key: string; policy: Record<string, unknown>; canonical: boolean }
  >();
  for (const [key, value] of Object.entries(params.byProvider)) {
    const policy = hasRecord(value) ? value : undefined;
    if (!policy) {
      continue;
    }
    const normalized = normalizeProviderPolicyKey(key);
    if (!normalized) {
      continue;
    }
    const canonical = isCanonicalProviderPolicyKey(key);
    const existing = lookup.get(normalized);
    if (!existing || (canonical && !existing.canonical)) {
      lookup.set(normalized, { key, policy, canonical });
    }
  }
  const provider = normalizeProviderPolicyKey(params.modelProvider);
  const modelId = normalizeLowercaseStringOrEmpty(params.modelId);
  const candidates = [...(modelId ? [`${provider}/${modelId}`] : []), provider];
  for (const candidate of candidates) {
    const match = lookup.get(candidate);
    if (match) {
      return { key: match.key, policy: match.policy };
    }
  }
  return undefined;
}

function collectInheritedByProviderConfiguredToolSectionWarnings(params: {
  inheritedTools?: Record<string, unknown> | null;
  inheritedPathLabel: string;
  overridingTools?: Record<string, unknown> | null;
  overridingPathLabel: string;
  configuredEntries: ConfiguredToolSectionGrantEntry[];
  modelProvider?: string;
  modelId?: string;
}): string[] {
  const inheritedByProvider = hasRecord(params.inheritedTools?.byProvider)
    ? params.inheritedTools.byProvider
    : undefined;
  if (!inheritedByProvider || params.configuredEntries.length === 0) {
    return [];
  }
  const overridingByProvider = hasRecord(params.overridingTools?.byProvider)
    ? params.overridingTools.byProvider
    : undefined;
  const inheritedEntryForModel = resolveProviderPolicyEntryForPreview({
    byProvider: inheritedByProvider,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  return Object.entries(inheritedByProvider).flatMap(([providerKey, policyValue]) => {
    if (params.modelProvider && inheritedEntryForModel?.key !== providerKey) {
      return [];
    }
    const inheritedPolicy = hasRecord(policyValue) ? policyValue : undefined;
    if (!inheritedPolicy) {
      return [];
    }
    const profile =
      typeof inheritedPolicy.profile === "string" ? inheritedPolicy.profile : undefined;
    if (!profile) {
      return [];
    }
    const overridingEntry =
      resolveProviderPolicyEntryForPreview({
        byProvider: overridingByProvider,
        modelProvider: params.modelProvider,
        modelId: params.modelId,
      }) ??
      (hasRecord(overridingByProvider?.[providerKey])
        ? { key: providerKey, policy: overridingByProvider[providerKey] }
        : undefined);
    const overridingPolicy = overridingEntry?.policy;
    if (typeof overridingPolicy?.profile === "string") {
      return [];
    }
    const alsoAllow =
      readPreviewStringList(overridingPolicy?.alsoAllow) ??
      readPreviewStringList(inheritedPolicy.alsoAllow);
    const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), alsoAllow);
    const uncoveredEntries = params.configuredEntries
      .map((entry) => ({
        ...entry,
        grants: entry.grants.filter(
          (toolName) => !isToolAllowedByPolicyName(toolName, profilePolicy),
        ),
      }))
      .filter((entry) => entry.grants.length > 0);
    if (uncoveredEntries.length === 0) {
      return [];
    }
    const overridePath = `${params.overridingPathLabel}.byProvider.${
      overridingEntry?.key ?? providerKey
    }`;
    const inheritedPath = `${params.inheritedPathLabel}.byProvider.${providerKey}`;
    const uncoveredGrants = [...new Set(uncoveredEntries.flatMap((entry) => entry.grants))];
    const advice = formatProfileConfiguredSectionGrantAdvice({
      pathLabel: overridePath,
      grants: uncoveredGrants,
      hasAllow: hasNonEmptyStringList(overridingPolicy?.allow),
      provider: true,
    });
    return [
      `- ${inheritedPath}.profile is "${profile}" and ${uncoveredEntries
        .map((entry) => entry.label)
        .join(
          " / ",
        )} is configured, but configured sections no longer widen the inherited provider profile. ${advice}`,
    ];
  });
}

export function collectProfileConfiguredToolSectionWarnings(cfg: OpenClawConfig): string[] {
  const warnings: string[] = [];
  const globalTools = hasRecord(cfg.tools) ? cfg.tools : undefined;
  const globalAlsoAllow = Array.isArray(globalTools?.alsoAllow)
    ? globalTools.alsoAllow.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const globalProfile = typeof globalTools?.profile === "string" ? globalTools.profile : undefined;
  const globalConfiguredEntries = collectConfiguredToolSectionGrantEntries({
    tools: globalTools,
    pathLabel: "tools",
  });

  warnings.push(
    ...collectProfileConfiguredToolSectionScopeWarnings({
      tools: globalTools,
      pathLabel: "tools",
    }),
    ...collectByProviderConfiguredToolSectionWarnings({
      tools: globalTools,
      pathLabel: "tools",
      configuredEntries: globalConfiguredEntries,
    }),
  );

  listAgentRecords(cfg).forEach((agent, index) => {
    const agentTools = hasRecord(agent.tools) ? agent.tools : undefined;
    const agentId = typeof agent.id === "string" ? agent.id : undefined;
    const agentConfig = agentId ? resolveAgentConfig(cfg, agentId) : undefined;
    const modelRef = resolvePrimaryModelRef(cfg, agentConfig?.model);
    const agentPath = `agents.list[${index}].tools`;
    const includeInheritedSections =
      agentTools !== undefined && typeof agentTools.profile !== "string";
    const ownAgentConfiguredEntries = collectConfiguredToolSectionGrantEntries({
      tools: agentTools,
      pathLabel: agentPath,
    });
    const agentConfiguredEntries = [...globalConfiguredEntries, ...ownAgentConfiguredEntries];
    warnings.push(
      ...collectProfileConfiguredToolSectionScopeWarnings({
        tools: agentTools,
        inheritedTools: globalTools,
        pathLabel: agentPath,
        inheritedPathLabel: "tools",
        includeInheritedSections,
        inheritedProfile: globalProfile,
        inheritedAlsoAllow: globalAlsoAllow,
      }),
      ...collectByProviderConfiguredToolSectionWarnings({
        tools: agentTools,
        inheritedTools: globalTools,
        pathLabel: agentPath,
        configuredEntries: agentConfiguredEntries,
      }),
      ...collectInheritedByProviderConfiguredToolSectionWarnings({
        inheritedTools: globalTools,
        inheritedPathLabel: "tools",
        overridingTools: agentTools,
        overridingPathLabel: agentPath,
        configuredEntries: ownAgentConfiguredEntries,
        modelProvider: modelRef.provider,
        modelId: modelRef.model,
      }),
    );
  });
  return warnings;
}

export type DoctorPreviewNotes = {
  infoNotes: string[];
  warningNotes: string[];
};

export async function collectDoctorPreviewNotes(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DoctorPreviewNotes> {
  const infoNotes: string[] = [];
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const hasChannelConfig = hasChannels(params.cfg);
  const hasPluginConfig = hasPlugins(params.cfg);

  warnings.push(...collectVisibleReplyToolPolicyWarnings(params.cfg));
  warnings.push(...collectChannelBoundMessageToolPolicyWarnings(params.cfg));
  warnings.push(...collectProfileConfiguredToolSectionWarnings(params.cfg));

  const { collectActiveToolSchemaProjectionWarnings } =
    await import("./active-tool-schema-warnings.js");
  warnings.push(...collectActiveToolSchemaProjectionWarnings({ cfg: params.cfg, env }));

  const channelPluginRuntime =
    hasChannelConfig && hasExplicitChannelPluginBlockerConfig(params.cfg)
      ? await import("./channel-plugin-blockers.js")
      : undefined;
  const channelPluginBlockerHits =
    channelPluginRuntime?.scanConfiguredChannelPluginBlockers(params.cfg, env) ?? [];
  if (channelPluginRuntime && channelPluginBlockerHits.length > 0) {
    warnings.push(
      channelPluginRuntime
        .collectConfiguredChannelPluginBlockerWarnings(channelPluginBlockerHits)
        .join("\n"),
    );
  }

  if (hasChannelConfig) {
    const { collectChannelDoctorPreviewWarnings } = await loadChannelDoctorModule();
    const channelDoctorWarnings = await collectChannelDoctorPreviewWarnings({
      cfg: params.cfg,
      doctorFixCommand: params.doctorFixCommand,
      env,
    });
    if (channelDoctorWarnings.length > 0) {
      warnings.push(...channelDoctorWarnings);
    }

    const { collectOpenPolicyAllowFromWarnings, maybeRepairOpenPolicyAllowFrom } =
      await import("./open-policy-allowfrom.js");
    const allowFromScan = maybeRepairOpenPolicyAllowFrom(params.cfg);
    if (allowFromScan.changes.length > 0) {
      warnings.push(
        collectOpenPolicyAllowFromWarnings({
          changes: allowFromScan.changes,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }
  }

  if ((hasPluginConfig || hasChannelConfig) && params.cfg.plugins?.enabled !== false) {
    const {
      collectStalePluginConfigWarnings,
      isStalePluginAutoRepairBlocked,
      scanStalePluginConfig,
    } = await import("./stale-plugin-config.js");
    const stalePluginHits = scanStalePluginConfig(params.cfg, env);
    if (stalePluginHits.length > 0) {
      warnings.push(
        collectStalePluginConfigWarnings({
          hits: stalePluginHits,
          doctorFixCommand: params.doctorFixCommand,
          autoRepairBlocked: isStalePluginAutoRepairBlocked(params.cfg, env),
        }).join("\n"),
      );
    }
  }

  if (hasPluginConfig) {
    const { collectCodexRouteWarnings } = await import("./codex-route-warnings.js");
    warnings.push(...collectCodexRouteWarnings({ cfg: params.cfg, env }));

    const { collectContextEngineHostCompatibilityWarnings } =
      await import("./context-engine-host-compat.js");
    warnings.push(
      ...(await collectContextEngineHostCompatibilityWarnings({
        cfg: params.cfg,
        doctorFixCommand: params.doctorFixCommand,
        env,
      })),
    );
  }
  if (hasSubagentAllowlistConfig(params.cfg)) {
    const { collectStaleSubagentAllowlistWarnings, scanStaleSubagentAllowlistReferences } =
      await import("./stale-subagent-allowlist.js");
    const staleSubagentAllowlistHits = scanStaleSubagentAllowlistReferences(params.cfg);
    if (staleSubagentAllowlistHits.length > 0) {
      warnings.push(
        collectStaleSubagentAllowlistWarnings({
          hits: staleSubagentAllowlistHits,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }
  }
  const { collectCodexNativeAssetInfoNotes } = await import("./codex-native-assets.js");
  infoNotes.push(...(await collectCodexNativeAssetInfoNotes({ cfg: params.cfg, env })));

  if (hasPluginLoadPaths(params.cfg)) {
    const { collectBundledPluginLoadPathWarnings, scanBundledPluginLoadPathMigrations } =
      await import("./bundled-plugin-load-paths.js");
    const bundledPluginLoadPathHits = scanBundledPluginLoadPathMigrations(params.cfg, env);
    if (bundledPluginLoadPathHits.length > 0) {
      warnings.push(
        collectBundledPluginLoadPathWarnings({
          hits: bundledPluginLoadPathHits,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }
  }

  if (hasChannelConfig) {
    const { createChannelDoctorEmptyAllowlistPolicyHooks } = await loadChannelDoctorModule();
    const { scanEmptyAllowlistPolicyWarnings } = await import("./empty-allowlist-scan.js");
    const emptyAllowlistHooks = createChannelDoctorEmptyAllowlistPolicyHooks({
      cfg: params.cfg,
      env,
    });
    const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(params.cfg, {
      doctorFixCommand: params.doctorFixCommand,
      extraWarningsForAccount: emptyAllowlistHooks.extraWarningsForAccount,
      shouldSkipDefaultEmptyGroupAllowlistWarning:
        emptyAllowlistHooks.shouldSkipDefaultEmptyGroupAllowlistWarning,
    }).filter(
      (warning) =>
        !(
          channelPluginRuntime?.isWarningBlockedByChannelPlugin(
            warning,
            channelPluginBlockerHits,
          ) ?? false
        ),
    );
    if (emptyAllowlistWarnings.length > 0) {
      const { sanitizeForLog } = await import("../../../../packages/terminal-core/src/ansi.js");
      warnings.push(emptyAllowlistWarnings.map((line) => sanitizeForLog(line)).join("\n"));
    }
  }

  if (hasToolsBySenderKey(params.cfg)) {
    const { collectLegacyToolsBySenderWarnings, scanLegacyToolsBySenderKeys } =
      await import("./legacy-tools-by-sender.js");
    const toolsBySenderHits = scanLegacyToolsBySenderKeys(params.cfg);
    if (toolsBySenderHits.length > 0) {
      warnings.push(
        collectLegacyToolsBySenderWarnings({
          hits: toolsBySenderHits,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }
  }

  if (hasConfiguredSafeBins(params.cfg)) {
    const {
      collectExecSafeBinCoverageWarnings,
      collectExecSafeBinTrustedDirHintWarnings,
      scanExecSafeBinCoverage,
      scanExecSafeBinTrustedDirHints,
    } = await import("./exec-safe-bins.js");
    const safeBinCoverage = scanExecSafeBinCoverage(params.cfg);
    if (safeBinCoverage.length > 0) {
      warnings.push(
        collectExecSafeBinCoverageWarnings({
          hits: safeBinCoverage,
          doctorFixCommand: params.doctorFixCommand,
        }).join("\n"),
      );
    }

    const safeBinTrustedDirHints = scanExecSafeBinTrustedDirHints(params.cfg);
    if (safeBinTrustedDirHints.length > 0) {
      warnings.push(collectExecSafeBinTrustedDirHintWarnings(safeBinTrustedDirHints).join("\n"));
    }
  }

  const { collectStaleOAuthProfileShadowWarnings, scanStaleOAuthProfileShadows } =
    await import("./stale-oauth-profile-shadows.js");
  const staleOAuthProfileShadows = await scanStaleOAuthProfileShadows({
    cfg: params.cfg,
    env,
  });
  if (staleOAuthProfileShadows.length > 0) {
    warnings.push(
      collectStaleOAuthProfileShadowWarnings({
        hits: staleOAuthProfileShadows,
        doctorFixCommand: params.doctorFixCommand,
      }).join("\n"),
    );
  }

  return { infoNotes, warningNotes: warnings };
}

export async function collectDoctorPreviewWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  return (await collectDoctorPreviewNotes(params)).warningNotes;
}
