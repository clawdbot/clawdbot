import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { runChannelPluginStartupMaintenance } from "../channels/plugins/lifecycle-startup.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../infra/diagnostics-timeline.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  pruneUnknownBundledRuntimeDepsRoots,
  repairBundledRuntimeDepsInstallRootAsync,
  resolveBundledRuntimeDependencyPackageInstallRoot,
  scanBundledPluginRuntimeDeps,
} from "../plugins/bundled-runtime-deps.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { mergeActivationSectionsIntoRuntimeConfig } from "./plugin-activation-runtime-config.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { loadGatewayStartupPlugins } from "./server-plugin-bootstrap.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

type GatewayPluginBootstrapLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

export function resolveGatewayStartupMaintenanceConfig(params: {
  cfgAtStart: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
}): OpenClawConfig {
  return params.cfgAtStart.channels === undefined &&
    params.startupRuntimeConfig.channels !== undefined
    ? {
        ...params.cfgAtStart,
        channels: params.startupRuntimeConfig.channels,
      }
    : params.cfgAtStart;
}

async function prestageGatewayBundledRuntimeDeps(params: {
  cfg: OpenClawConfig;
  pluginIds: readonly string[];
  log: GatewayPluginBootstrapLog;
}): Promise<void> {
  await measureDiagnosticsTimelineSpan(
    "runtimeDeps.stage",
    () => prestageGatewayBundledRuntimeDepsImpl(params),
    {
      phase: "startup",
      config: params.cfg,
      attributes: {
        pluginCount: params.pluginIds.length,
      },
    },
  );
}

async function prestageGatewayBundledRuntimeDepsImpl(params: {
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
  const pruned = pruneUnknownBundledRuntimeDepsRoots({
    env: process.env,
    warn: (message) => params.log.warn(`[plugins] ${message}`),
  });
  if (pruned.removed > 0) {
    params.log.info(
      `[plugins] pruned stale bundled runtime deps roots (${pruned.removed} removed, ${pruned.skippedLocked} locked, ${pruned.scanned} scanned)`,
    );
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
  const installSpecs = deps.map((dep) => `${dep.name}@${dep.version}`);
  const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, {
    env: process.env,
  });
  const startedAt = Date.now();
  params.log.info(
    `[plugins] staging bundled runtime deps before gateway startup (${installSpecs.length} specs): ${installSpecs.join(", ")}`,
  );
  try {
    await repairBundledRuntimeDepsInstallRootAsync({
      installRoot,
      missingSpecs: installSpecs,
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
    `[plugins] installed bundled runtime deps before gateway startup in ${Date.now() - startedAt}ms: ${installSpecs.join(", ")}`,
  );
}

export async function prepareGatewayPluginBootstrap(params: {
  cfgAtStart: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
}) {
  const activationSourceConfig = params.activationSourceConfig ?? params.cfgAtStart;
  const startupMaintenanceConfig = resolveGatewayStartupMaintenanceConfig({
    cfgAtStart: params.cfgAtStart,
    startupRuntimeConfig: params.startupRuntimeConfig,
  });

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
    : mergeActivationSectionsIntoRuntimeConfig({
        runtimeConfig: params.cfgAtStart,
        activationConfig: applyPluginAutoEnable({
          config: activationSourceConfig,
          env: process.env,
          ...(params.pluginMetadataSnapshot?.manifestRegistry
            ? { manifestRegistry: params.pluginMetadataSnapshot.manifestRegistry }
            : {}),
        }).config,
      });
  const pluginsGloballyDisabled = gatewayPluginConfig.plugins?.enabled === false;
  const defaultAgentId = resolveDefaultAgentId(gatewayPluginConfig);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(gatewayPluginConfig, defaultAgentId);
  const pluginLookUpTable =
    params.minimalTestGateway || pluginsGloballyDisabled
      ? undefined
      : loadPluginLookUpTable({
          config: gatewayPluginConfig,
          workspaceDir: defaultWorkspaceDir,
          env: process.env,
          activationSourceConfig,
          metadataSnapshot: params.pluginMetadataSnapshot,
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
      activationSourceConfig,
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
