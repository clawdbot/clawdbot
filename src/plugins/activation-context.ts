import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
} from "./config-state.js";

export type PluginActivationCompatConfig = {
  allowlistPluginIds?: readonly string[];
  enablementPluginIds?: readonly string[];
  vitestPluginIds?: readonly string[];
};

export type PluginActivationBundledCompatMode = {
  allowlist?: boolean;
  enablement?: "always" | "allowlist";
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

export function withActivatedPluginIds(params: {
  config?: OpenClawConfig;
  pluginIds: readonly string[];
}): OpenClawConfig | undefined {
  if (params.pluginIds.length === 0) {
    return params.config;
  }
  const allow = new Set(params.config?.plugins?.allow ?? []);
  const entries = {
    ...params.config?.plugins?.entries,
  };
  for (const pluginId of params.pluginIds) {
    const normalized = pluginId.trim();
    if (!normalized) {
      continue;
    }
    allow.add(normalized);
    entries[normalized] = {
      ...entries[normalized],
      enabled: true,
    };
  }
  const forcePluginsEnabled = params.config?.plugins?.enabled === false;
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
  const allowlistCompat = params.compat?.allowlistPluginIds?.length
    ? withBundledPluginAllowlistCompat({
        config: params.config,
        pluginIds: params.compat.allowlistPluginIds,
      })
    : params.config;
  const enablementCompat = params.compat?.enablementPluginIds?.length
    ? withBundledPluginEnablementCompat({
        config: allowlistCompat,
        pluginIds: params.compat.enablementPluginIds,
      })
    : allowlistCompat;
  const vitestCompat = params.compat?.vitestPluginIds?.length
    ? withBundledPluginVitestCompat({
        config: enablementCompat,
        pluginIds: params.compat.vitestPluginIds,
        env: params.env,
      })
    : enablementCompat;
  return vitestCompat;
}

export function resolvePluginActivationSnapshot(params: {
  rawConfig?: OpenClawConfig;
  resolvedConfig?: OpenClawConfig;
  autoEnabledReasons?: Record<string, string[]>;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
}): PluginActivationSnapshot {
  const env = params.env ?? process.env;
  const rawConfig = params.rawConfig ?? params.resolvedConfig;
  let resolvedConfig = params.resolvedConfig ?? params.rawConfig;
  let autoEnabledReasons = params.autoEnabledReasons;

  if (params.applyAutoEnable && rawConfig !== undefined) {
    const autoEnabled = applyPluginAutoEnable({
      config: rawConfig,
      env,
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
  compat?: PluginActivationCompatConfig;
  applyAutoEnable?: boolean;
}): PluginActivationInputs {
  const env = params.env ?? process.env;
  const snapshot = resolvePluginActivationSnapshot({
    rawConfig: params.rawConfig,
    resolvedConfig: params.resolvedConfig,
    autoEnabledReasons: params.autoEnabledReasons,
    env,
    applyAutoEnable: params.applyAutoEnable,
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

export function resolveBundledPluginCompatibleActivationInputs(params: {
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
}): BundledPluginCompatibleActivationInputs {
  const snapshot = resolvePluginActivationSnapshot({
    rawConfig: params.rawConfig,
    resolvedConfig: params.resolvedConfig,
    autoEnabledReasons: params.autoEnabledReasons,
    env: params.env,
    applyAutoEnable: params.applyAutoEnable,
  });
  const allowlistCompatEnabled = params.compatMode.allowlist === true;
  const shouldResolveCompatPluginIds =
    allowlistCompatEnabled ||
    params.compatMode.enablement === "always" ||
    (params.compatMode.enablement === "allowlist" && allowlistCompatEnabled) ||
    params.compatMode.vitest === true;
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
    compat: {
      allowlistPluginIds: allowlistCompatEnabled ? compatPluginIds : undefined,
      enablementPluginIds:
        params.compatMode.enablement === "always" ||
        (params.compatMode.enablement === "allowlist" && allowlistCompatEnabled)
          ? compatPluginIds
          : undefined,
      vitestPluginIds: params.compatMode.vitest ? compatPluginIds : undefined,
    },
  });

  return {
    ...activation,
    compatPluginIds,
  };
}
