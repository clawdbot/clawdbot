// Lazy plugin-registry loader for CLI commands that need plugin command/capability metadata.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loggingState } from "../logging/state.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { CliPluginRegistryScope } from "./command-catalog.js";

const pluginRegistryModuleLoader = createLazyImportLoader(() => import("./plugin-registry.js"));

function loadPluginRegistryModule() {
  return pluginRegistryModuleLoader.load();
}

/** Load the CLI plugin registry and optionally route activation logs to stderr. */
export async function ensureCliPluginRegistryLoaded(params: {
  scope: CliPluginRegistryScope;
  routeLogsToStderr?: boolean;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
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
    });
  } finally {
    loggingState.forceConsoleToStderr = previousForceStderr;
  }
}
