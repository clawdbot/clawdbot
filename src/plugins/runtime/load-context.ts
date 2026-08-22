// Plugin runtime load context helpers resolve agent and workspace facts for runtime activation.
import { getRuntimeConfig } from "../../config/config.js";
import { resolveConfigWidePluginManifestRegistry } from "../../config/io.plugin-metadata.js";
import {
  fingerprintPluginAutoEnableConfig,
  fingerprintPluginAutoEnableEnv,
} from "../../config/plugin-auto-enable.apply.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { createSubsystemLogger } from "../../logging.js";
import { resolvePluginActivationSourceConfig } from "../activation-source-config.js";
import { resolvePluginControlPlaneWorkspace } from "../control-plane-workspace.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../installed-plugin-index-install-records.js";
import type { PluginLoadOptions } from "../loader.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugin-metadata-lifecycle.js";
import {
  isPluginMetadataSnapshotCompatible,
  rebasePluginMetadataSnapshotManifestRegistry,
  resolvePluginMetadataSnapshot,
} from "../plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
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
  const workspaceDir = params.snapshot.workspaceDir ?? params.workspaceDir;
  const cached = currentAutoEnableCache;
  const metadataMatches =
    cached !== undefined &&
    cached.metadataConfigFingerprint === params.snapshot.configFingerprint &&
    cached.policyHash === params.snapshot.policyHash &&
    cached.workspaceDir === workspaceDir &&
    samePluginIds(cached.pluginIds, params.snapshot.pluginIds);
  if (metadataMatches) {
    if (cached.config === params.config && cached.env === params.env) {
      return cached.result;
    }
    const autoEnableConfigFingerprint =
      cached.config === params.config
        ? cached.autoEnableConfigFingerprint
        : fingerprintPluginAutoEnableConfig(params.config);
    const autoEnableEnvFingerprint =
      cached.env === params.env
        ? cached.autoEnableEnvFingerprint
        : fingerprintPluginAutoEnableEnv(params.env);
    if (
      cached.autoEnableConfigFingerprint === autoEnableConfigFingerprint &&
      cached.autoEnableEnvFingerprint === autoEnableEnvFingerprint
    ) {
      currentAutoEnableCache = {
        ...cached,
        config: params.config,
        env: params.env,
      };
      return cached.result;
    }
  }
  const result = applyPluginAutoEnable({
    config: params.config,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
    discovery: params.snapshot.discovery,
  });
  const autoEnableConfigFingerprint = fingerprintPluginAutoEnableConfig(params.config);
  const autoEnableEnvFingerprint = fingerprintPluginAutoEnableEnv(params.env);
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
  metadataSnapshot?: PluginMetadataSnapshot;
  installRecords?: Record<string, PluginInstallRecord>;
  preferBuiltPluginArtifacts?: boolean;
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
  | "preferBuiltPluginArtifacts"
>;

/** Options accepted while resolving plugin runtime load context. */
type PluginRuntimeLoadContextOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: readonly string[];
  logger?: PluginLogger;
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: PluginMetadataSnapshot;
  preferBuiltPluginArtifacts?: boolean;
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
  const rawWorkspaceDir = resolvePluginControlPlaneWorkspace({
    config: rawConfig,
    env,
    workspaceDir: options?.workspaceDir,
  }).workspaceDir;
  const resolveMetadataSnapshot = (params: {
    config: OpenClawConfig;
    index?: PluginMetadataSnapshot["index"];
  }): PluginMetadataSnapshot => {
    const snapshot = resolvePluginMetadataSnapshot({
      config: params.config,
      env,
      workspaceDir: rawWorkspaceDir,
      allowWorkspaceScopedCurrent: true,
      ...(params.index ? { index: params.index } : {}),
      ...(options?.onlyPluginIds !== undefined ? { pluginIds: options.onlyPluginIds } : {}),
    });
    if (options?.workspaceDir !== undefined) {
      return snapshot;
    }
    return rebasePluginMetadataSnapshotManifestRegistry(
      snapshot,
      resolveConfigWidePluginManifestRegistry({
        config: params.config,
        env,
        ...(options?.onlyPluginIds !== undefined ? { pluginIds: options.onlyPluginIds } : {}),
      }),
    );
  };
  const initialMetadataSnapshot =
    options?.metadataSnapshot ??
    (options?.manifestRegistry === undefined
      ? resolveMetadataSnapshot({ config: rawConfig })
      : undefined);
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
  const workspaceDir = resolvePluginControlPlaneWorkspace({
    config,
    env,
    workspaceDir: options?.workspaceDir,
  }).workspaceDir;
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
        : resolveMetadataSnapshot({
            config,
            ...(initialMetadataSnapshot ? { index: initialMetadataSnapshot.index } : {}),
          });
  const finalManifestRegistry = options?.manifestRegistry ?? metadataSnapshot?.manifestRegistry;
  const installRecords = metadataSnapshot
    ? extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index)
    : undefined;
  return {
    rawConfig,
    config,
    activationSourceConfig,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    env,
    logger: options?.logger ?? createPluginRuntimeLoaderLogger(),
    ...(finalManifestRegistry ? { manifestRegistry: finalManifestRegistry } : {}),
    ...(metadataSnapshot ? { metadataSnapshot } : {}),
    installRecords,
    preferBuiltPluginArtifacts: options?.preferBuiltPluginArtifacts === true,
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
    preferBuiltPluginArtifacts: values.preferBuiltPluginArtifacts,
    ...overrides,
  };
}
