import { normalizeToolName } from "../../../agents/tool-policy-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizePluginId } from "../../../plugins/config-state.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";

type ToolAllowlistSource = {
  label: string;
  entries: string[];
};

function hasRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

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

function formatSourceLabels(labels: Iterable<string>): string {
  const sorted = [...new Set(labels)].toSorted((left, right) => left.localeCompare(right));
  if (sorted.length <= 3) {
    return sorted.join(", ");
  }
  return `${sorted.slice(0, 3).join(", ")} (+${sorted.length - 3} more)`;
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
  const allowedPluginIds = (params.cfg.plugins?.allow ?? [])
    .map(normalizePluginIdMaybe)
    .filter((pluginId): pluginId is string => Boolean(pluginId));
  const allowedPlugins = new Set(allowedPluginIds);
  if (allowedPlugins.size === 0) {
    return [];
  }

  const sources = collectToolAllowlistSources(params.cfg);
  if (sources.length === 0) {
    return [];
  }

  const wildcardSources = sources
    .filter((source) => source.entries.some((entry) => normalizeToolName(entry) === "*"))
    .map((source) => source.label);
  const warnings: string[] = [];
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

export function collectBundledProviderAllowlistPolicyWarnings(params: {
  cfg: OpenClawConfig;
}): string[] {
  if (params.cfg.plugins?.enabled === false) {
    return [];
  }
  const allow = params.cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return [];
  }
  if (params.cfg.plugins?.bundledDiscovery !== "compat") {
    return [];
  }
  return [
    '- plugins.allow is restrictive, but bundled provider discovery is still in legacy compatibility mode. Bundled provider plugins can still appear in runtime provider inventories; set plugins.bundledDiscovery to "allowlist" after confirming omitted bundled providers are intentionally blocked.',
  ];
}
