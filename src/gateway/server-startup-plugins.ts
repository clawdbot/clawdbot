import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { runChannelPluginStartupMaintenance } from "../channels/plugins/lifecycle-startup.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  repairBundledRuntimeDepsInstallRootAsync,
  resolveBundledRuntimeDependencyPackageInstallRoot,
  scanBundledPluginRuntimeDeps,
} from "../plugins/bundled-runtime-deps.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { loadGatewayStartupPlugins } from "./server-plugin-bootstrap.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

type GatewayPluginBootstrapLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

async function prestageGatewayBundledRuntimeDeps(params: {
  cfg: OpenClawConfig;
  pluginIds: readonly string[];
  log: GatewayPluginBootstrapLog;
}): Promise<void> {
  if (params.pluginIds.length === 0) {
    return;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  if (!packageRoot) {
    return;
  }
  let scanResult: ReturnType<typeof scanBundledPluginRuntimeDeps>;
  try {
    scanResult = scanBundledPluginRuntimeDeps({
      packageRoot,
      config: params.cfg,
      selectedPluginIds: [...params.pluginIds],
      env: process.env,
    });
  } catch (error) {
    params.log.warn(
      `[plugins] failed to scan bundled runtime deps before gateway startup; gateway startup will continue with per-plugin runtime-deps installs: ${String(error)}`,
    );
    return;
  }
  const { deps, missing, conflicts } = scanResult;
  if (conflicts.length > 0) {
    params.log.warn(
      `[plugins] bundled runtime deps have version conflicts: ${conflicts.map((conflict) => `${conflict.name} (${conflict.versions.join(", ")})`).join("; ")}`,
    );
  }
  if (missing.length === 0) {
    return;
  }
  const missingSpecs = missing.map((dep) => `${dep.name}@${dep.version}`);
  const installSpecs = deps.map((dep) => `${dep.name}@${dep.version}`);
  const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, {
    env: process.env,
  });
  const startedAt = Date.now();
  params.log.info(
    `[plugins] staging bundled runtime deps before gateway startup (${missingSpecs.length} missing, ${installSpecs.length} install specs): ${missingSpecs.join(", ")}`,
  );
  try {
    await repairBundledRuntimeDepsInstallRootAsync({
      installRoot,
      missingSpecs,
      installSpecs,
      env: process.env,
      warn: (message) => params.log.warn(`[plugins] ${message}`),
    });
  } catch (error) {
    params.log.warn(
      `[plugins] failed to stage bundled runtime deps before gateway startup after ${Date.now() - startedAt}ms; gateway startup will continue with per-plugin runtime-deps installs: ${String(error)}`,
    );
    return;
  }
  params.log.info(
    `[plugins] installed bundled runtime deps before gateway startup in ${Date.now() - startedAt}ms: ${missingSpecs.join(", ")}`,
  );
}

export async function prepareGatewayPluginBootstrap(params: {
  cfgAtStart: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
}) {
  const startupMaintenanceConfig =
    params.cfgAtStart.channels === undefined && params.startupRuntimeConfig.channels !== undefined
      ? {
          ...params.cfgAtStart,
          channels: params.startupRuntimeConfig.channels,
        }
      : params.cfgAtStart;

  const shouldRunStartupMaintenance =
    !params.minimalTestGateway || startupMaintenanceConfig.channels !== undefined;
  if (shouldRunStartupMaintenance) {
    const startupTasks = [
      runChannelPluginStartupMaintenance({
        cfg: startupMaintenanceConfig,
        env: process.env,
        log: params.log,
      }),
    ];
    if (!params.minimalTestGateway) {
      startupTasks.push(
        runStartupSessionMigration({
          cfg: params.cfgAtStart,
          env: process.env,
          log: params.log,
        }),
      );
    }
    await Promise.all(startupTasks);
  }

  initSubagentRegistry();

  const gatewayPluginConfig = params.minimalTestGateway
    ? params.cfgAtStart
    : applyPluginAutoEnable({
        config: params.cfgAtStart,
        env: process.env,
      }).config;
  const defaultAgentId = resolveDefaultAgentId(gatewayPluginConfig);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(gatewayPluginConfig, defaultAgentId);
  const pluginLookUpTable = params.minimalTestGateway
    ? undefined
    : loadPluginLookUpTable({
        config: gatewayPluginConfig,
        workspaceDir: defaultWorkspaceDir,
        env: process.env,
        activationSourceConfig: params.cfgAtStart,
      });
  const deferredConfiguredChannelPluginIds = [
    ...(pluginLookUpTable?.startup.configuredDeferredChannelPluginIds ?? []),
  ];
  const startupPluginIds = [...(pluginLookUpTable?.startup.pluginIds ?? [])];

  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  let pluginRegistry = emptyPluginRegistry;
  let baseGatewayMethods = baseMethods;

  if (!params.minimalTestGateway) {
    await prestageGatewayBundledRuntimeDeps({
      cfg: gatewayPluginConfig,
      pluginIds: startupPluginIds,
      log: params.log,
    });
    ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = loadGatewayStartupPlugins({
      cfg: gatewayPluginConfig,
      activationSourceConfig: params.cfgAtStart,
      workspaceDir: defaultWorkspaceDir,
      log: params.log,
      coreGatewayMethodNames: baseMethods,
      baseMethods,
      pluginIds: startupPluginIds,
      pluginLookUpTable,
      preferSetupRuntimeForChannelPlugins: deferredConfiguredChannelPluginIds.length > 0,
      suppressPluginInfoLogs: deferredConfiguredChannelPluginIds.length > 0,
    }));
  } else {
    pluginRegistry = getActivePluginRegistry() ?? emptyPluginRegistry;
    setActivePluginRegistry(pluginRegistry);
  }

  return {
    gatewayPluginConfigAtStart: gatewayPluginConfig,
    defaultWorkspaceDir,
    deferredConfiguredChannelPluginIds,
    startupPluginIds,
    pluginLookUpTable,
    baseMethods,
    pluginRegistry,
    baseGatewayMethods,
  };
}
