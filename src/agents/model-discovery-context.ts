/**
 * Shared context resolvers for model discovery.
 * Keeps callers from reaching into runtime config or plugin metadata snapshot
 * plumbing directly.
 */
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import type { PluginModelCatalogMetadataSnapshot } from "./plugin-model-catalog.js";

/** Resolve the workspace directory model discovery should use for agent scope. */
export function resolveModelWorkspaceDir(
  cfg: OpenClawConfig | undefined,
  explicitWorkspaceDir: string | undefined,
): string | undefined {
  if (explicitWorkspaceDir !== undefined || !cfg) {
    return explicitWorkspaceDir;
  }
  return resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

/**
 * Resolve the plugin metadata snapshot for model discovery.
 *
 * Explicit snapshots win for tests and prepared runtimes. Otherwise we prefer
 * the current process snapshot, then fall back to resolving from config/env.
 */
export function resolveModelPluginMetadataSnapshot(params: {
  allowWorkspaceScopedCurrent?: boolean;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
  useRuntimeConfig?: boolean;
  workspaceDir?: string;
}): PluginModelCatalogMetadataSnapshot | undefined {
  if (params.pluginMetadataSnapshot) {
    return params.pluginMetadataSnapshot;
  }
  const env = params.env ?? process.env;
  try {
    const config = params.config ?? (params.useRuntimeConfig ? getRuntimeConfig() : undefined);
    return (
      // Current snapshots are already lifecycle-owned; discovery should reuse
      // them before doing config/env-based resolution.
      getCurrentPluginMetadataSnapshot({
        allowWorkspaceScopedSnapshot: true,
        env,
        ...(config ? { config } : {}),
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      }) ??
      resolvePluginMetadataSnapshot({
        config: config ?? {},
        env,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        ...(params.allowWorkspaceScopedCurrent !== undefined
          ? { allowWorkspaceScopedCurrent: params.allowWorkspaceScopedCurrent }
          : {}),
      })
    );
  } catch {
    // Discovery is best-effort here; callers can continue with core/static
    // models when plugin metadata is not available.
    return undefined;
  }
}
