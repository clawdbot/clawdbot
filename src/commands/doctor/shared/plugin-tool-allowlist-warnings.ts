import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord as hasRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  sortUniqueStrings,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { sanitizeServerName, TOOL_NAME_SEPARATOR } from "../../../agents/agent-bundle-mcp-names.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../../../agents/glob-pattern.js";
import { parseModelRef } from "../../../agents/model-selection-normalize.js";
import {
  mergeAlsoAllowPolicy,
  normalizeToolName,
  resolveToolProfilePolicy,
} from "../../../agents/tool-policy.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { AgentModelConfig } from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizePluginId } from "../../../plugins/config-state.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";

type ToolAllowlistSource = {
  label: string;
  entries: string[];
};

type ActiveSandboxToolPolicy = {
  labels: string[];
  dedupeKey: string;
  policy: Record<string, unknown>;
  nonSandboxToolPolicyBlocksMcp: boolean;
};

type PickedSandboxToolPolicyField = {
  value: unknown;
  label?: string;
  defined: boolean;
};

type ToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  profile?: string;
  byProvider?: unknown;
};

function normalizePluginIdMaybe(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? normalizePluginId(value) : undefined;
}

function collectListSource(params: { out: ToolAllowlistSource[]; value: unknown; label: string }) {
  if (!Array.isArray(params.value)) {
    return;
  }
  const entries = params.value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > 0) {
    params.out.push({ label: params.label, entries });
  }
}

function collectToolPolicySources(policy: unknown, label: string, out: ToolAllowlistSource[]) {
  if (!hasRecord(policy)) {
    return;
  }
  collectListSource({ out, value: policy.allow, label: `${label}.allow` });
  collectListSource({ out, value: policy.alsoAllow, label: `${label}.alsoAllow` });

  if (hasRecord(policy.byProvider)) {
    for (const [providerId, providerPolicy] of Object.entries(policy.byProvider)) {
      collectToolPolicySources(providerPolicy, `${label}.byProvider.${providerId}`, out);
    }
  }

  const sandboxTools = hasRecord(policy.sandbox) ? policy.sandbox.tools : undefined;
  collectToolPolicySources(sandboxTools, `${label}.sandbox.tools`, out);

  const subagentTools = hasRecord(policy.subagents) ? policy.subagents.tools : undefined;
  collectToolPolicySources(subagentTools, `${label}.subagents.tools`, out);
}

function collectToolAllowlistSources(cfg: OpenClawConfig): ToolAllowlistSource[] {
  const sources: ToolAllowlistSource[] = [];
  collectToolPolicySources(cfg.tools, "tools", sources);
  const agentList = cfg.agents?.list;
  if (Array.isArray(agentList)) {
    agentList.forEach((agent, index) => {
      if (!hasRecord(agent)) {
        return;
      }
      collectToolPolicySources(agent.tools, `agents.list[${index}].tools`, sources);
    });
  }
  return sources;
}

function collectSortedSourceLabels(labels: Iterable<string>): string[] {
  return sortUniqueStrings(labels);
}

function formatSortedSourceLabels(sorted: readonly string[]): string {
  if (sorted.length <= 3) {
    return sorted.join(", ");
  }
  return `${sorted.slice(0, 3).join(", ")} (+${sorted.length - 3} more)`;
}

function formatSourceLabels(labels: Iterable<string>): string {
  return formatSortedSourceLabels(collectSortedSourceLabels(labels));
}

function formatSourceLabelSubject(labels: Iterable<string>): { text: string; verb: "does" | "do" } {
  const sorted = collectSortedSourceLabels(labels);
  return {
    text: formatSortedSourceLabels(sorted),
    verb: sorted.length === 1 ? "does" : "do",
  };
}

function collectToolOwners(registry: PluginManifestRegistry): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const plugin of registry.plugins) {
    const pluginId = normalizePluginId(plugin.id);
    for (const toolNameRaw of plugin.contracts?.tools ?? []) {
      const toolName = normalizeToolName(toolNameRaw);
      if (!toolName) {
        continue;
      }
      owners.set(toolName, [...(owners.get(toolName) ?? []), pluginId]);
    }
  }
  return owners;
}

function collectKnownPluginIds(registry: PluginManifestRegistry): Set<string> {
  return new Set(registry.plugins.map((plugin) => normalizePluginId(plugin.id)));
}

function collectConfiguredMcpServerNames(cfg: OpenClawConfig): string[] {
  const servers = cfg.mcp?.servers;
  if (!hasRecord(servers)) {
    return [];
  }
  return Object.entries(servers)
    .filter(([, value]) => hasRecord(value))
    .map(([name]) => name.trim())
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function normalizeProviderKey(value: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0) {
    return normalizeProviderId(normalized);
  }
  const provider = normalizeProviderId(normalized.slice(0, slashIndex));
  const modelId = normalized.slice(slashIndex + 1);
  return modelId ? `${provider}/${modelId}` : provider;
}

function isCanonicalProviderKey(value: string): boolean {
  return normalizeLowercaseStringOrEmpty(value) === normalizeProviderKey(value);
}

function asToolPolicyConfig(value: unknown): ToolPolicyConfig | undefined {
  return hasRecord(value) ? (value as ToolPolicyConfig) : undefined;
}

function resolveProviderToolPolicy(params: {
  byProvider: unknown;
  modelProvider: string;
  modelId: string;
}): ToolPolicyConfig | undefined {
  if (!hasRecord(params.byProvider)) {
    return undefined;
  }
  const provider = normalizeProviderId(params.modelProvider);
  const modelId = normalizeLowercaseStringOrEmpty(params.modelId);
  const providerModel = modelId ? `${provider}/${modelId}` : undefined;
  const lookup = new Map<string, { canonical: boolean; policy: ToolPolicyConfig }>();
  for (const [key, value] of Object.entries(params.byProvider)) {
    const normalizedKey = normalizeProviderKey(key);
    const policy = asToolPolicyConfig(value);
    if (normalizedKey && policy) {
      const canonical = isCanonicalProviderKey(key);
      const existing = lookup.get(normalizedKey);
      if (!existing || (canonical && !existing.canonical)) {
        lookup.set(normalizedKey, { canonical, policy });
      }
    }
  }
  return (
    (providerModel ? lookup.get(providerModel)?.policy : undefined) ?? lookup.get(provider)?.policy
  );
}

function resolvePrimaryModelRef(
  cfg: OpenClawConfig,
  agentModel?: AgentModelConfig,
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

function isSandboxModeActive(mode: unknown): boolean {
  return mode === "all" || mode === "non-main";
}

function getList(value: unknown, key: "allow" | "alsoAllow" | "deny"): string[] | undefined {
  if (!hasRecord(value)) {
    return undefined;
  }
  const raw = value[key];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pickSandboxToolPolicyField(params: {
  agentPolicy: unknown;
  globalPolicy: unknown;
  key: "allow" | "alsoAllow" | "deny";
  agentLabel: string;
}): PickedSandboxToolPolicyField {
  const agentValue = hasRecord(params.agentPolicy) ? params.agentPolicy[params.key] : undefined;
  if (Array.isArray(agentValue)) {
    return {
      value: agentValue,
      label: `${params.agentLabel}.${params.key}`,
      defined: true,
    };
  }

  const globalValue = hasRecord(params.globalPolicy) ? params.globalPolicy[params.key] : undefined;
  if (Array.isArray(globalValue)) {
    return {
      value: globalValue,
      label: `tools.sandbox.tools.${params.key}`,
      defined: true,
    };
  }

  return { value: undefined, defined: false };
}

function buildEffectiveSandboxToolPolicy(params: {
  agentPolicy?: unknown;
  agentLabel?: string;
  globalPolicy: unknown;
  nonSandboxToolPolicyBlocksMcp: boolean;
}): ActiveSandboxToolPolicy {
  const agentLabel = params.agentLabel ?? "agents.list[].tools.sandbox.tools";
  const allow = pickSandboxToolPolicyField({
    agentPolicy: params.agentPolicy,
    globalPolicy: params.globalPolicy,
    key: "allow",
    agentLabel,
  });
  const alsoAllow = pickSandboxToolPolicyField({
    agentPolicy: params.agentPolicy,
    globalPolicy: params.globalPolicy,
    key: "alsoAllow",
    agentLabel,
  });
  const deny = pickSandboxToolPolicyField({
    agentPolicy: params.agentPolicy,
    globalPolicy: params.globalPolicy,
    key: "deny",
    agentLabel,
  });

  const policy: Record<string, unknown> = {};
  if (allow.defined) {
    policy.allow = allow.value;
  }
  if (alsoAllow.defined) {
    policy.alsoAllow = alsoAllow.value;
  }
  if (deny.defined) {
    policy.deny = deny.value;
  }

  const allowLabels = [allow.label, alsoAllow.label].filter((label): label is string =>
    Boolean(label),
  );
  const labels = allowLabels.length > 0 ? allowLabels : ["tools.sandbox.tools.alsoAllow (unset)"];
  const dedupeLabels = uniqueStrings(
    [...labels, deny.label].filter((label): label is string => Boolean(label)),
  );

  return {
    labels,
    dedupeKey: dedupeLabels.join("\u0000"),
    policy,
    nonSandboxToolPolicyBlocksMcp: params.nonSandboxToolPolicyBlocksMcp,
  };
}

function collectActiveSandboxToolPolicies(
  cfg: OpenClawConfig,
  serverNames: readonly string[],
): ActiveSandboxToolPolicy[] {
  const out = new Map<string, ActiveSandboxToolPolicy>();
  const globalPolicy = cfg.tools?.sandbox?.tools;
  const globalToolPolicyBlocksMcp = nonSandboxToolPoliciesBlockMcp({ cfg, serverNames });
  const addPolicy = (entry: ActiveSandboxToolPolicy) => {
    const existing = out.get(entry.dedupeKey);
    if (existing && !existing.nonSandboxToolPolicyBlocksMcp) {
      return;
    }
    out.set(entry.dedupeKey, entry);
  };
  const addGlobalPolicy = () => {
    addPolicy(
      buildEffectiveSandboxToolPolicy({
        globalPolicy,
        nonSandboxToolPolicyBlocksMcp: globalToolPolicyBlocksMcp,
      }),
    );
  };

  const defaultSandboxActive = isSandboxModeActive(cfg.agents?.defaults?.sandbox?.mode);
  if (defaultSandboxActive) {
    addGlobalPolicy();
  }

  const agentList = cfg.agents?.list;
  if (Array.isArray(agentList)) {
    agentList.forEach((agent, index) => {
      if (!hasRecord(agent)) {
        return;
      }
      const agentSandbox = hasRecord(agent.sandbox) ? agent.sandbox : undefined;
      const explicitMode = agentSandbox?.mode;
      const agentSandboxActive =
        explicitMode === undefined ? defaultSandboxActive : isSandboxModeActive(explicitMode);
      if (!agentSandboxActive) {
        return;
      }
      const agentTools = hasRecord(agent.tools) ? agent.tools : undefined;
      const agentToolsSandbox = hasRecord(agentTools?.sandbox) ? agentTools.sandbox : undefined;
      const agentPolicy = hasRecord(agentToolsSandbox?.tools) ? agentToolsSandbox.tools : undefined;
      addPolicy(
        buildEffectiveSandboxToolPolicy({
          agentPolicy,
          agentLabel: `agents.list[${index}].tools.sandbox.tools`,
          globalPolicy,
          nonSandboxToolPolicyBlocksMcp: nonSandboxToolPoliciesBlockMcp({
            cfg,
            serverNames,
            agent,
          }),
        }),
      );
    });
  }

  return [...out.values()];
}

function buildMcpProbeToolNames(serverNames: readonly string[]): string[] {
  const usedNames = new Set<string>();
  return serverNames.map(
    (serverName) => `${sanitizeServerName(serverName, usedNames)}${TOOL_NAME_SEPARATOR}probe`,
  );
}

function buildMcpToolNamePrefixes(serverNames: readonly string[]): string[] {
  const usedNames = new Set<string>();
  return serverNames
    .map((serverName) =>
      normalizeToolName(`${sanitizeServerName(serverName, usedNames)}${TOOL_NAME_SEPARATOR}`),
    )
    .filter(Boolean);
}

function entriesMatchMcpTool(
  entries: readonly string[],
  serverNames: readonly string[],
  mode: "any" | "every",
): boolean {
  const normalizedEntries = entries.map(normalizeToolName).filter(Boolean);
  if (
    normalizedEntries.some(
      (entry) => entry === "*" || entry === "bundle-mcp" || entry === "group:plugins",
    )
  ) {
    return true;
  }
  const serverPrefixes = buildMcpToolNamePrefixes(serverNames);
  const patterns = compileGlobPatterns({ raw: normalizedEntries, normalize: normalizeToolName });
  const probeNames = buildMcpProbeToolNames(serverNames).map(normalizeToolName);
  const prefixOrPatternMatches = (prefix: string, index: number) =>
    normalizedEntries.some((entry) => entry.length > prefix.length && entry.startsWith(prefix)) ||
    matchesAnyGlobPattern(probeNames[index] ?? "", patterns);
  return mode === "every"
    ? serverPrefixes.every((prefix, index) => prefixOrPatternMatches(prefix, index))
    : serverPrefixes.some((prefix, index) => prefixOrPatternMatches(prefix, index));
}

function entriesMatchAnyMcpTool(
  entries: readonly string[],
  serverNames: readonly string[],
): boolean {
  return entriesMatchMcpTool(entries, serverNames, "any");
}

function entriesMatchEveryMcpTool(
  entries: readonly string[],
  serverNames: readonly string[],
): boolean {
  return entriesMatchMcpTool(entries, serverNames, "every");
}

function sandboxPolicyAllowsAllMcpServers(
  policy: unknown,
  serverNames: readonly string[],
): boolean {
  const allow = getList(policy, "allow");
  if (Array.isArray(allow) && allow.length === 0) {
    return true;
  }
  const entries = [...(allow ?? []), ...(getList(policy, "alsoAllow") ?? [])];
  return entriesMatchEveryMcpTool(entries, serverNames);
}

function toolPolicyAllowsAnyMcpServer(policy: unknown, serverNames: readonly string[]): boolean {
  const allow = getList(policy, "allow");
  if (Array.isArray(allow) && allow.length === 0) {
    return true;
  }
  const entries = [...(allow ?? []), ...(getList(policy, "alsoAllow") ?? [])];
  return entriesMatchAnyMcpTool(entries, serverNames);
}

function toolPolicyDeniesAllMcpServers(policy: unknown, serverNames: readonly string[]): boolean {
  const deny = getList(policy, "deny") ?? [];
  return entriesMatchEveryMcpTool(deny, serverNames);
}

function sandboxPolicyIntentionallyDeniesAllMcpServers(
  policy: unknown,
  serverNames: readonly string[],
): boolean {
  return toolPolicyDeniesAllMcpServers(policy, serverNames);
}

function nonSandboxToolPolicyBlocksMcp(policy: unknown, serverNames: readonly string[]): boolean {
  if (toolPolicyDeniesAllMcpServers(policy, serverNames)) {
    return true;
  }
  const allow = getList(policy, "allow");
  if (!Array.isArray(allow) || allow.length === 0) {
    return false;
  }
  const entries = [...allow, ...(getList(policy, "alsoAllow") ?? [])];
  return !entriesMatchAnyMcpTool(entries, serverNames);
}

function profileToolPolicyBlocksMcp(policy: unknown, serverNames: readonly string[]): boolean {
  const profile = hasRecord(policy) && typeof policy.profile === "string" ? policy.profile : "";
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(profile),
    getList(policy, "alsoAllow"),
  );
  return Boolean(profilePolicy && !toolPolicyAllowsAnyMcpServer(profilePolicy, serverNames));
}

function nonSandboxToolPoliciesBlockMcp(params: {
  cfg: OpenClawConfig;
  serverNames: readonly string[];
  agent?: Record<string, unknown>;
}): boolean {
  const globalTools = params.cfg.tools;
  const agentTools = asToolPolicyConfig(params.agent?.tools);
  const modelRef = resolvePrimaryModelRef(params.cfg, params.agent?.model as AgentModelConfig);
  const globalProviderPolicy = resolveProviderToolPolicy({
    byProvider: globalTools?.byProvider,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
  });
  const agentProviderPolicy = resolveProviderToolPolicy({
    byProvider: agentTools?.byProvider,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
  });
  const profilePolicy = {
    profile: agentTools?.profile ?? globalTools?.profile,
    alsoAllow: agentTools?.alsoAllow ?? globalTools?.alsoAllow,
  };
  const providerProfilePolicy = {
    profile: agentProviderPolicy?.profile ?? globalProviderPolicy?.profile,
    alsoAllow: agentProviderPolicy?.alsoAllow ?? globalProviderPolicy?.alsoAllow,
  };

  return (
    profileToolPolicyBlocksMcp(profilePolicy, params.serverNames) ||
    profileToolPolicyBlocksMcp(providerProfilePolicy, params.serverNames) ||
    nonSandboxToolPolicyBlocksMcp(globalTools, params.serverNames) ||
    nonSandboxToolPolicyBlocksMcp(globalProviderPolicy, params.serverNames) ||
    nonSandboxToolPolicyBlocksMcp(agentTools, params.serverNames) ||
    nonSandboxToolPolicyBlocksMcp(agentProviderPolicy, params.serverNames)
  );
}

function formatMcpServerSummary(serverNames: readonly string[]): string {
  const noun = serverNames.length === 1 ? "server" : "servers";
  const listed = serverNames
    .slice(0, 3)
    .map((serverName) => `"${serverName}"`)
    .join(", ");
  const suffix = serverNames.length > 3 ? `, +${serverNames.length - 3} more` : "";
  return `${serverNames.length} MCP ${noun}${listed ? ` (${listed}${suffix})` : ""}`;
}

function collectSandboxMcpAllowlistWarnings(cfg: OpenClawConfig): string[] {
  const serverNames = collectConfiguredMcpServerNames(cfg);
  if (serverNames.length === 0) {
    return [];
  }
  const sandboxPolicies = collectActiveSandboxToolPolicies(cfg, serverNames);
  if (sandboxPolicies.length === 0) {
    return [];
  }
  const issueSources = sandboxPolicies
    .filter(
      ({ policy }) =>
        !sandboxPolicyAllowsAllMcpServers(policy, serverNames) &&
        !sandboxPolicyIntentionallyDeniesAllMcpServers(policy, serverNames),
    )
    .filter(
      ({ nonSandboxToolPolicyBlocksMcp: nonSandboxToolPolicyBlocksMcpLocal }) =>
        !nonSandboxToolPolicyBlocksMcpLocal,
    )
    .flatMap(({ labels }) => labels);
  if (issueSources.length === 0) {
    return [];
  }
  const sourceSubject = formatSourceLabelSubject(issueSources);
  return [
    `- mcp.servers defines ${formatMcpServerSummary(serverNames)}, but ${sourceSubject.text} ${sourceSubject.verb} not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>${TOOL_NAME_SEPARATOR}*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.`,
  ];
}

function formatPluginList(pluginIds: readonly string[]): string {
  if (pluginIds.length === 1) {
    return `"${pluginIds[0]}"`;
  }
  return pluginIds.map((pluginId) => `"${pluginId}"`).join(", ");
}

function addIssue(issues: Map<string, Set<string>>, key: string, sourceLabel: string) {
  const sources = issues.get(key) ?? new Set<string>();
  sources.add(sourceLabel);
  issues.set(key, sources);
}

export function collectPluginToolAllowlistWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): string[] {
  if (params.cfg.plugins?.enabled === false) {
    return [];
  }
  const warnings = collectSandboxMcpAllowlistWarnings(params.cfg);
  const allowedPluginIds = (params.cfg.plugins?.allow ?? [])
    .map(normalizePluginIdMaybe)
    .filter((pluginId): pluginId is string => Boolean(pluginId));
  const allowedPlugins = new Set(allowedPluginIds);
  if (allowedPlugins.size === 0) {
    return warnings;
  }

  const sources = collectToolAllowlistSources(params.cfg);
  if (sources.length === 0) {
    return warnings;
  }

  const wildcardSources = sources
    .filter((source) => source.entries.some((entry) => normalizeToolName(entry) === "*"))
    .map((source) => source.label);
  if (wildcardSources.length > 0) {
    warnings.push(
      `- plugins.allow is an exclusive plugin allowlist. ${formatSourceLabels(wildcardSources)} contains "*", but that wildcard only matches tools from plugins that are loaded; plugin tools outside plugins.allow stay unavailable. Add the required plugin ids to plugins.allow or remove plugins.allow.`,
    );
  }

  const exactEntries = sources.flatMap((source) =>
    source.entries
      .map((entry) => ({ source: source.label, entry: normalizeToolName(entry) }))
      .filter(({ entry }) => entry && entry !== "*" && entry !== "group:plugins"),
  );
  if (exactEntries.length === 0) {
    return warnings;
  }

  const registry =
    params.manifestRegistry ??
    loadManifestMetadataSnapshot({
      config: params.cfg,
      env: params.env ?? process.env,
    }).manifestRegistry;
  const knownPluginIds = collectKnownPluginIds(registry);
  const toolOwners = collectToolOwners(registry);
  const missingPluginIssues = new Map<string, Set<string>>();
  const missingToolOwnerIssues = new Map<string, Set<string>>();

  for (const { source, entry } of exactEntries) {
    const pluginId = normalizePluginId(entry);
    if (knownPluginIds.has(pluginId) && !allowedPlugins.has(pluginId)) {
      addIssue(missingPluginIssues, pluginId, source);
      continue;
    }

    const owners = (toolOwners.get(entry) ?? []).filter(
      (ownerPluginId) => !allowedPlugins.has(ownerPluginId),
    );
    if (owners.length > 0 && owners.length === (toolOwners.get(entry) ?? []).length) {
      addIssue(missingToolOwnerIssues, `${entry}\u0000${owners.join("\u0000")}`, source);
    }
  }

  for (const [pluginId, issueSources] of [...missingPluginIssues.entries()].toSorted(
    (left, right) => left[0].localeCompare(right[0]),
  )) {
    warnings.push(
      `- ${formatSourceLabels(issueSources)} references plugin "${pluginId}", but plugins.allow does not include it. Add "${pluginId}" to plugins.allow or remove plugins.allow.`,
    );
  }

  for (const [issueKey, issueSources] of [...missingToolOwnerIssues.entries()].toSorted(
    (left, right) => left[0].localeCompare(right[0]),
  )) {
    const [toolName, ...ownerPluginIds] = issueKey.split("\u0000");
    if (!toolName) {
      continue;
    }
    warnings.push(
      `- ${formatSourceLabels(issueSources)} references tool "${toolName}", owned by plugin ${formatPluginList(ownerPluginIds)}, but plugins.allow does not include the owning plugin. Add ${formatPluginList(ownerPluginIds)} to plugins.allow or remove plugins.allow.`,
    );
  }

  return warnings;
}
