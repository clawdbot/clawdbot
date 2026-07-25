import { normalizeToolName } from "../agents/tool-policy.js";
import type { RuntimePluginToolGrant } from "./runtime/tool-grant.js";

const RUNTIME_PLUGIN_TOOL_GRANT_PREFIX = "__openclaw_runtime_plugin_tool_grant__";

function runtimePluginToolGrantKey(pluginId: string, toolName: string): string {
  return `${RUNTIME_PLUGIN_TOOL_GRANT_PREFIX}:${pluginId.trim().toLowerCase()}:${normalizeToolName(toolName)}`;
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

export function isPluginToolAllowed(
  allowlist: Set<string>,
  pluginId: string,
  toolName: string,
): boolean {
  const normalizedToolName = normalizeToolName(toolName);
  return (
    allowlist.has(normalizedToolName) ||
    allowlist.has(runtimePluginToolGrantKey(pluginId, normalizedToolName))
  );
}
