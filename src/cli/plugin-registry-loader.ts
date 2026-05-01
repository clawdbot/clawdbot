import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loggingState } from "../logging/state.js";
import type { CliPluginRegistryScope } from "./command-catalog.js";

let pluginRegistryModulePromise: Promise<typeof import("./plugin-registry.js")> | undefined;

function loadPluginRegistryModule() {
  pluginRegistryModulePromise ??= import("./plugin-registry.js");
  return pluginRegistryModulePromise;
}

export type CliPluginRegistryLoadPolicy = {
  scope: CliPluginRegistryScope;
  installBundledRuntimeDeps?: boolean;
};

export async function ensureCliPluginRegistryLoaded(params: {
  scope: CliPluginRegistryScope;
  routeLogsToStderr?: boolean;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  installBundledRuntimeDeps?: boolean;
}) {
  const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
  const previousForceStderr = loggingState.forceConsoleToStderr;
  if (params.routeLogsToStderr) {
    loggingState.forceConsoleToStderr = true;
  }
  try {
    ensurePluginRegistryLoaded({
      scope: params.scope,
      ...(params.config ? { config: params.config } : {}),
      ...(params.activationSourceConfig
        ? { activationSourceConfig: params.activationSourceConfig }
        : {}),
      ...(params.installBundledRuntimeDeps !== undefined
        ? { installBundledRuntimeDeps: params.installBundledRuntimeDeps }
        : {}),
    });
  } finally {
    loggingState.forceConsoleToStderr = previousForceStderr;
  }
}
