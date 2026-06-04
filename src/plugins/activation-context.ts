// Builds plugin activation context from config, discovery, and manifests.
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
} from "./config-state.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import type { PluginDiscoveryResult } from "./discovery.js";

export type PluginActivationCompatConfig = {
  enablementPluginIds?: readonly string[];
  vitestPluginIds?: readonly string[];
};

export type PluginActivationBundledCompatMode = {
  enablement?: "always";
  vitest?: boolean;
};

export type PluginActivationInputs = {
  rawConfig?: OpenClawConfig;
  config?: OpenClawConfig;
  normalized: NormalizedPluginsConfig;
  activationSourceConfig?: OpenClawConfig;
  activationSource: PluginActivationConfigSource;
  autoEnabledReasons: Record<string, string[]>;
};

export type PluginActivationSnapshot = Pick<
  PluginActivationInputs,
  | "rawConfig"
  | "config"
  | "normalized"
  | "activationSourceConfig"
  | "activationSource"
  | "autoEnabledReasons"
>;

export type BundledPluginCompatibleActivationInputs = PluginActivationInputs & {
  compatPluginIds: string[];
};

export type BundledPluginCompatibleLoadValues = Pick<
  BundledPluginCompatibleActivationInputs,
  "rawConfig" | "config" | "activationSourceConfig" | "autoEnabledReasons" | "compatPluginIds"
>;

type BundledPluginCompatibleActivationParams = {
  rawConfig?: OpenClawConfig;
  resolvedConfig?: OpenClawConfig;
  autoEnabledReasons?: Record<string, string[]>;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: readonly string[];
  applyAutoEnable?: boolean;
  compatMode: PluginActivationBundledCompatMode;
  resolveCompatPluginIds: (params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    onlyPluginIds?: readonly string[];
  }) => string[];
  discovery?: PluginDiscoveryResult;
};

export function withActivatedPluginIds(params: {
  config?: OpenClawConfig;
  pluginIds: readonly string[];
  overrideGlobalDisable?: boolean;
  overrideExplicitDisable?: boolean;
}): OpenClawConfig | undefined {
  if (params.pluginIds.length === 0) {
    return params.config;
  }
  const originalAllow = params.config?.plugins?.allow ?? [];
  const useAllowlistDiscovery = originalAllow.length > 0;
  const originalAllowSet = useAllowlistDiscovery ? new Set(originalAllow) : undefined;
  const allow = new Set(originalAllow);
  const entries = {
    ...params.config?.plugins?.entries,
  };
  for (const pluginId of params.pluginIds) {
    const normalized = pluginId.trim();
    if (!normalized) {
      continue;
    }
    if (originalAllowSet && !originalAllowSet.has(normalized)) {
      continue;
    }
    allow.add(normalized);
    const existingEntry = entries[normalized];
    entries[normalized] = {
      ...existingEntry,
      enabled: existingEntry?.enabled !== false || params.overrideExplicitDisable === true,
    };
  }
  const forcePluginsEnabled =
    params.overrideGlobalDisable === true && params.config?.plugins?.enabled === false;
  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      ...(forcePluginsEnabled ? { enabled: true } : {}),
      ...(allow.size > 0 ? { allow: [...allow] } : {}),
      entries,
    },
  };
}

export function applyPluginCompatibilityOverrides(params: {
  config?: OpenClawConfig;
  compat?: PluginActivationCompatConfig;
  env: NodeJS.ProcessEnv;
}): OpenClawConfig | undefined {
  const enablementCompat = params.compat?.enablementPluginIds?.length
    ? withBundledPluginEnablementCompat({
        config: params.config,
        pluginIds: params.compat.enablementPluginIds,
      })
    : params.config;
  const vitestCompat = params.compat?.vitestPluginIds?.length
    ? withBundledPluginVitestCompat({
        config: enablementCompat,
        pluginIds: params.compat.vitestPluginIds,
        env: params.env,
      })
    : enablementCompat;
  return vitestCompat;
}

function shouldResolveBundledCompatPluginIds(params: {
  compatMode: PluginActivationBundledCompatMode;
}): boolean {
  return params.compatMode.enablement === "always" || params.compatMode.vitest === true;
}

function createBundledPluginCompatConfig(params: {
  compatMode: PluginActivationBundledCompatMode;
  compatPluginIds: string[];
}): PluginActivationCompatConfig {
  return {
    enablementPluginIds:
      params.compatMode.enablement === "always" ? params.compatPluginIds : undefined,
    vitestPluginIds: params.compatMode.vitest ? params.compatPluginIds : undefined,
  };
}

function applyPluginAutoEnableForActivation(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  discovery?: PluginDiscoveryResult;
}) {
  const currentSnapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    allowWorkspaceScopedSnapshot: true,
  });
  const defaultDiscoverySnapshot =
    normalizePluginsConfig(params.config.plugins).loadPaths.length === 0
      ? getCurrentPluginMetadataSnapshot({
          env: params.env,
          workspaceDir: params.workspaceDir,
          allowWorkspaceScopedSnapshot: true,
          requireDefaultDiscoveryContext: true,
        })
      : undefined;
  const currentManifestRegistry =
    currentSnapshot?.manifestRegistry ?? defaultDiscoverySnapshot?.manifestRegistry;
  return applyPluginAutoEnable({
    config: params.config,
    env: params.env,
    manifestRegistry: currentManifestRegistry,
    discovery: params.discovery,
  });
}

export function resolvePluginActivationSnapshot(params: {
  rawConfig?: OpenClawConfig;
  resolvedConfig?: OpenClawConfig;
  autoEnabledReasons?: Record<string, string[]>;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  applyAutoEnable?: boolean;
  discovery?: PluginDiscoveryResult;
}): PluginActivationSnapshot {
  const env = params.env ?? process.env;
  const rawConfig = params.rawConfig ?? params.resolvedConfig;
  let resolvedConfig = params.resolvedConfig ?? params.rawConfig;
  let autoEnabledReasons = params.autoEnabledReasons;

  if (params.applyAutoEnable && rawConfig !== undefined) {
    const autoEnabled = applyPluginAutoEnableForActivation({
      config: rawConfig,
      env,
      workspaceDir: params.workspaceDir,
      discovery: params.discovery,
    });
    resolvedConfig = autoEnabled.config;
    autoEnabledReasons = autoEnabled.autoEnabledReasons;
  }

  return {
    rawConfig,
    config: resolvedConfig,
    normalized: normalizePluginsConfig(resolvedConfig?.plugins),
    activationSourceConfig: rawConfig,
    activationSource: createPluginActivationSource({
      config: rawConfig,
    }),
    autoEnabledReasons: autoEnabledReasons ?? {},
  };
}

export function resolvePluginActivationInputs(params: {
  rawConfig?: OpenClawConfig;
  resolvedConfig?: OpenClawConfig;
  autoEnabledReasons?: Record<string, string[]>;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  compat?: PluginActivationCompatConfig;
  applyAutoEnable?: boolean;
  discovery?: PluginDiscoveryResult;
}): PluginActivationInputs {
  const env = params.env ?? process.env;
  const snapshot = resolvePluginActivationSnapshot({
    rawConfig: params.rawConfig,
    resolvedConfig: params.resolvedConfig,
    autoEnabledReasons: params.autoEnabledReasons,
    env,
    workspaceDir: params.workspaceDir,
    applyAutoEnable: params.applyAutoEnable,
    discovery: params.discovery,
  });
  const config = applyPluginCompatibilityOverrides({
    config: snapshot.config,
    compat: params.compat,
    env,
  });

  return {
    rawConfig: snapshot.rawConfig,
    config,
    normalized: normalizePluginsConfig(config?.plugins),
    activationSourceConfig: snapshot.activationSourceConfig,
    activationSource: snapshot.activationSource,
    autoEnabledReasons: snapshot.autoEnabledReasons,
  };
}

export function resolveBundledPluginCompatibleActivationInputs(
  params: BundledPluginCompatibleActivationParams,
): BundledPluginCompatibleActivationInputs {
  const snapshot = resolvePluginActivationSnapshot({
    rawConfig: params.rawConfig,
    resolvedConfig: params.resolvedConfig,
    autoEnabledReasons: params.autoEnabledReasons,
    env: params.env,
    workspaceDir: params.workspaceDir,
    applyAutoEnable: params.applyAutoEnable,
    discovery: params.discovery,
  });
  const shouldResolveCompatPluginIds = shouldResolveBundledCompatPluginIds({
    compatMode: params.compatMode,
  });
  const compatPluginIds = shouldResolveCompatPluginIds
    ? params.resolveCompatPluginIds({
        config: snapshot.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        onlyPluginIds: params.onlyPluginIds,
      })
    : [];
  const activation = resolvePluginActivationInputs({
    rawConfig: snapshot.rawConfig,
    resolvedConfig: snapshot.config,
    autoEnabledReasons: snapshot.autoEnabledReasons,
    env: params.env,
    workspaceDir: params.workspaceDir,
    compat: createBundledPluginCompatConfig({
      compatMode: params.compatMode,
      compatPluginIds,
    }),
    discovery: params.discovery,
  });

  return {
    ...activation,
    compatPluginIds,
  };
}

export function resolveBundledPluginCompatibleLoadValues(
  params: BundledPluginCompatibleActivationParams,
): BundledPluginCompatibleLoadValues {
  const env = params.env ?? process.env;
  const rawConfig = params.rawConfig ?? params.resolvedConfig;
  let resolvedConfig = params.resolvedConfig ?? params.rawConfig;
  let autoEnabledReasons = params.autoEnabledReasons ?? {};

  if (params.applyAutoEnable && rawConfig !== undefined) {
    const autoEnabled = applyPluginAutoEnableForActivation({
      config: rawConfig,
      env,
      workspaceDir: params.workspaceDir,
      discovery: params.discovery,
    });
    resolvedConfig = autoEnabled.config;
    autoEnabledReasons = autoEnabled.autoEnabledReasons;
  }

  const shouldResolveCompatPluginIds = shouldResolveBundledCompatPluginIds({
    compatMode: params.compatMode,
  });
  const compatPluginIds = shouldResolveCompatPluginIds
    ? params.resolveCompatPluginIds({
        config: resolvedConfig,
        workspaceDir: params.workspaceDir,
        env,
        onlyPluginIds: params.onlyPluginIds,
      })
    : [];
  const config = applyPluginCompatibilityOverrides({
    config: resolvedConfig,
    compat: createBundledPluginCompatConfig({
      compatMode: params.compatMode,
      compatPluginIds,
    }),
    env,
  });

  return {
    rawConfig,
    config,
    activationSourceConfig: rawConfig,
    autoEnabledReasons,
    compatPluginIds,
  };
}
