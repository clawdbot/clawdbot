/** Dependency-light ownership metadata for plugin-contributed agent tools. */
import type { McpCodexToolAnnotations } from "../agents/mcp-codex-tool-approval.js";
import { normalizeToolPolicyName } from "../agents/tool-policy-shared.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { McpCodexToolApprovalMode } from "../config/types.mcp.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

/** MCP bridge metadata attached to plugin tools surfaced through agent tool lists. */
export type PluginToolMcpMeta = {
  serverName: string;
  safeServerName: string;
  toolName: string;
  operation: "tool" | "resources_list" | "resources_read" | "prompts_list" | "prompts_get";
  excludedFromOpenClawCatalog?: true;
  deniedBySession?: true;
  codexApproval?: {
    mode: McpCodexToolApprovalMode;
    annotations?: McpCodexToolAnnotations;
  };
  node?: {
    id: string;
    displayName?: string;
  };
};

/** Runtime metadata used to trace an agent tool back to its owning plugin registration. */
type PluginToolMeta = {
  pluginId: string;
  kind?: PluginManifestRecord["kind"];
  optional: boolean;
  replaySafe?: boolean;
  sideEffecting?: boolean;
  trustedLocalMedia?: boolean;
  mcp?: PluginToolMcpMeta;
};

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();

/** Attaches plugin ownership metadata to a concrete agent tool instance. */
export function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void {
  pluginToolMeta.set(tool, meta);
}

/** Reads plugin ownership metadata for a concrete agent tool instance. */
export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}

/** Copies plugin ownership metadata when wrappers replace a tool object. */
export function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void {
  const meta = pluginToolMeta.get(source);
  if (meta) {
    pluginToolMeta.set(target, meta);
  }
}

/** Builds a collision-proof key for plugin-owned tool metadata lookups. */
export function buildPluginToolMetadataKey(pluginId: string, toolName: string): string {
  return JSON.stringify([pluginId, toolName]);
}

/** Binds a side-effect declaration to the concrete plugin tool that owns it. */
export function getPluginToolSideEffectOwnerKey(tool: AnyAgentTool): string | undefined {
  const meta = getPluginToolMeta(tool);
  const toolName = normalizeToolPolicyName(tool.name);
  return meta?.sideEffecting && toolName
    ? buildPluginToolMetadataKey(meta.pluginId, toolName)
    : undefined;
}
