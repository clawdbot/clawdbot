import type { OpenClawConfig } from "../config/types.openclaw.js";
import { adoptRuntimeContextEngineRegistrations } from "../context-engine/registry.js";
import { listRuntimePluginIdsFromRegistry } from "../plugins/active-runtime-registry.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { resolveUserPath } from "../utils.js";
import { collectConfiguredAgentHarnessRuntimes } from "./harness-runtimes.js";
import {
  resolveAgentRuntimePluginLoadPlan,
  type AgentHarnessPluginSelection,
} from "./harness/runtime-plugin-load-plan.js";

type StartupScopedPluginSnapshot = NonNullable<
  ReturnType<typeof getCurrentPluginMetadataSnapshot>
> & {
  startup?: {
    pluginIds?: readonly unknown[];
  };
};

function resolveStartupPluginIdsFromCurrentSnapshot(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): string[] | undefined {
  const snapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
  }) as StartupScopedPluginSnapshot | undefined;
  const pluginIds = snapshot?.startup?.pluginIds;
  if (!Array.isArray(pluginIds)) {
    return undefined;
  }
  return pluginIds.filter((pluginId): pluginId is string => typeof pluginId === "string");
}

type AgentRuntimePluginRegistryParams = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
  /** Explicit base scope for hosts without a Gateway startup registry. */
  basePluginIds?: readonly string[];
  selections?: readonly AgentHarnessPluginSelection[];
};

function resolveAgentRuntimePluginRegistryLoad(params: AgentRuntimePluginRegistryParams) {
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  if (params.config && !normalizePluginsConfig(params.config.plugins).enabled) {
    return {
      loadOptions: {
        config: params.config,
        activationSourceConfig: params.config,
        ...(params.env ? { env: params.env } : {}),
        workspaceDir,
        onlyPluginIds: [],
        runtimeOptions: params.allowGatewaySubagentBinding
          ? { allowGatewaySubagentBinding: true }
          : undefined,
      },
    };
  }
  const requestPluginRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const startupPluginIds =
    params.basePluginIds !== undefined
      ? [...params.basePluginIds]
      : requestPluginRegistry
        ? listRuntimePluginIdsFromRegistry(requestPluginRegistry)
        : resolveStartupPluginIdsFromCurrentSnapshot({
            config: params.config,
            env: params.env,
            workspaceDir,
          });
  const plan = resolveAgentRuntimePluginLoadPlan({
    config: params.config,
    workspaceDir: workspaceDir ?? process.cwd(),
    ...(startupPluginIds === undefined ? {} : { basePluginIds: startupPluginIds }),
    selections: [
      ...collectConfiguredAgentHarnessRuntimes(params.config ?? {}).map((runtime) => ({
        runtime,
        provider: "",
        modelId: "",
      })),
      ...(params.selections ?? []),
    ],
  });
  return {
    loadOptions: {
      config: plan.config,
      ...(plan.config ? { activationSourceConfig: plan.config } : {}),
      ...(params.env ? { env: params.env } : {}),
      workspaceDir,
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
  // Discovery-only load: full mode can replace process-global sandbox backends.
  // Copy runtime context engines from the composition-root registry instead.
  const pluginRegistry = loadPluginRegistryHandle({ ...load.loadOptions, activate: false });
  const activeRegistry = getActivePluginRegistry();
  return activeRegistry
    ? adoptRuntimeContextEngineRegistrations(pluginRegistry, activeRegistry)
    : pluginRegistry;
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
