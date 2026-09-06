/**
 * Tool allow/deny policy helpers.
 * Normalizes core and plugin tool groups, expands plugin entries, and extracts
 * explicit operator allow/deny lists.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sanitizeServerName, TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import { IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW } from "./sandbox-tool-policy.js";
import {
  expandToolGroups,
  normalizeToolList,
  normalizeToolPolicyName,
} from "./tool-policy-shared.js";
export {
  attachToolAllowlistIntersection,
  couldNormalizeToolNamePrefixToAllowedTool,
  expandToolGroups,
  normalizeToolList,
  normalizeToolPolicyName,
  readToolAllowlistIntersection,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy-shared.js";
export type { ToolProfileId } from "./tool-policy-shared.js";

/** Tool allow/deny policy shape accepted by agent and sandbox config. */
export type ToolPolicyLike = {
  allow?: string[];
  deny?: string[];
  [IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW]?: true;
};

/** Plugin-owned tool group expansion state. */
export type PluginToolGroups = {
  all: string[];
  byPlugin: Map<string, string[]>;
};

/** Analysis of an allowlist after matching core and plugin tool ids. */
type AllowlistResolution = {
  unknownAllowlist: string[];
  pluginOnlyAllowlist: boolean;
};

export type DeclaredToolAllowlistContext = {
  pluginToolNames?: Iterable<string>;
  pluginIds?: Iterable<string>;
  mcpServerNames?: Iterable<string>;
};

/** Synthetic allowlist entry that means "use default plugin tools". */
export const DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY = "__openclaw_default_plugin_tools__";

const SHIPPED_PLUGIN_POLICY_FAMILY_CORE_TOOLS = new Map<string, readonly string[]>([
  // `canvas` is a shipped operator policy family. Keep promoted `show_widget`
  // in that family so existing allow/deny configs retain their old surface.
  ["canvas", ["show_widget"]],
]);

const SHIPPED_CORE_POLICY_RENAMES = new Map<string, string>([
  // Mirror the shipped plugin-family mapping above without renaming runtime events:
  // old update_plan allow/deny entries now govern the replacement progress_card tool.
  ["update_plan", "progress_card"],
]);

/** Maps retired shipped policy names to their current core tool ids. */
export function expandShippedCoreToolPolicyNames(list: string[] | undefined): string[] | undefined {
  if (!list) {
    return undefined;
  }
  return uniqueStrings(
    list.map((entry) => {
      const normalized = normalizeToolPolicyName(entry);
      return SHIPPED_CORE_POLICY_RENAMES.get(normalized) ?? normalized;
    }),
  );
}

/** Returns true when an allow policy is narrower than all/default plugin tools. */
export function hasRestrictiveAllowPolicy(policy?: { allow?: string[] }): boolean {
  if (!Array.isArray(policy?.allow)) {
    return false;
  }
  const normalizedAllow = policy.allow.map((entry) => normalizeToolPolicyName(entry));
  // A wildcard remains allow-all when additive entries are present. Treating
  // those extras as restrictive would unnecessarily cap delegated sessions.
  if (normalizedAllow.includes("*")) {
    return false;
  }
  return normalizedAllow.some(
    (entry) => Boolean(entry) && entry !== DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
  );
}

/** Returns whether a policy removes at least one tool from the default surface. */
export function toolPolicyRestrictsTools(policy?: ToolPolicyLike): boolean {
  if (!policy) {
    return false;
  }
  if (
    expandToolGroups(policy.deny ?? []).some((entry) => Boolean(normalizeToolPolicyName(entry)))
  ) {
    return true;
  }
  return (
    Array.isArray(policy.allow) &&
    policy.allow.length > 0 &&
    !expandToolGroups(policy.allow).some((entry) => normalizeToolPolicyName(entry) === "*")
  );
}

/** Replaces an allowlist with the normalized names of an effective tool array. */
export function replaceWithEffectiveToolAllowlist(
  target: string[],
  tools: ReadonlyArray<{ name: string }>,
): void {
  target.length = 0;
  const seen = new Set<string>();
  for (const tool of tools) {
    const normalized = normalizeToolPolicyName(tool.name);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    target.push(normalized);
  }
}

/** Collects explicit allow entries from layered policies. */
export function collectExplicitAllowlist(policies: Array<ToolPolicyLike | undefined>): string[] {
  const entries: string[] = [];
  for (const policy of policies) {
    if (!policy?.allow) {
      continue;
    }
    for (const value of policy.allow) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed === "*" && policy[IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW] === true) {
        // alsoAllow implicitly injects "*" for sandbox compatibility; do not
        // report that implicit wildcard as an explicit operator allow entry.
        continue;
      }
      if (trimmed) {
        entries.push(trimmed);
      }
    }
    if (policy[IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW] === true) {
      entries.push(DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY);
    }
  }
  return uniqueStrings(entries);
}

/** Collects explicit deny entries from layered policies. */
export function collectExplicitDenylist(policies: Array<ToolPolicyLike | undefined>): string[] {
  const entries: string[] = [];
  for (const policy of policies) {
    if (!policy?.deny) {
      continue;
    }
    for (const value of policy.deny) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed) {
        entries.push(trimmed);
      }
    }
  }
  return entries;
}

/** Builds plugin tool groups from tool metadata. */
export function buildPluginToolGroups<T extends { name: string }>(params: {
  tools: T[];
  toolMeta: (tool: T) => { pluginId: string } | undefined;
}): PluginToolGroups {
  const all: string[] = [];
  const byPlugin = new Map<string, string[]>();
  for (const tool of params.tools) {
    const meta = params.toolMeta(tool);
    if (!meta) {
      continue;
    }
    const name = normalizeToolPolicyName(tool.name);
    all.push(name);
    const pluginId = normalizeOptionalLowercaseString(meta.pluginId);
    if (!pluginId) {
      continue;
    }
    const list = byPlugin.get(pluginId) ?? [];
    list.push(name);
    byPlugin.set(pluginId, list);
  }
  return { all, byPlugin };
}

/** Expands group:plugins and plugin-id entries into concrete plugin tool names. */
function expandPluginGroups(
  list: string[] | undefined,
  groups: PluginToolGroups,
): string[] | undefined {
  const renamed = expandShippedCoreToolPolicyNames(list);
  if (!renamed || renamed.length === 0) {
    return renamed;
  }
  const expanded: string[] = [];
  for (const entry of renamed) {
    const normalized = normalizeToolPolicyName(entry);
    if (normalized === "group:plugins") {
      if (groups.all.length > 0) {
        expanded.push(...groups.all);
      } else {
        expanded.push(normalized);
      }
      continue;
    }
    const tools = groups.byPlugin.get(normalized) ?? [];
    const promotedCoreTools = SHIPPED_PLUGIN_POLICY_FAMILY_CORE_TOOLS.get(normalized) ?? [];
    if (tools.length > 0 || promotedCoreTools.length > 0) {
      expanded.push(...tools, ...promotedCoreTools);
      continue;
    }
    expanded.push(normalized);
  }
  return uniqueStrings(expanded);
}

/** Expands plugin groups in a policy while preserving undefined policies. */
export function expandPolicyWithPluginGroups(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
): ToolPolicyLike | undefined {
  if (!policy) {
    return undefined;
  }
  return {
    allow: expandPluginGroups(policy.allow, groups),
    deny: expandPluginGroups(policy.deny, groups),
  };
}

function buildDeclaredMcpToolPrefixes(serverNames?: Iterable<string>): Set<string> {
  const prefixes = new Set<string>();
  const usedNames = new Set<string>();
  for (const serverName of serverNames ?? []) {
    const safeName = sanitizeServerName(serverName, usedNames);
    const prefix = normalizeToolPolicyName(safeName + TOOL_NAME_SEPARATOR);
    if (prefix) {
      prefixes.add(prefix);
    }
  }
  return prefixes;
}

function isDeclaredMcpAllowlistEntry(entry: string, prefixes: Set<string>): boolean {
  if (prefixes.size === 0) {
    return false;
  }
  if (entry === "bundle-mcp") {
    return true;
  }
  for (const prefix of prefixes) {
    if (entry.length > prefix.length && entry.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/** Classifies allowlists as core, plugin-only, or unknown for diagnostics. */
export function analyzeAllowlistByToolType(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
  coreTools: Set<string>,
  declaredTools?: DeclaredToolAllowlistContext,
): AllowlistResolution {
  if (!policy?.allow || policy.allow.length === 0) {
    return { unknownAllowlist: [], pluginOnlyAllowlist: false };
  }
  const normalized = normalizeToolList(expandShippedCoreToolPolicyNames(policy.allow));
  if (normalized.length === 0) {
    return { unknownAllowlist: [], pluginOnlyAllowlist: false };
  }
  const pluginIds = new Set(groups.byPlugin.keys());
  for (const value of declaredTools?.pluginIds ?? []) {
    const pluginId = normalizeOptionalLowercaseString(value);
    if (pluginId) {
      pluginIds.add(pluginId);
    }
  }
  const pluginTools = new Set(groups.all);
  for (const value of declaredTools?.pluginToolNames ?? []) {
    const toolName = normalizeToolPolicyName(value);
    if (toolName) {
      pluginTools.add(toolName);
    }
  }
  const mcpToolPrefixes = buildDeclaredMcpToolPrefixes(declaredTools?.mcpServerNames);
  const unknownAllowlist: string[] = [];
  let hasOnlyPluginEntries = true;
  for (const entry of normalized) {
    if (entry === "*") {
      hasOnlyPluginEntries = false;
      continue;
    }
    const isPluginEntry =
      entry === "group:plugins" ||
      pluginIds.has(entry) ||
      pluginTools.has(entry) ||
      isDeclaredMcpAllowlistEntry(entry, mcpToolPrefixes);
    const expanded = expandToolGroups([entry]);
    const isCoreEntry = expanded.some((tool) => coreTools.has(tool));
    if (!isPluginEntry) {
      hasOnlyPluginEntries = false;
    }
    if (!isCoreEntry && !isPluginEntry) {
      unknownAllowlist.push(entry);
    }
  }
  const pluginOnlyAllowlist = hasOnlyPluginEntries;
  return {
    unknownAllowlist: uniqueStrings(unknownAllowlist),
    pluginOnlyAllowlist,
  };
}

/** Merges alsoAllow entries into an existing allow policy. */
export function mergeAlsoAllowPolicy<TPolicy extends { allow?: string[] }>(
  policy: TPolicy | undefined,
  alsoAllow?: string[],
): TPolicy | undefined {
  if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) {
    return policy;
  }
  return { ...policy, allow: uniqueStrings([...policy.allow, ...alsoAllow]) };
}
