import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../agents/glob-pattern.js";
import {
  DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
  normalizeToolPolicyName,
} from "../agents/tool-policy.js";
import type { RuntimePluginToolGrant } from "./runtime/tool-grant.js";

const RUNTIME_PLUGIN_TOOL_GRANT_PREFIX = "__openclaw_runtime_plugin_tool_grant__";

function runtimePluginToolGrantKey(pluginId: string, toolName: string): string {
  return `${RUNTIME_PLUGIN_TOOL_GRANT_PREFIX}:${pluginId.trim().toLowerCase()}:${normalizeToolPolicyName(toolName)}`;
}

export function appendRuntimePluginToolGrant(
  allowlist: string[],
  grant: RuntimePluginToolGrant | undefined,
): string[] {
  return grant
    ? [
        ...allowlist,
        ...grant.toolNames.map((toolName) => runtimePluginToolGrantKey(grant.pluginId, toolName)),
      ]
    : allowlist;
}

export function createPluginToolAllowlist(list?: string[]) {
  const entries = new Set(normalizeUniqueStringEntries((list ?? []).map(normalizeToolPolicyName)));
  // Runtime grants attest exact owner/tool pairs. Never compile their encoded
  // entries as patterns, which could grant a different tool or plugin.
  const patterns = compileGlobPatterns({
    raw: [...entries].filter((entry) => !entry.startsWith(`${RUNTIME_PLUGIN_TOOL_GRANT_PREFIX}:`)),
    normalize: normalizeToolPolicyName,
  });
  const allowsPlugin = (pluginId: string) =>
    entries.has("*") ||
    entries.has("group:plugins") ||
    entries.has(normalizeToolPolicyName(pluginId));
  const allowsToolName = (toolName: string) =>
    entries.has("group:plugins") ||
    matchesAnyGlobPattern(normalizeToolPolicyName(toolName), patterns);
  return {
    size: entries.size,
    includesDefaults: entries.size === 0 || entries.has(DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY),
    allowsPlugin,
    allowsToolName,
    allowsTool: (pluginId: string, toolName: string) =>
      allowsPlugin(pluginId) ||
      allowsToolName(toolName) ||
      entries.has(runtimePluginToolGrantKey(pluginId, toolName)),
  };
}

export type PluginToolAllowlist = ReturnType<typeof createPluginToolAllowlist>;
