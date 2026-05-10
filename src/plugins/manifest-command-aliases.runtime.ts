import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import {
  resolveManifestCommandAliasOwnerInRegistry,
  resolveManifestToolOwnerInRegistry,
  type PluginManifestCommandAliasRegistry,
  type PluginManifestCommandAliasRecord,
  type PluginManifestToolOwnerRecord,
} from "./manifest-command-aliases.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataRegistry,
  loadManifestMetadataSnapshot,
} from "./manifest-contract-eligibility.js";
import { hasManifestToolAvailability } from "./manifest-tool-availability.js";

export function resolveManifestCommandAliasOwner(params: {
  command: string | undefined;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  registry?: PluginManifestCommandAliasRegistry;
}): PluginManifestCommandAliasRecord | undefined {
  const registry =
    params.registry ??
    loadManifestMetadataRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }).manifestRegistry;
  return resolveManifestCommandAliasOwnerInRegistry({
    command: params.command,
    registry,
  });
}

export function resolveManifestCliCommandSurfaceOwner(params: {
  command: string | undefined;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  registry?: PluginManifestCommandAliasRegistry;
}): string | undefined {
  const normalizedCommand = normalizeOptionalLowercaseString(params.command);
  if (!normalizedCommand) {
    return undefined;
  }
  if (params.registry) {
    return resolveManifestCommandAliasOwnerInRegistry({
      command: normalizedCommand,
      registry: params.registry,
    })?.pluginId;
  }
  return resolveManifestActivationPluginIds({
    trigger: { kind: "command", command: normalizedCommand },
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })[0];
}

/**
 * Resolve which plugin owns an agent-tool name, applying control-plane
 * availability filters so disabled/denied plugins are not falsely attributed.
 *
 * Behavior:
 * - Walks the full manifest snapshot (not the lighter-weight registry view) so
 *   per-tool `configSignals`/`authSignals` are visible.
 * - Skips plugins that fail `isManifestPluginAvailableForControlPlane`
 *   (`plugins.allow` / `plugins.deny` / `plugins.entries[id].enabled` /
 *   installed-index).
 * - For matched tools, runs `hasManifestToolAvailability` to check the
 *   tool's own configSignals (e.g. Feishu's `appId`/`appSecret` gate).
 * - Reports `availability: "loaded"` when both filters pass, enough for a
 *   direct "available from this plugin" diagnostic.
 * - Reports `availability: "manifest-only"` when the manifest declares
 *   ownership but availability is not provable from manifest alone (e.g.
 *   per-account `enabled` flags or per-tool toggles that are runtime-only).
 *   Caller should soften the wording to "may be provided by".
 *
 * Falls back to the pure registry walk only when an explicit registry is
 * supplied (no snapshot to filter against).
 */
export function resolveManifestToolOwner(params: {
  toolName: string | undefined;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  registry?: PluginManifestCommandAliasRegistry;
}): PluginManifestToolOwnerRecord | undefined {
  if (params.registry) {
    return resolveManifestToolOwnerInRegistry({
      toolName: params.toolName,
      registry: params.registry,
    });
  }
  const normalizedToolName = normalizeOptionalLowercaseString(params.toolName);
  if (!normalizedToolName) {
    return undefined;
  }
  const snapshot = loadManifestMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const env = params.env ?? process.env;
  for (const plugin of snapshot.plugins) {
    const tools = plugin.contracts?.tools;
    if (!tools || tools.length === 0) {
      continue;
    }
    const match = tools.find(
      (entry) => normalizeOptionalLowercaseString(entry) === normalizedToolName,
    );
    if (!match) {
      continue;
    }
    const pluginAvailable = isManifestPluginAvailableForControlPlane({
      snapshot,
      plugin,
      config: params.config,
    });
    if (!pluginAvailable) {
      // Plugin is denied/disabled/uninstalled; do not attribute this tool to it.
      continue;
    }
    const toolAvailable = hasManifestToolAvailability({
      plugin,
      toolNames: [match],
      config: params.config,
      env,
    });
    return {
      toolName: match,
      pluginId: plugin.id,
      availability: toolAvailable ? "loaded" : "manifest-only",
    };
  }
  return undefined;
}
