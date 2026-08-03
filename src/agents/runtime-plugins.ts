import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
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
  selections?: readonly AgentHarnessPluginSelection[];
};

function resolveAgentRuntimePluginRegistryLoad(params: AgentRuntimePluginRegistryParams) {
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;
  if (params.config && !normalizePluginsConfig(params.config.plugins).enabled) {
    return {
      requiredPluginIds: [],
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
  const startupPluginIds = resolveStartupPluginIdsFromCurrentSnapshot({
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
    requiredPluginIds: plan.pluginIds,
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
  return loadPluginRegistryHandle({ ...load.loadOptions, activate: false });
}
