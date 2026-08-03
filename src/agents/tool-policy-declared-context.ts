import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { hasManifestToolAvailability } from "../plugins/manifest-tool-availability.js";
import { isPluginMetadataSnapshotCompatible } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { sanitizeServerName, TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import type { DeclaredToolAllowlistContext } from "./tool-policy.js";
import { normalizeToolName } from "./tool-policy.js";

type ToolDenylist = ReturnType<typeof compileGlobPatterns>;

function normalizeToolDenylist(list?: string[]): ToolDenylist {
  return compileGlobPatterns({ raw: list, normalize: normalizeToolName });
}

function denylistBlocksName(name: string, denylist: ToolDenylist): boolean {
  const normalized = normalizeToolName(name);
  return normalized ? matchesAnyGlobPattern(normalized, denylist) : false;
}

function denylistBlocksMcpServerNamespace(params: {
  safeServerName: string;
  denylist: ToolDenylist;
}): boolean {
  const serverPrefix = normalizeToolName(params.safeServerName + TOOL_NAME_SEPARATOR);
  if (!serverPrefix) {
    return false;
  }
  return matchesAnyGlobPattern(serverPrefix, params.denylist);
}

function denylistBlocksMcpServer(params: {
  safeServerName: string;
  denylist: ToolDenylist;
}): boolean {
  return (
    denylistBlocksName("bundle-mcp", params.denylist) ||
    matchesAnyGlobPattern("group:plugins", params.denylist) ||
    denylistBlocksMcpServerNamespace({
      safeServerName: params.safeServerName,
      denylist: params.denylist,
    })
  );
}

function denylistBlocksPlugin(params: { pluginId: string; denylist: ToolDenylist }): boolean {
  return (
    denylistBlocksName(params.pluginId, params.denylist) ||
    matchesAnyGlobPattern("group:plugins", params.denylist)
  );
}

function denylistBlocksPluginTool(params: {
  pluginId: string;
  toolName: string;
  denylist: ToolDenylist;
}): boolean {
  return (
    denylistBlocksPlugin({ pluginId: params.pluginId, denylist: params.denylist }) ||
    denylistBlocksName(params.toolName, params.denylist)
  );
}

function collectConfiguredMcpServerNames(params: {
  config?: OpenClawConfig;
  toolDenylist?: string[];
}): string[] {
  const servers = normalizeConfiguredMcpServers(params.config?.mcp?.servers);
  const denylist = normalizeToolDenylist(params.toolDenylist);
  const usedServerNames = new Set<string>();
  const names: string[] = [];
  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value) || value.enabled === false || !name.trim()) {
      continue;
    }
    const safeServerName = sanitizeServerName(name, usedServerNames);
    if (
      denylistBlocksMcpServer({
        safeServerName,
        denylist,
      })
    ) {
      continue;
    }
    names.push(safeServerName);
  }
  return names;
}

function collectAvailableManifestToolNames(params: {
  plugin: PluginManifestRecord;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  denylist: ToolDenylist;
}): string[] {
  return (params.plugin.contracts?.tools ?? [])
    .filter(
      (toolName) =>
        !denylistBlocksPluginTool({
          pluginId: params.plugin.id,
          toolName,
          denylist: params.denylist,
        }),
    )
    .filter((toolName) =>
      hasManifestToolAvailability({
        plugin: params.plugin,
        toolNames: [toolName],
        config: params.config,
        env: params.env,
      }),
    )
    .map(normalizeToolName)
    .filter(Boolean);
}

function collectDeclaredPluginContext(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  toolDenylist?: string[];
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Pick<DeclaredToolAllowlistContext, "pluginIds" | "pluginToolNames"> {
  if (params.config?.plugins?.enabled === false) {
    return {};
  }
  const env = params.env ?? process.env;
  const preparedSnapshot =
    params.metadataSnapshot &&
    params.metadataSnapshot.pluginIds === undefined &&
    isPluginMetadataSnapshotCompatible({
      snapshot: params.metadataSnapshot,
      config: params.config,
      env,
      workspaceDir: params.workspaceDir,
    })
      ? params.metadataSnapshot
      : undefined;
  const snapshot =
    preparedSnapshot ??
    getCurrentPluginMetadataSnapshot({
      config: params.config,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      env,
    });
  if (!snapshot) {
    return {};
  }
  const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
  const denylist = normalizeToolDenylist(params.toolDenylist);
  const pluginIds = new Set<string>();
  const pluginToolNames = new Set<string>();
  for (const plugin of snapshot.manifestRegistry.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.config,
      }) ||
      normalizedPlugins.entries[plugin.id]?.enabled === false ||
      normalizedPlugins.deny.includes(plugin.id) ||
      denylistBlocksPlugin({ pluginId: plugin.id, denylist })
    ) {
      continue;
    }
    const availableToolNames = collectAvailableManifestToolNames({
      plugin,
      config: params.config,
      env,
      denylist,
    });
    if (availableToolNames.length === 0) {
      continue;
    }
    pluginIds.add(plugin.id);
    for (const toolName of availableToolNames) {
      pluginToolNames.add(toolName);
    }
  }
  return { pluginIds, pluginToolNames };
}

export function buildDeclaredToolAllowlistContext(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  toolDenylist?: string[];
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): DeclaredToolAllowlistContext | undefined {
  const mcpServerNames = uniqueStrings(
    collectConfiguredMcpServerNames({
      config: params.config,
      toolDenylist: params.toolDenylist,
    }),
  );
  const pluginContext = collectDeclaredPluginContext(params);
  const pluginIds = uniqueStrings(pluginContext.pluginIds ?? []);
  const pluginToolNames = uniqueStrings(pluginContext.pluginToolNames ?? []);
  if (mcpServerNames.length === 0 && pluginIds.length === 0 && pluginToolNames.length === 0) {
    return undefined;
  }
  return {
    ...(pluginIds.length > 0 ? { pluginIds } : {}),
    ...(pluginToolNames.length > 0 ? { pluginToolNames } : {}),
    ...(mcpServerNames.length > 0 ? { mcpServerNames } : {}),
  };
}
