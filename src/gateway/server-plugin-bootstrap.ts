// Gateway plugin bootstrap helpers.
// Applies activation config and loads the process-root plugin registry.
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { primeConfiguredBindingRegistry } from "../channels/plugins/configured-binding-registry.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelPluginLoadIntent } from "../plugins/loader-types.js";
import type { PluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import type { PluginRegistryParams } from "../plugins/registry-types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  findActiveDegradedPlugin,
  formatPluginVerificationDiagnostic,
} from "../plugins/runtime-degraded-state.js";
import { resolveDurableWorkerProviderAutoEnabledReasons } from "../plugins/worker-provider-manifest.js";
import { mergeActivationSectionsIntoRuntimeConfig } from "./plugin-activation-runtime-config.js";
import type { GatewayContextResolver, GatewayRequestHandler } from "./server-methods/types.js";
import { loadGatewayPlugins } from "./server-plugins.js";

// Gateway plugin bootstrap applies activation/auto-enable config, loads plugins,
// and primes channel bindings for startup/reload paths.
type GatewayPluginBootstrapLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};

type GatewayStartupTrace = {
  detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
};

type GatewayPluginBootstrapParams = {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  log: GatewayPluginBootstrapLog;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  baseMethods: string[];
  pluginIds?: string[];
  pluginLookUpTable?: PluginLookUpTable;
  channelPluginLoadIntent?: ChannelPluginLoadIntent;
  suppressPluginInfoLogs?: boolean;
  logDiagnostics?: boolean;
  startupTrace?: GatewayStartupTrace;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  resolveGatewayContext?: GatewayContextResolver;
};

// Diagnostics are logged after registry priming so startup output contains
// plugin ids/source hints without exposing internal diagnostic objects.
function logGatewayPluginDiagnostics(params: {
  diagnostics: PluginRegistry["diagnostics"];
  log: Pick<GatewayPluginBootstrapLog, "error" | "info">;
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
      params.log.info(message);
    }
  }
}

/** Prepares gateway plugin runtime and returns the loaded plugin registry state. */
export function prepareGatewayPluginLoad(params: GatewayPluginBootstrapParams) {
  const activationSourceConfig = params.activationSourceConfig ?? params.cfg;
  const autoEnabled = applyPluginAutoEnable({
    config: activationSourceConfig,
    env: process.env,
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
    cfg: resolvedConfig,
    activationSourceConfig,
    autoEnabledReasons,
    workspaceDir: params.workspaceDir,
    log: params.log,
    ...(params.coreGatewayHandlers !== undefined && {
      coreGatewayHandlers: params.coreGatewayHandlers,
    }),
    ...(params.coreGatewayMethodNames !== undefined && {
      coreGatewayMethodNames: params.coreGatewayMethodNames,
    }),
    ...(params.hostServices !== undefined && {
      hostServices: params.hostServices,
    }),
    baseMethods: params.baseMethods,
    pluginIds: params.pluginIds,
    pluginLookUpTable: params.pluginLookUpTable,
    channelPluginLoadIntent: params.channelPluginLoadIntent ?? "full",
    suppressPluginInfoLogs: params.suppressPluginInfoLogs,
    startupTrace: params.startupTrace,
    ambientEnvTriggers: params.ambientEnvTriggers,
    ...(params.resolveGatewayContext
      ? { resolveGatewayContext: params.resolveGatewayContext }
      : {}),
  });
  primeConfiguredBindingRegistry({ cfg: resolvedConfig });
  if ((params.logDiagnostics ?? true) && loaded.pluginRegistry.diagnostics.length > 0) {
    logGatewayPluginDiagnostics({
      diagnostics: loaded.pluginRegistry.diagnostics,
      log: params.log,
    });
  }
  return loaded;
}

/** Loads gateway plugins during normal gateway startup. */
export function loadGatewayStartupPlugins(params: GatewayPluginBootstrapParams) {
  return prepareGatewayPluginLoad(params);
}
