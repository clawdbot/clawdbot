import type { OpenClawConfig } from "../config/types.openclaw.js";
import { adoptRuntimeContextEngineRegistrations } from "../context-engine/registry.js";
import {
  listLoadedRuntimePluginIds,
  listRuntimePluginIdsFromRegistry,
  registryContainsRuntimePluginIds,
} from "../plugins/active-runtime-registry.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { loadPluginRegistryHandle, type PluginLoadOptions } from "../plugins/loader.js";
import { adoptRuntimeMemoryRegistrations } from "../plugins/memory-state.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir,
} from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { adoptRuntimeWidgetPresenterRegistrations } from "../plugins/widget-presenters.js";
import { resolveUserPath } from "../utils.js";
import {
  resolveAgentRuntimePluginLoadPlan,
  resolveAgentRuntimePluginSelections,
  type AgentHarnessPluginSelection,
} from "./harness/runtime-plugin-load-plan.js";

type AgentRuntimePluginRegistryParams = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
  /** Explicit base scope for hosts without a Gateway startup registry. */
  basePluginIds?: readonly string[];
  /** Exact registry from the supplied lifecycle metadata generation. */
  reusableRegistry?: PluginRegistry;
  selections?: readonly AgentHarnessPluginSelection[];
  /** Config-wide harness runtimes carried by a prepared lifecycle batch. */
  configuredHarnessRuntimes?: readonly string[];
  /** Lifecycle-owned selection; standalone/direct generations stay source-default. */
  preferBuiltPluginArtifacts?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
};

function resolveAgentRuntimePluginRegistryLoad(
  params: AgentRuntimePluginRegistryParams,
): PluginLoadOptions {
  const loadOptions: PluginLoadOptions = {
    config: params.config,
    activationSourceConfig: params.config,
    env: params.env,
    workspaceDir:
      typeof params.workspaceDir === "string" && params.workspaceDir.trim()
        ? resolveUserPath(params.workspaceDir)
        : undefined,
    runtimeOptions: params.allowGatewaySubagentBinding
      ? { allowGatewaySubagentBinding: true }
      : undefined,
  };
  if (params.config?.plugins?.enabled === false) {
    return { ...loadOptions, onlyPluginIds: [] };
  }
  const metadataSnapshot =
    params.metadataSnapshot ??
    loadPluginMetadataSnapshot({
      config: params.config ?? {},
      env: params.env ?? process.env,
      workspaceDir: loadOptions.workspaceDir,
    });
  const workspaceDir = metadataSnapshot.workspaceDir ?? loadOptions.workspaceDir;
  const requestPluginRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  // Gateway-hosted fall-through must not cold-load every plugin (30-45s event-loop convoy);
  // startup runtime plugin ids plus selected run owners bound the registry scope.
  const activePluginIds = listLoadedRuntimePluginIds();
  const startupPluginIds =
    params.basePluginIds ??
    (requestPluginRegistry
      ? listRuntimePluginIdsFromRegistry(requestPluginRegistry)
      : (metadataSnapshot.pluginIds ?? (activePluginIds.length > 0 ? activePluginIds : undefined)));
  const plan = resolveAgentRuntimePluginLoadPlan({
    config: params.config,
    workspaceDir: workspaceDir ?? process.cwd(),
    basePluginIds: startupPluginIds,
    selections: resolveAgentRuntimePluginSelections(
      params.config,
      params.selections ?? [],
      params.configuredHarnessRuntimes,
    ),
    metadataSnapshot,
  });
  return {
    ...loadOptions,
    config: plan.config,
    activationSourceConfig: plan.config,
    workspaceDir,
    discovery: metadataSnapshot.discovery,
    installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index),
    manifestRegistry: metadataSnapshot.manifestRegistry,
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts,
    onlyPluginIds: startupPluginIds === undefined ? undefined : plan.pluginIds,
    channelPluginLoadIntent: startupPluginIds === undefined ? undefined : "full",
  };
}

/** Loads the registry handle owned by an agent prepared-runtime generation. */
export function loadAgentRuntimePluginRegistryHandle(
  params: AgentRuntimePluginRegistryParams,
): PluginRegistry {
  const loadOptions = resolveAgentRuntimePluginRegistryLoad(params);
  if (
    params.reusableRegistry &&
    loadOptions.onlyPluginIds !== undefined &&
    registryContainsRuntimePluginIds(params.reusableRegistry, loadOptions.onlyPluginIds)
  ) {
    return params.reusableRegistry;
  }
  // Discovery-only load: full mode can replace process-global sandbox backends.
  // Adopt full-only runtime capabilities from the matching composition-root owners.
  const pluginRegistry = loadPluginRegistryHandle({ ...loadOptions, activate: false });
  const activeRegistry = getActivePluginRegistry();
  if (!activeRegistry) {
    return pluginRegistry;
  }
  return adoptRuntimeWidgetPresenterRegistrations(
    adoptRuntimeContextEngineRegistrations(pluginRegistry, activeRegistry),
    activeRegistry,
  );
}

/** Binds a scoped plugin generation when a direct host has no Gateway owner. */
export async function withAgentPluginRegistry<T>(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  selections?: readonly AgentHarnessPluginSelection[];
  workspaceDir: string;
  run: (pluginRegistry: PluginRegistry) => Promise<T>;
}): Promise<T> {
  const requestPluginRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  if (requestPluginRegistry && params.selections === undefined) {
    return await params.run(requestPluginRegistry);
  }
  // Borrowed Gateway registries must not load direct-host context dependencies.
  const [{ setPluginRuntimeLoadContext }, { resolvePluginRuntimeLoadContext }] = await Promise.all([
    import("../plugins/runtime/load-context.js"),
    import("../plugins/runtime/load-context.resolve.js"),
  ]);
  // Direct hosts resolve one policy generation; disabled plugins never reopen discovery.
  const context = resolvePluginRuntimeLoadContext({
    config: params.config,
    activationSourceConfig: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    ...(params.config.plugins?.enabled === false
      ? { manifestRegistry: { plugins: [], diagnostics: [] } }
      : { metadataSnapshot: loadPluginMetadataSnapshot(params) }),
  });
  // The resolver inherits request or configured scope; an empty override drops hook-only plugins.
  const pluginRegistry = loadAgentRuntimePluginRegistryHandle({
    config: params.config,
    env: context.env,
    metadataSnapshot: context.metadataSnapshot,
    selections: params.selections,
    workspaceDir: params.workspaceDir,
  });
  const activeRegistry = getActivePluginRegistry();
  const scopedRegistry =
    activeRegistry &&
    context.metadataSnapshot &&
    getActivePluginRegistryWorkspaceDir() === resolveUserPath(params.workspaceDir)
      ? adoptRuntimeMemoryRegistrations(pluginRegistry, activeRegistry, context.config)
      : pluginRegistry;
  setPluginRuntimeLoadContext(scopedRegistry, context);
  return await withPluginRuntimeRegistryScope(scopedRegistry, () => params.run(scopedRegistry));
}
