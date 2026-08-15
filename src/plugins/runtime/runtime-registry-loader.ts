// Runtime registry loader assembles process-root plugin runtimes from config metadata.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../activation-context.js";
import {
  resolveChannelPluginIds,
  resolveConfiguredChannelPluginIds,
} from "../channel-plugin-ids.js";
import { normalizePluginsConfig } from "../config-state.js";
import { resolveEffectivePluginIds } from "../effective-plugin-ids.js";
import { collectConfiguredMemoryEmbeddingProviderIds } from "../gateway-startup-plugin-ids.js";
import { createInstalledPluginIndexScopeLookup } from "../installed-plugin-index-scope-lookup.js";
import { loadOpenClawPlugins } from "../loader.js";
import { hasNonEmptyPluginIdScope } from "../plugin-scope.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  resolvePluginRuntimeLoadContext,
} from "./load-context.js";

export type PluginRegistryScope = "configured-channels" | "channels" | "memory" | "all";

function resolveMemoryPluginIds(
  context: ReturnType<typeof resolvePluginRuntimeLoadContext>,
): string[] {
  const configuredProviderIds = [
    ...collectConfiguredMemoryEmbeddingProviderIds(context.activationSourceConfig),
  ];
  const pluginIds = new Set<string>();
  if (context.metadataSnapshot) {
    createInstalledPluginIndexScopeLookup(
      context.metadataSnapshot.index,
    ).addProviderContributionOwners(pluginIds, configuredProviderIds);
  } else {
    for (const providerId of configuredProviderIds) {
      pluginIds.add(providerId);
    }
  }
  const memoryPluginId = normalizePluginsConfig(context.config.plugins).slots.memory?.trim();
  if (memoryPluginId) {
    pluginIds.add(memoryPluginId);
  }
  return [...pluginIds].toSorted();
}

function resolveScopePluginIds(params: {
  scope: PluginRegistryScope;
  context: ReturnType<typeof resolvePluginRuntimeLoadContext>;
}): string[] {
  if (params.scope === "configured-channels") {
    return resolveConfiguredChannelPluginIds({
      config: params.context.config,
      activationSourceConfig: params.context.activationSourceConfig,
      workspaceDir: params.context.workspaceDir,
      env: params.context.env,
    });
  }
  if (params.scope === "channels") {
    return resolveChannelPluginIds({
      config: params.context.config,
      workspaceDir: params.context.workspaceDir,
      env: params.context.env,
    });
  }
  if (params.scope === "memory") {
    // Memory CLI commands must use the same backend and embedding adapters as
    // Gateway, without activating unrelated explicitly enabled plugins.
    return resolveMemoryPluginIds(params.context);
  }
  return resolveEffectivePluginIds({
    config: params.context.rawConfig,
    workspaceDir: params.context.workspaceDir,
    env: params.context.env,
  });
}

export function ensurePluginRegistryLoaded(options?: {
  scope?: PluginRegistryScope;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): void {
  const scope = options?.scope ?? "all";
  const context = resolvePluginRuntimeLoadContext(options);
  const pluginIds = resolveScopePluginIds({ scope, context });
  const activateConfigured = scope === "configured-channels" && pluginIds.length > 0;
  const config = activateConfigured
    ? (withActivatedPluginIds({ config: context.config, pluginIds }) ?? context.config)
    : context.config;
  const activationSourceConfig = activateConfigured
    ? (withActivatedPluginIds({
        config: context.activationSourceConfig,
        pluginIds,
      }) ?? context.activationSourceConfig)
    : context.activationSourceConfig;
  loadOpenClawPlugins(
    buildPluginRuntimeLoadOptionsFromValues(
      { ...context, config, activationSourceConfig },
      {
        throwOnLoadError: true,
        ...(scope === "configured-channels" ||
        scope === "memory" ||
        scope === "all" ||
        hasNonEmptyPluginIdScope(pluginIds)
          ? { onlyPluginIds: pluginIds }
          : {}),
      },
    ),
  );
}
