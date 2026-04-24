import { primeConfiguredBindingRegistry } from "../channels/plugins/binding-registry.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { pinActivePluginChannelRegistry } from "../plugins/runtime.js";
import {
  setGatewayNodesRuntime,
  setGatewaySubagentRuntime,
} from "../plugins/runtime/gateway-bindings.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import {
  createGatewayNodesRuntime,
  createGatewaySubagentRuntime,
  loadGatewayPlugins,
  setPluginSubagentOverridePolicies,
} from "./server-plugins.js";

type GatewayPluginBootstrapLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};

type GatewayPluginBootstrapParams = {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir: string;
  log: GatewayPluginBootstrapLog;
  coreGatewayHandlers: Record<string, GatewayRequestHandler>;
  baseMethods: string[];
  pluginIds?: string[];
  preferSetupRuntimeForChannelPlugins?: boolean;
  suppressPluginInfoLogs?: boolean;
  logDiagnostics?: boolean;
  beforePrimeRegistry?: (pluginRegistry: PluginRegistry) => void;
};

function installGatewayPluginRuntimeEnvironment(cfg: OpenClawConfig) {
  setPluginSubagentOverridePolicies(cfg);
  setGatewaySubagentRuntime(createGatewaySubagentRuntime());
  setGatewayNodesRuntime(createGatewayNodesRuntime());
}

function logGatewayPluginDiagnostics(params: {
  diagnostics: PluginRegistry["diagnostics"];
  log: Pick<GatewayPluginBootstrapLog, "error" | "info">;
}) {
  for (const diag of params.diagnostics) {
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

export function prepareGatewayPluginLoad(params: GatewayPluginBootstrapParams) {
  const activationSourceConfig = params.activationSourceConfig ?? params.cfg;
  const autoEnabled = applyPluginAutoEnable({
    config: activationSourceConfig,
    env: process.env,
  });
  const resolvedConfig = autoEnabled.config;
  installGatewayPluginRuntimeEnvironment(resolvedConfig);
  const loaded = loadGatewayPlugins({
    cfg: resolvedConfig,
    activationSourceConfig,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir: params.workspaceDir,
    log: params.log,
    coreGatewayHandlers: params.coreGatewayHandlers,
    baseMethods: params.baseMethods,
    pluginIds: params.pluginIds,
    preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
    suppressPluginInfoLogs: params.suppressPluginInfoLogs,
  });
  params.beforePrimeRegistry?.(loaded.pluginRegistry);
  primeConfiguredBindingRegistry({ cfg: resolvedConfig });
  if ((params.logDiagnostics ?? true) && loaded.pluginRegistry.diagnostics.length > 0) {
    logGatewayPluginDiagnostics({
      diagnostics: loaded.pluginRegistry.diagnostics,
      log: params.log,
    });
  }
  return loaded;
}

export function loadGatewayStartupPlugins(
  params: Omit<GatewayPluginBootstrapParams, "beforePrimeRegistry">,
) {
  return prepareGatewayPluginLoad({
    ...params,
    beforePrimeRegistry: pinActivePluginChannelRegistry,
  });
}

export function reloadDeferredGatewayPlugins(
  params: Omit<
    GatewayPluginBootstrapParams,
    "beforePrimeRegistry" | "preferSetupRuntimeForChannelPlugins"
  >,
) {
  return prepareGatewayPluginLoad({
    ...params,
    beforePrimeRegistry: pinActivePluginChannelRegistry,
  });
}
