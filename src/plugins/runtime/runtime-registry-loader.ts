import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../activation-context.js";
import { getLoadedRuntimePluginRegistry } from "../active-runtime-registry.js";
import {
  resolveChannelPluginIds,
  resolveConfiguredChannelPluginIds,
  resolveDiscoverableScopedChannelPluginIds,
} from "../channel-plugin-ids.js";
import { resolveEffectivePluginIds } from "../effective-plugin-ids.js";
import { loadOpenClawPlugins } from "../loader.js";
import {
  hasExplicitPluginIdScope,
  hasNonEmptyPluginIdScope,
  normalizePluginIdScope,
} from "../plugin-scope.js";
import { getActivePluginRegistry } from "../runtime.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  resolvePluginRuntimeLoadContext,
} from "./load-context.js";

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
  requestedPluginIds: readonly string[] | undefined,
): boolean {
  if (!active) {
    return false;
  }
  if (requestedPluginIds !== undefined) {
    if (requestedPluginIds.length === 0) {
      return false;
    }
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

function shouldForwardChannelScope(params: {
  scope: PluginRegistryScope;
  scopedLoad: boolean;
}): boolean {
  return !params.scopedLoad && params.scope === "configured-channels";
}

function resolveScopePluginIds(params: {
  scope: PluginRegistryScope;
  context: ReturnType<typeof resolvePluginRuntimeLoadContext>;
}): string[] {
  switch (params.scope) {
    case "configured-channels":
      return resolveConfiguredChannelPluginIds({
        config: params.context.config,
        activationSourceConfig: params.context.activationSourceConfig,
        workspaceDir: params.context.workspaceDir,
        env: params.context.env,
      });
    case "channels":
      return resolveChannelPluginIds({
        config: params.context.config,
        workspaceDir: params.context.workspaceDir,
        env: params.context.env,
      });
    case "all":
      return resolveEffectivePluginIds({
        config: params.context.rawConfig,
        workspaceDir: params.context.workspaceDir,
        env: params.context.env,
      });
  }
  const unreachableScope: never = params.scope;
  return unreachableScope;
}

function resolveOrLoadRuntimePluginRegistry(
  loadOptions: NonNullable<Parameters<typeof loadOpenClawPlugins>[0]>,
): void {
  if (
    !getLoadedRuntimePluginRegistry({
      env: loadOptions.env,
      loadOptions,
      workspaceDir: loadOptions.workspaceDir,
      requiredPluginIds: loadOptions.onlyPluginIds,
    })
  ) {
    loadOpenClawPlugins(loadOptions);
  }
}

export function ensurePluginRegistryLoaded(options?: {
  scope?: PluginRegistryScope;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  onlyChannelIds?: string[];
}): void {
  const scope = options?.scope ?? "all";
  const requestedPluginIdsFromOptions = normalizePluginIdScope(options?.onlyPluginIds);
  const requestedChannelIds = normalizePluginIdScope(options?.onlyChannelIds);
  const context = resolvePluginRuntimeLoadContext(options);
  const requestedChannelOwnerPluginIds =
    requestedChannelIds === undefined
      ? undefined
      : resolveDiscoverableScopedChannelPluginIds({
          config: context.config,
          activationSourceConfig: context.activationSourceConfig,
          channelIds: requestedChannelIds,
          workspaceDir: context.workspaceDir,
          env: context.env,
        });
  const requestedPluginIds =
    requestedChannelOwnerPluginIds === undefined
      ? requestedPluginIdsFromOptions
      : normalizePluginIdScope([
          ...(requestedPluginIdsFromOptions ?? []),
          ...requestedChannelOwnerPluginIds,
        ]);
  const scopedLoad = hasExplicitPluginIdScope(requestedPluginIds);
  const expectedPluginIds = scopedLoad
    ? (requestedPluginIds ?? [])
    : resolveScopePluginIds({ scope, context });
  const active = getActivePluginRegistry();
  const requestedPluginIdsForScope = scope === "all" ? expectedPluginIds : undefined;
  if (
    !scopedLoad &&
    scopeRank(pluginRegistryLoaded) >= scopeRank(scope) &&
    activeRegistrySatisfiesScope(scope, active, expectedPluginIds, requestedPluginIdsForScope)
  ) {
    return;
  }
  if (
    (pluginRegistryLoaded === "none" || scopedLoad) &&
    activeRegistrySatisfiesScope(scope, active, expectedPluginIds, requestedPluginIds)
  ) {
    if (!scopedLoad) {
      pluginRegistryLoaded = scope;
    }
    return;
  }
  const scopedConfig =
    scope === "configured-channels" &&
    expectedPluginIds.length > 0 &&
    (!scopedLoad || requestedChannelOwnerPluginIds !== undefined)
      ? (withActivatedPluginIds({
          config: context.config,
          pluginIds: expectedPluginIds,
        }) ?? context.config)
      : context.config;
  const scopedActivationSourceConfig =
    scope === "configured-channels" &&
    expectedPluginIds.length > 0 &&
    (!scopedLoad || requestedChannelOwnerPluginIds !== undefined)
      ? (withActivatedPluginIds({
          config: context.activationSourceConfig,
          pluginIds: expectedPluginIds,
        }) ?? context.activationSourceConfig)
      : context.activationSourceConfig;
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      ...context,
      config: scopedConfig,
      activationSourceConfig: scopedActivationSourceConfig,
    },
    {
      throwOnLoadError: true,
      ...(hasExplicitPluginIdScope(requestedPluginIds) ||
      shouldForwardChannelScope({ scope, scopedLoad }) ||
      hasNonEmptyPluginIdScope(expectedPluginIds) ||
      scope === "all"
        ? { onlyPluginIds: expectedPluginIds }
        : {}),
    },
  );
  resolveOrLoadRuntimePluginRegistry(loadOptions);
  if (!scopedLoad) {
    pluginRegistryLoaded = scope;
  }
}

export const __testing = {
  resetPluginRegistryLoadedForTests(): void {
    pluginRegistryLoaded = "none";
  },
};
