// Gateway plugin bootstrap helpers.
// Resolves activation config before loading or staging a Gateway registry.
import { validateConfiguredBindings } from "../channels/plugins/configured-binding-registry.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  findActiveDegradedPlugin,
  formatPluginVerificationDiagnostic,
} from "../plugins/runtime-degraded-state.js";
import { resolveDurableWorkerProviderAutoEnabledReasons } from "../plugins/worker-provider-manifest.js";
import { mergeActivationSectionsIntoRuntimeConfig } from "./plugin-activation-runtime-config.js";
import { loadGatewayPlugins } from "./server-plugins.js";

type GatewayPluginBootstrapLog = Parameters<typeof loadGatewayPlugins>[0]["log"];
type GatewayPluginBootstrapParams = Omit<
  Parameters<typeof loadGatewayPlugins>[0],
  "autoEnabledReasons"
> & { logDiagnostics?: boolean };

// Keep plugin/source attribution without exposing internal diagnostic objects.
function logGatewayPluginDiagnostics(params: {
  diagnostics: PluginRegistry["diagnostics"];
  log: Pick<GatewayPluginBootstrapLog, "error" | "warn">;
}) {
  for (const diag of params.diagnostics) {
    const degradedPlugin = diag.pluginId ? findActiveDegradedPlugin(diag.pluginId) : undefined;
    // Startup preflight already emitted this typed owner diagnostic. Keep it
    // in the registry for health/status, but do not print it a second time.
    if (
      diag.code === "plugin-verification" &&
      degradedPlugin &&
      diag.message === formatPluginVerificationDiagnostic(degradedPlugin.diagnostic)
    ) {
      continue;
    }
    const details = [
      diag.pluginId ? `plugin=${diag.pluginId}` : null,
      diag.source ? `source=${diag.source}` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(", ");
    const message = details
      ? `[plugins] ${diag.message} (${details})`
      : `[plugins] ${diag.message}`;
    if (diag.level === "error") {
      params.log.error(message);
    } else {
      // `PluginDiagnostic.level` is only "warn" | "error": this branch is every warn diagnostic.
      params.log.warn(message);
    }
  }
}

/** Prepares gateway plugin runtime and returns the loaded plugin registry state. */
export function prepareGatewayPluginLoad(params: GatewayPluginBootstrapParams) {
  const { logDiagnostics = true, ...loadParams } = params;
  const activationSourceConfig = params.activationSourceConfig ?? params.cfg;
  const autoEnabled = applyPluginAutoEnable({
    config: activationSourceConfig,
    env: params.env ?? process.env,
    ...(params.pluginLookUpTable?.manifestRegistry
      ? { manifestRegistry: params.pluginLookUpTable.manifestRegistry }
      : {}),
    discovery: params.pluginLookUpTable?.discovery,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
  const resolvedConfig =
    activationSourceConfig === params.cfg
      ? autoEnabled.config
      : mergeActivationSectionsIntoRuntimeConfig({
          runtimeConfig: params.cfg,
          activationConfig: autoEnabled.config,
        });
  const durableReasons = params.pluginLookUpTable
    ? resolveDurableWorkerProviderAutoEnabledReasons(
        params.pluginLookUpTable.manifestRegistry,
        params.pluginLookUpTable.workerProviderIds,
      )
    : {};
  const autoEnabledReasons = { ...autoEnabled.autoEnabledReasons, ...durableReasons };
  const loaded = loadGatewayPlugins({
    ...loadParams,
    cfg: resolvedConfig,
    activationSourceConfig,
    autoEnabledReasons,
    channelPluginLoadIntent: params.channelPluginLoadIntent ?? "full",
  });
  if (params.loadIntent === undefined) {
    validateConfiguredBindings(resolvedConfig);
  }
  if (logDiagnostics && loaded.pluginRegistry.diagnostics.length > 0) {
    logGatewayPluginDiagnostics({
      diagnostics: loaded.pluginRegistry.diagnostics,
      log: params.log,
    });
  }
  return { ...loaded, resolvedConfig };
}
