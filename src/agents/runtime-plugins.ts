import type { OpenClawConfig } from "../config/types.openclaw.js";
import { adoptRuntimeContextEngineRegistrations } from "../context-engine/registry.js";
import {
  listLoadedRuntimePluginIds,
  listRuntimePluginIdsFromRegistry,
  registryContainsRuntimePluginIds,
} from "../plugins/active-runtime-registry.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
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
  /** Lifecycle-owned selection; standalone/direct generations stay source-default. */
  preferBuiltPluginArtifacts?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
};

function resolveAgentRuntimePluginRegistryLoad(params: AgentRuntimePluginRegistryParams) {
  const requestedWorkspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  if (params.config && !normalizePluginsConfig(params.config.plugins).enabled) {
    return {
      loadOptions: {
        config: params.config,
        activationSourceConfig: params.config,
        ...(params.env ? { env: params.env } : {}),
        workspaceDir: requestedWorkspaceDir,
        onlyPluginIds: [],
        runtimeOptions: params.allowGatewaySubagentBinding
          ? { allowGatewaySubagentBinding: true }
          : undefined,
      },
    };
  }
  const metadataSnapshot =
    params.metadataSnapshot ??
    loadPluginMetadataSnapshot({
      config: params.config ?? {},
      env: params.env ?? process.env,
      ...(requestedWorkspaceDir ? { workspaceDir: requestedWorkspaceDir } : {}),
    });
  const workspaceDir = metadataSnapshot.workspaceDir ?? requestedWorkspaceDir;
  const metadataLoadOptions = {
    ...(metadataSnapshot.discovery ? { discovery: metadataSnapshot.discovery } : {}),
    installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index),
    manifestRegistry: metadataSnapshot.manifestRegistry,
    ...(params.preferBuiltPluginArtifacts ? { preferBuiltPluginArtifacts: true } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
  };
  const requestPluginRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  // Gateway-hosted fall-through must not cold-load every plugin (30-45s event-loop convoy);
  // startup runtime plugin ids plus selected run owners bound the registry scope.
  const activePluginIds = listLoadedRuntimePluginIds();
  const startupPluginIds =
    params.basePluginIds !== undefined
      ? [...params.basePluginIds]
      : requestPluginRegistry
        ? listRuntimePluginIdsFromRegistry(requestPluginRegistry)
        : metadataSnapshot.pluginIds
          ? [...metadataSnapshot.pluginIds]
          : activePluginIds.length > 0
            ? activePluginIds
            : undefined;
  const planParams = {
    config: params.config,
    workspaceDir: workspaceDir ?? process.cwd(),
    ...(startupPluginIds === undefined ? {} : { basePluginIds: startupPluginIds }),
    selections: resolveAgentRuntimePluginSelections(params.config, params.selections ?? []),
    metadataSnapshot,
  };
  const plan = resolveAgentRuntimePluginLoadPlan(planParams);
  return {
    loadOptions: {
      config: plan.config,
      ...(plan.config ? { activationSourceConfig: plan.config } : {}),
      ...(params.env ? { env: params.env } : {}),
      ...metadataLoadOptions,
      ...(startupPluginIds === undefined || plan.pluginIds === undefined
        ? {}
        : { onlyPluginIds: plan.pluginIds }),
      ...(startupPluginIds === undefined ? {} : { channelPluginLoadIntent: "full" as const }),
      runtimeOptions: params.allowGatewaySubagentBinding
        ? { allowGatewaySubagentBinding: true }
        : undefined,
    },
  };
}

/** Loads the registry handle owned by an agent prepared-runtime generation. */
export function loadAgentRuntimePluginRegistryHandle(
  params: AgentRuntimePluginRegistryParams,
): PluginRegistry {
  const load = resolveAgentRuntimePluginRegistryLoad(params);
  if (
    params.reusableRegistry &&
    load.loadOptions.onlyPluginIds !== undefined &&
    registryContainsRuntimePluginIds(params.reusableRegistry, load.loadOptions.onlyPluginIds)
  ) {
    return params.reusableRegistry;
  }
  // Discovery-only load: full mode can replace process-global sandbox backends.
  // Adopt full-only runtime capabilities from the matching composition-root owners.
  const pluginRegistry = loadPluginRegistryHandle({ ...load.loadOptions, activate: false });
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
  workspaceDir: string;
  run: () => Promise<T>;
}): Promise<T> {
  if (getPluginRuntimeGatewayRequestScope()?.pluginRegistry) {
    return await params.run();
  }
  const pluginRegistry = loadAgentRuntimePluginRegistryHandle({
    basePluginIds: [],
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  return await withPluginRuntimeRegistryScope(pluginRegistry, params.run);
}
