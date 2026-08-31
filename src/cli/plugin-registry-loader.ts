// Lazy plugin-registry loader for CLI commands that need plugin command/capability metadata.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loggingState } from "../logging/state.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { CliPluginRegistryScope } from "./command-catalog.js";
import { measureCliCommandStartup } from "./command-startup-timing.js";

const pluginRegistryModuleLoader = createLazyImportLoader(() => import("./plugin-registry.js"));
const sandboxRegistryModuleLoader = createLazyImportLoader(
  () => import("../agents/sandbox/registry.js"),
);

function loadPluginRegistryModule() {
  return pluginRegistryModuleLoader.load();
}

async function readPersistedSandboxBackendIds(): Promise<string[]> {
  // Management must activate each recorded owner before lifecycle code can
  // inspect or remove its runtime. Configured-only activation strands old rows.
  const { readRegistry } = await sandboxRegistryModuleLoader.load();
  const registry = await readRegistry();
  return [...new Set(registry.entries.map((entry) => entry.backendId ?? "docker"))].toSorted();
}

/** Load the CLI plugin registry and optionally route activation logs to stderr. */
export async function ensureCliPluginRegistryLoaded(params: {
  scope: CliPluginRegistryScope;
  routeLogsToStderr?: boolean;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
}) {
  const persistedSandboxBackendIds =
    params.scope === "sandbox-management"
      ? await measureCliCommandStartup("sandbox-registry-read", readPersistedSandboxBackendIds)
      : undefined;
  const { ensurePluginRegistryLoaded } = await measureCliCommandStartup(
    "plugin-registry-module-import",
    loadPluginRegistryModule,
  );
  await measureCliCommandStartup("plugin-registry-runtime-load", () => {
    const previousForceStderr = loggingState.forceConsoleToStderr;
    if (params.routeLogsToStderr) {
      loggingState.forceConsoleToStderr = true;
    }
    try {
      ensurePluginRegistryLoaded({
        scope: params.scope === "sandbox-management" ? "sandbox-backends" : params.scope,
        ...(params.config ? { config: params.config } : {}),
        ...(params.activationSourceConfig
          ? { activationSourceConfig: params.activationSourceConfig }
          : {}),
        ...(persistedSandboxBackendIds ? { persistedSandboxBackendIds } : {}),
      });
    } finally {
      loggingState.forceConsoleToStderr = previousForceStderr;
    }
  });
}
