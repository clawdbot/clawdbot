import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { BundledPluginSource } from "./bundled-sources.js";
import {
  persistPluginInstall,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import { validateJsonSchemaValue } from "./schema-validator.js";

type BundledPluginConfigEnablement =
  | { mode: "ready" }
  | { mode: "missing" }
  | { mode: "invalid"; error: string };

function resolveBundledPluginConfigEnablement(params: {
  bundledSource: BundledPluginSource;
  existingEntry: unknown;
}): BundledPluginConfigEnablement {
  if (!params.bundledSource.requiresConfig) {
    return { mode: "ready" };
  }
  const entry = isRecord(params.existingEntry) ? params.existingEntry : undefined;
  if (!entry || !Object.hasOwn(entry, "config")) {
    return { mode: "missing" };
  }
  const config = entry.config;
  if (!params.bundledSource.configSchema) {
    return isRecord(config) && Object.keys(config).length > 0
      ? { mode: "ready" }
      : { mode: "invalid", error: "config must be a non-empty object" };
  }
  const result = validateJsonSchemaValue({
    schema: params.bundledSource.configSchema,
    cacheKey: `bundled-install:${params.bundledSource.pluginId}`,
    value: config,
    applyDefaults: true,
  });
  return result.ok
    ? { mode: "ready" }
    : { mode: "invalid", error: result.errors[0]?.text ?? "invalid plugin config" };
}

function prepareConfigForDisabledBundledInstall(
  config: OpenClawConfig,
  pluginId: string,
): OpenClawConfig {
  const entry = config.plugins?.entries?.[pluginId];
  const policy = isRecord(entry) ? { ...entry } : {};
  delete policy.config;
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [pluginId]: { ...policy, enabled: false },
      },
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
  const configEnablement = resolveBundledPluginConfigEnablement({
    bundledSource: params.bundledSource,
    existingEntry,
  });
  if (configEnablement.mode === "invalid") {
    throw new Error(
      `Plugin "${params.bundledSource.pluginId}" has invalid configured settings: ${configEnablement.error}. Fix plugins.entries.${params.bundledSource.pluginId}.config, then rerun the install.`,
    );
  }
  const shouldEnable = configEnablement.mode === "ready";
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
