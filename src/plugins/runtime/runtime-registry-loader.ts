// Runtime registry loader assembles process-root plugin runtimes from config metadata.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
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

export type PluginRegistryScope =
  | "configured-channels"
  | "channels"
  | "memory"
  | "sandbox-backends"
  | "all";

// Core-owned backends must keep their registry ownership if a plugin reuses an id.
const CORE_SANDBOX_BACKEND_IDS = new Set(["docker", "podman", "ssh"]);

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

function resolveSandboxBackendPluginIds(
  context: ReturnType<typeof resolvePluginRuntimeLoadContext>,
  persistedBackendIds: readonly string[] = [],
): string[] {
  if (!context.metadataSnapshot) {
    return [];
  }
  const agents = context.activationSourceConfig.agents;
  const configuredBackendIds = [
    agents?.defaults?.sandbox?.backend,
    ...Object.values(agents?.entries ?? {}).map((agent) => agent.sandbox?.backend),
    ...(agents?.list ?? []).map((agent) => agent.sandbox?.backend),
    ...persistedBackendIds,
  ];
  const lookup = createInstalledPluginIndexScopeLookup(context.metadataSnapshot.index);
  const pluginIds = new Set<string>();
  for (const backendId of configuredBackendIds) {
    const normalizedBackendId = normalizeOptionalLowercaseString(backendId);
    if (
      !normalizedBackendId ||
      CORE_SANDBOX_BACKEND_IDS.has(normalizedBackendId) ||
      !lookup.hasInstalledPluginIds([normalizedBackendId])
    ) {
      continue;
    }
    // Backend ids have no manifest ownership contract; only an exact installed plugin id is safe.
    pluginIds.add(lookup.normalizePluginId(normalizedBackendId));
  }
  return [...pluginIds].toSorted();
}

function resolveScopePluginIds(params: {
  scope: PluginRegistryScope;
  context: ReturnType<typeof resolvePluginRuntimeLoadContext>;
  persistedSandboxBackendIds?: readonly string[];
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
  if (params.scope === "sandbox-backends") {
    return resolveSandboxBackendPluginIds(params.context, params.persistedSandboxBackendIds);
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
  persistedSandboxBackendIds?: readonly string[];
}): void {
  const scope = options?.scope ?? "all";
  const context = resolvePluginRuntimeLoadContext(options);
  const pluginIds = resolveScopePluginIds({
    scope,
    context,
    persistedSandboxBackendIds: options?.persistedSandboxBackendIds,
  });
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
        scope === "sandbox-backends" ||
        scope === "all" ||
        hasNonEmptyPluginIdScope(pluginIds)
          ? { onlyPluginIds: pluginIds }
          : {}),
      },
    ),
  );
}
