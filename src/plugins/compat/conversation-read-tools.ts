import type { PluginManifestRecord } from "../manifest-registry.js";
import type { PluginToolRegistration } from "../registry-types.js";

const HOST_RESTRICTED_CONVERSATION_READ_TOOLS = new Set(["feishu:feishu_chat"]);

function normalizeContractName(value: string): string {
  return value.trim().toLowerCase();
}

export function isHostRestrictedConversationReadTool(params: {
  pluginId: string;
  toolName: string;
}): boolean {
  return HOST_RESTRICTED_CONVERSATION_READ_TOOLS.has(
    `${normalizeContractName(params.pluginId)}:${normalizeContractName(params.toolName)}`,
  );
}

export function registrationIncludesHostRestrictedConversationReadTool(
  entry: PluginToolRegistration,
): boolean {
  return [...entry.names, ...(entry.declaredNames ?? [])].some((toolName) =>
    isHostRestrictedConversationReadTool({ pluginId: entry.pluginId, toolName }),
  );
}

export function isBundledConversationReadToolRegistration(params: {
  entry: PluginToolRegistration;
  manifestPlugin: PluginManifestRecord | undefined;
}): boolean {
  return params.entry.origin === "bundled" && params.manifestPlugin?.origin === "bundled";
}
