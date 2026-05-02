import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveRuntimePluginRegistry } from "../plugins/loader.js";
import { getActivePluginRuntimeSubagentMode } from "../plugins/runtime.js";
import { resolveUserPath } from "../utils.js";

type StartupScopedPluginSnapshot = NonNullable<
  ReturnType<typeof getCurrentPluginMetadataSnapshot>
> & {
  startup?: {
    pluginIds?: readonly unknown[];
  };
};

function resolveStartupPluginIdsFromCurrentSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string[] | undefined {
  const snapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
  }) as StartupScopedPluginSnapshot | undefined;
  const pluginIds = snapshot?.startup?.pluginIds;
  if (!Array.isArray(pluginIds)) {
    return undefined;
  }
  return pluginIds.filter((pluginId): pluginId is string => typeof pluginId === "string");
}

export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void {
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  const allowGatewaySubagentBinding =
    params.allowGatewaySubagentBinding === true ||
    getActivePluginRuntimeSubagentMode() === "gateway-bindable";
  const startupPluginIds = resolveStartupPluginIdsFromCurrentSnapshot({
    config: params.config,
    workspaceDir,
  });
  const loadOptions = {
    config: params.config,
    workspaceDir,
    ...(startupPluginIds ? { onlyPluginIds: startupPluginIds } : {}),
    runtimeOptions: allowGatewaySubagentBinding
      ? {
          allowGatewaySubagentBinding: true,
        }
      : undefined,
  };
  resolveRuntimePluginRegistry(loadOptions);
}
