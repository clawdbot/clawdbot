import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { RuntimeEnv } from "../runtime.js";
import type { BundledPluginSource } from "./bundled-sources.js";
import type { ConfigSnapshotForInstallPersist } from "./install-config-mutation.js";
import { persistPluginInstall, prepareConfigForDisabledInstall } from "./install-persistence.js";
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

export async function installBundledPluginSource(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  rawSpec: string;
  bundledSource: BundledPluginSource;
  warning?: string;
  invalidateRuntimeCache?: boolean;
  runtime?: RuntimeEnv;
  beforePersistentApply?: () => void;
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
    : prepareConfigForDisabledInstall(params.snapshot.config, params.bundledSource.pluginId);
  const configWarning = shouldEnable
    ? undefined
    : `Installed bundled plugin "${params.bundledSource.pluginId}" without enabling it because it requires configuration first. Configure it, then run \`openclaw plugins enable ${params.bundledSource.pluginId}\`.`;
  const warnings = [params.warning, configWarning].filter((warning): warning is string =>
    Boolean(warning),
  );
  await persistPluginInstall({
    ...params,
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
    ...(warnings.length > 0 ? { warningMessage: warnings.join("\n") } : {}),
  });
  return { pluginId: params.bundledSource.pluginId, warnings };
}
