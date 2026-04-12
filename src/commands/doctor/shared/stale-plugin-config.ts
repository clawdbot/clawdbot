import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizePluginId } from "../../../plugins/config-state.js";
import { loadPluginManifestRegistry } from "../../../plugins/manifest-registry.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { asObjectRecord } from "./object.js";

type StalePluginSurface = "allow" | "entries";

type StalePluginConfigHit = {
  pluginId: string;
  pathLabel: string;
  surface: StalePluginSurface;
};

type StalePluginRegistryState = {
  knownIds: Set<string>;
  hasDiscoveryErrors: boolean;
};

function collectPluginRegistryState(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): StalePluginRegistryState {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const registry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: workspaceDir ?? undefined,
    env,
  });
  return {
    knownIds: new Set(registry.plugins.map((plugin) => plugin.id)),
    hasDiscoveryErrors: registry.diagnostics.some((diag) => diag.level === "error"),
  };
}

export function isStalePluginAutoRepairBlocked(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): boolean {
  return collectPluginRegistryState(cfg, env).hasDiscoveryErrors;
}

export function scanStalePluginConfig(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): StalePluginConfigHit[] {
  const plugins = asObjectRecord(cfg.plugins);
  if (!plugins) {
    return [];
  }

  const { knownIds } = collectPluginRegistryState(cfg, env);
  const hits: StalePluginConfigHit[] = [];

  const allow = Array.isArray(plugins.allow) ? plugins.allow : [];
  for (const rawPluginId of allow) {
    if (typeof rawPluginId !== "string") {
      continue;
    }
    const pluginId = normalizePluginId(rawPluginId);
    if (!pluginId || knownIds.has(pluginId)) {
      continue;
    }
    hits.push({
      pluginId: rawPluginId,
      pathLabel: "plugins.allow",
      surface: "allow",
    });
  }

  const entries = asObjectRecord(plugins.entries);
  if (!entries) {
    return hits;
  }
  for (const rawPluginId of Object.keys(entries)) {
    if (knownIds.has(normalizePluginId(rawPluginId))) {
      continue;
    }
    hits.push({
      pluginId: rawPluginId,
      pathLabel: `plugins.entries.${rawPluginId}`,
      surface: "entries",
    });
  }

  return hits;
}

export function collectStalePluginConfigWarnings(params: {
  hits: StalePluginConfigHit[];
  doctorFixCommand: string;
  autoRepairBlocked?: boolean;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const lines = params.hits.map(
    (hit) => `- ${hit.pathLabel}: stale plugin reference "${hit.pluginId}" was found.`,
  );
  if (params.autoRepairBlocked) {
    lines.push(
      `- Auto-removal is paused because plugin discovery currently has errors. Fix plugin discovery first, then rerun "${params.doctorFixCommand}".`,
    );
  } else {
    lines.push(
      `- Run "${params.doctorFixCommand}" to remove stale plugins.allow and plugins.entries ids.`,
    );
  }
  return lines.map((line) => sanitizeForLog(line));
}

export function maybeRepairStalePluginConfig(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): {
  config: OpenClawConfig;
  changes: string[];
} {
  if (isStalePluginAutoRepairBlocked(cfg, env)) {
    return { config: cfg, changes: [] };
  }

  const hits = scanStalePluginConfig(cfg, env);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const nextPlugins = asObjectRecord(next.plugins);
  if (!nextPlugins) {
    return { config: cfg, changes: [] };
  }

  const allowIds = hits.filter((hit) => hit.surface === "allow").map((hit) => hit.pluginId);
  if (allowIds.length > 0 && Array.isArray(nextPlugins.allow)) {
    const staleAllowIds = new Set(allowIds.map((pluginId) => normalizePluginId(pluginId)));
    nextPlugins.allow = nextPlugins.allow.filter(
      (pluginId) => typeof pluginId !== "string" || !staleAllowIds.has(normalizePluginId(pluginId)),
    );
  }

  const entryIds = hits.filter((hit) => hit.surface === "entries").map((hit) => hit.pluginId);
  if (entryIds.length > 0) {
    const entries = asObjectRecord(nextPlugins.entries);
    if (entries) {
      const staleEntryIds = new Set(entryIds.map((pluginId) => normalizePluginId(pluginId)));
      for (const pluginId of Object.keys(entries)) {
        if (staleEntryIds.has(normalizePluginId(pluginId))) {
          delete entries[pluginId];
        }
      }
    }
  }

  const changes: string[] = [];
  if (allowIds.length > 0) {
    changes.push(
      `- plugins.allow: removed ${allowIds.length} stale plugin id${allowIds.length === 1 ? "" : "s"} (${allowIds.join(", ")})`,
    );
  }
  if (entryIds.length > 0) {
    changes.push(
      `- plugins.entries: removed ${entryIds.length} stale plugin entr${entryIds.length === 1 ? "y" : "ies"} (${entryIds.join(", ")})`,
    );
  }

  return { config: next, changes };
}
