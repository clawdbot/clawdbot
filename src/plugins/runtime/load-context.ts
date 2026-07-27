// Plugin runtime load context helpers resolve agent and workspace facts for runtime activation.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  fingerprintPluginAutoEnableConfig,
  fingerprintPluginAutoEnableEnv,
} from "../../config/plugin-auto-enable.apply.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { createSubsystemLogger } from "../../logging.js";
import { resolvePluginActivationSourceConfig } from "../activation-source-config.js";
import {
  clearCurrentPluginMetadataSnapshot,
  isReusableCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../current-plugin-metadata-snapshot.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../installed-plugin-index-install-records.js";
import type { PluginLoadOptions } from "../loader.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugin-metadata-lifecycle.js";
import {
  isPluginMetadataSnapshotCompatible,
  resolvePluginMetadataSnapshot,
} from "../plugin-metadata-snapshot.js";
import type { PluginLogger } from "../types.js";

const log = createSubsystemLogger("plugins");

type CurrentAutoEnableCacheEntry = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  autoEnableConfigFingerprint: string;
  autoEnableEnvFingerprint: string;
  metadataConfigFingerprint: string | undefined;
  pluginIds: readonly string[] | undefined;
  policyHash: string;
  result: ReturnType<typeof applyPluginAutoEnable>;
  workspaceDir: string | undefined;
};

let currentAutoEnableCache: CurrentAutoEnableCacheEntry | undefined;

registerPluginMetadataProcessMemoLifecycleClear(() => {
  currentAutoEnableCache = undefined;
});

function samePluginIds(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((pluginId, index) => pluginId === right[index]))
  );
}

function applyCurrentPluginAutoEnable(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  manifestRegistry: PluginManifestRegistry | undefined;
  snapshot: ReturnType<typeof resolvePluginMetadataSnapshot> | undefined;
}): ReturnType<typeof applyPluginAutoEnable> {
  if (!params.snapshot || !params.manifestRegistry || params.env !== process.env) {
    return applyPluginAutoEnable({
      config: params.config,
      env: params.env,
      manifestRegistry: params.manifestRegistry,
      discovery: params.snapshot?.discovery,
    });
  }
  // Gateway plugin metadata and config are replacement snapshots. Reuse only while
  // mutable config/env content still matches; reload/close lifecycle clears the slot.
  const workspaceDir = params.snapshot.workspaceDir ?? params.workspaceDir;
  const autoEnableConfigFingerprint = fingerprintPluginAutoEnableConfig(params.config);
  const autoEnableEnvFingerprint = fingerprintPluginAutoEnableEnv(params.env);
  const cached = currentAutoEnableCache;
  if (
    cached?.config === params.config &&
    cached.env === params.env &&
    cached.autoEnableConfigFingerprint === autoEnableConfigFingerprint &&
    cached.autoEnableEnvFingerprint === autoEnableEnvFingerprint &&
    cached.metadataConfigFingerprint === params.snapshot.configFingerprint &&
    cached.policyHash === params.snapshot.policyHash &&
    cached.workspaceDir === workspaceDir &&
    samePluginIds(cached.pluginIds, params.snapshot.pluginIds)
  ) {
    return cached.result;
  }
  const result = applyPluginAutoEnable({
    config: params.config,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
    discovery: params.snapshot.discovery,
  });
  currentAutoEnableCache = {
    config: params.config,
    env: params.env,
    autoEnableConfigFingerprint,
    autoEnableEnvFingerprint,
    metadataConfigFingerprint: params.snapshot.configFingerprint,
    pluginIds: params.snapshot.pluginIds,
    policyHash: params.snapshot.policyHash,
    result,
    workspaceDir,
  };
  return result;
}

/** Resolved plugin runtime load context shared by runtime loader callers. */
export type PluginRuntimeLoadContext = {
  rawConfig: OpenClawConfig;
  config: OpenClawConfig;
  activationSourceConfig: OpenClawConfig;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
  workspaceDir: string | undefined;
  env: NodeJS.ProcessEnv;
  logger: PluginLogger;
  manifestRegistry?: PluginManifestRegistry;
  installRecords?: Record<string, PluginInstallRecord>;
};

/** Runtime load option values that can be passed directly to plugin loading. */
type PluginRuntimeResolvedLoadValues = Pick<
  PluginLoadOptions,
  | "config"
  | "activationSourceConfig"
  | "autoEnabledReasons"
  | "workspaceDir"
  | "env"
  | "logger"
  | "manifestRegistry"
  | "installRecords"
>;

/** Options accepted while resolving plugin runtime load context. */
type PluginRuntimeLoadContextOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  logger?: PluginLogger;
  manifestRegistry?: PluginManifestRegistry;
};

/** Creates the default plugin runtime loader logger. */
export function createPluginRuntimeLoaderLogger(): PluginLogger {
  return {
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
    debug: (message) => log.debug(message),
  };
}

/** Resolves config, manifests, install records, and auto-enable state for runtime loads. */
export function resolvePluginRuntimeLoadContext(
  options?: PluginRuntimeLoadContextOptions,
): PluginRuntimeLoadContext {
  const env = options?.env ?? process.env;
  const rawConfig = options?.config ?? getRuntimeConfig();
  const rawWorkspaceDir =
    options?.workspaceDir ?? resolveAgentWorkspaceDir(rawConfig, resolveDefaultAgentId(rawConfig));
  const initialMetadataSnapshot =
    options?.manifestRegistry === undefined
      ? resolvePluginMetadataSnapshot({
          config: rawConfig,
          env,
          workspaceDir: rawWorkspaceDir,
          allowWorkspaceScopedCurrent: true,
        })
      : undefined;
  const manifestRegistry = options?.manifestRegistry ?? initialMetadataSnapshot?.manifestRegistry;
  const activationSourceConfig = resolvePluginActivationSourceConfig({
    config: rawConfig,
    activationSourceConfig: options?.activationSourceConfig,
  });
  const autoEnabled = applyCurrentPluginAutoEnable({
    config: rawConfig,
    env,
    workspaceDir: rawWorkspaceDir,
    manifestRegistry,
    snapshot: initialMetadataSnapshot,
  });
  const config = autoEnabled.config;
  const workspaceDir =
    options?.workspaceDir ?? resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const metadataSnapshot =
    options?.manifestRegistry !== undefined
      ? undefined
      : initialMetadataSnapshot &&
          isPluginMetadataSnapshotCompatible({
            snapshot: initialMetadataSnapshot,
            config,
            env,
            workspaceDir,
          })
        ? initialMetadataSnapshot
        : resolvePluginMetadataSnapshot({
            config,
            env,
            workspaceDir,
            allowWorkspaceScopedCurrent: true,
            ...(initialMetadataSnapshot ? { index: initialMetadataSnapshot.index } : {}),
          });
  const finalManifestRegistry = options?.manifestRegistry ?? metadataSnapshot?.manifestRegistry;
  const installRecords = metadataSnapshot
    ? extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index)
    : undefined;
  if (metadataSnapshot) {
    // Reusable snapshots stay available to later manifest-policy lookups for this runtime load.
    if (isReusableCurrentPluginMetadataSnapshot(metadataSnapshot)) {
      setCurrentPluginMetadataSnapshot(metadataSnapshot, {
        config: rawConfig,
        compatibleConfigs: [config, activationSourceConfig],
        env,
        workspaceDir,
      });
    } else {
      clearCurrentPluginMetadataSnapshot();
    }
  }
  return {
    rawConfig,
    config,
    activationSourceConfig,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    env,
    logger: options?.logger ?? createPluginRuntimeLoaderLogger(),
    ...(finalManifestRegistry ? { manifestRegistry: finalManifestRegistry } : {}),
    installRecords,
  };
}

/** Builds plugin load options from a resolved runtime load context. */
export function buildPluginRuntimeLoadOptions(
  context: PluginRuntimeLoadContext,
  overrides?: Partial<PluginLoadOptions>,
): PluginLoadOptions {
  return buildPluginRuntimeLoadOptionsFromValues(context, overrides);
}

/** Builds plugin load options from explicit runtime load values. */
export function buildPluginRuntimeLoadOptionsFromValues(
  values: PluginRuntimeResolvedLoadValues,
  overrides?: Partial<PluginLoadOptions>,
): PluginLoadOptions {
  return {
    config: values.config,
    activationSourceConfig: values.activationSourceConfig,
    autoEnabledReasons: values.autoEnabledReasons,
    workspaceDir: values.workspaceDir,
    env: values.env,
    logger: values.logger,
    manifestRegistry: values.manifestRegistry,
    installRecords: values.installRecords,
    ...overrides,
  };
}
