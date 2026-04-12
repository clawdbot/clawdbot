import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveChannelPluginIds,
  resolveConfiguredChannelPluginIds,
} from "../channel-plugin-ids.js";
import { loadOpenClawPlugins } from "../loader.js";
import { getActivePluginRegistry } from "../runtime.js";
import { buildPluginRuntimeLoadOptions, resolvePluginRuntimeLoadContext } from "./load-context.js";

let pluginRegistryLoaded: "none" | "configured-channels" | "channels" | "all" = "none";

export type PluginRegistryScope = "configured-channels" | "channels" | "all";

function scopeRank(scope: typeof pluginRegistryLoaded): number {
  switch (scope) {
    case "none":
      return 0;
    case "configured-channels":
      return 1;
    case "channels":
      return 2;
    case "all":
      return 3;
  }
  throw new Error("Unsupported plugin registry scope");
}

function activeRegistrySatisfiesScope(
  scope: PluginRegistryScope,
  active: ReturnType<typeof getActivePluginRegistry>,
  expectedChannelPluginIds: readonly string[],
  requestedPluginIds: readonly string[],
): boolean {
  if (!active) {
    return false;
  }
  if (requestedPluginIds.length > 0) {
    const activePluginIds = new Set(
      active.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id),
    );
    return requestedPluginIds.every((pluginId) => activePluginIds.has(pluginId));
  }
  const activeChannelPluginIds = new Set(active.channels.map((entry) => entry.plugin.id));
  switch (scope) {
    case "configured-channels":
    case "channels":
      return (
        active.channels.length > 0 &&
        expectedChannelPluginIds.every((pluginId) => activeChannelPluginIds.has(pluginId))
      );
    case "all":
      return false;
  }
  throw new Error("Unsupported plugin registry scope");
}

export function ensurePluginRegistryLoaded(options?: {
  scope?: PluginRegistryScope;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
}): void {
  const scope = options?.scope ?? "all";
  const requestedPluginIds =
    options?.onlyPluginIds?.map((pluginId) => pluginId.trim()).filter(Boolean) ?? [];
  const scopedLoad = requestedPluginIds.length > 0;
  const context = resolvePluginRuntimeLoadContext(options);
  const expectedChannelPluginIds = scopedLoad
    ? requestedPluginIds
    : scope === "configured-channels"
      ? resolveConfiguredChannelPluginIds({
          config: context.config,
          workspaceDir: context.workspaceDir,
          env: context.env,
        })
      : scope === "channels"
        ? resolveChannelPluginIds({
            config: context.config,
            workspaceDir: context.workspaceDir,
            env: context.env,
          })
        : [];
  const active = getActivePluginRegistry();
  if (
    !scopedLoad &&
    scopeRank(pluginRegistryLoaded) >= scopeRank(scope) &&
    activeRegistrySatisfiesScope(scope, active, expectedChannelPluginIds, expectedChannelPluginIds)
  ) {
    return;
  }
  if (
    (pluginRegistryLoaded === "none" || scopedLoad) &&
    activeRegistrySatisfiesScope(scope, active, expectedChannelPluginIds, expectedChannelPluginIds)
  ) {
    if (!scopedLoad) {
      pluginRegistryLoaded = scope;
    }
    return;
  }
  loadOpenClawPlugins(
    buildPluginRuntimeLoadOptions(context, {
      throwOnLoadError: true,
      ...(expectedChannelPluginIds.length > 0 ? { onlyPluginIds: expectedChannelPluginIds } : {}),
    }),
  );
  if (!scopedLoad) {
    pluginRegistryLoaded = scope;
  }
}

export const __testing = {
  resetPluginRegistryLoadedForTests(): void {
    pluginRegistryLoaded = "none";
  },
};
