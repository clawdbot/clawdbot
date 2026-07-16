import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { BundledPluginSource } from "./bundled-sources.js";
import {
  persistPluginInstall,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import { validateJsonSchemaValue } from "./schema-validator.js";

function hasValidBundledPluginConfig(params: {
  bundledSource: BundledPluginSource;
  existingEntry: unknown;
}): boolean {
  if (!params.bundledSource.requiresConfig) {
    return true;
  }
  if (!isRecord(params.existingEntry)) {
    return false;
  }
  const config = params.existingEntry.config;
  if (!isRecord(config)) {
    return false;
  }
  if (!params.bundledSource.configSchema) {
    return Object.keys(config).length > 0;
  }
  return validateJsonSchemaValue({
    schema: params.bundledSource.configSchema,
    cacheKey: `bundled-install:${params.bundledSource.pluginId}`,
    value: config,
    applyDefaults: true,
  }).ok;
}

function prepareConfigForDisabledBundledInstall(
  config: OpenClawConfig,
  pluginId: string,
): OpenClawConfig {
  const entries = config.plugins?.entries ?? {};
  const { [pluginId]: _removedEntry, ...nextEntries } = entries;
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: nextEntries,
    },
  };
}

export async function installBundledPluginSource(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  rawSpec: string;
  bundledSource: BundledPluginSource;
  warning?: string;
  invalidateRuntimeCache?: boolean;
  runtime?: RuntimeEnv;
}): Promise<{ pluginId: string; warnings: string[] }> {
  // Bundled plugins with required config are recorded but not enabled until config validates.
  const existingEntry = params.snapshot.config.plugins?.entries?.[params.bundledSource.pluginId];
  const shouldEnable = hasValidBundledPluginConfig({
    bundledSource: params.bundledSource,
    existingEntry,
  });
  const configBase = shouldEnable
    ? params.snapshot.config
    : prepareConfigForDisabledBundledInstall(params.snapshot.config, params.bundledSource.pluginId);
  const configWarning = shouldEnable
    ? undefined
    : `Installed bundled plugin "${params.bundledSource.pluginId}" without enabling it because it requires configuration first. Configure it, then run \`openclaw plugins enable ${params.bundledSource.pluginId}\`.`;
  const warnings = [params.warning, configWarning].filter((warning): warning is string =>
    Boolean(warning),
  );
  await persistPluginInstall({
    snapshot: {
      ...params.snapshot,
      config: configBase,
    },
    pluginId: params.bundledSource.pluginId,
    install: {
      source: "path",
      spec: params.rawSpec,
      sourcePath: params.bundledSource.localPath,
      installPath: params.bundledSource.localPath,
    },
    enable: shouldEnable,
    invalidateRuntimeCache: params.invalidateRuntimeCache,
    ...(warnings.length > 0 ? { warningMessage: warnings.join("\n") } : {}),
    runtime: params.runtime,
  });
  return { pluginId: params.bundledSource.pluginId, warnings };
}
