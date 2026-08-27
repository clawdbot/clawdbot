// Normalizes installed plugin config and install records.
import {
  copyPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { buildNpmResolutionFields, type NpmSpecResolution } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveUserPath } from "../utils.js";

/** Plugin install record update with the target plugin id attached. */
export type PluginInstallUpdate = PluginInstallRecord & { pluginId: string };

type NpmInstallPathRecord = Pick<PluginInstallRecord, "source" | "installPath">;

export function configReferencesNpmInstallPath(params: {
  config: OpenClawConfig;
  install: NpmInstallPathRecord | undefined;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const installPath = params.install?.installPath;
  if (params.install?.source !== "npm" || !installPath) {
    return false;
  }
  const resolvedInstallPath = resolveUserPath(installPath, params.env);
  return Boolean(
    params.config.plugins?.load?.paths?.some(
      (entry) => resolveUserPath(entry, params.env) === resolvedInstallPath,
    ),
  );
}

export function reconcileNpmPluginLoadPath(params: {
  config: OpenClawConfig;
  previousInstall: NpmInstallPathRecord | undefined;
  nextInstall: NpmInstallPathRecord;
  env?: NodeJS.ProcessEnv;
}): OpenClawConfig {
  const previousPath = params.previousInstall?.installPath;
  const nextPath = params.nextInstall.installPath;
  if (
    params.previousInstall?.source !== "npm" ||
    params.nextInstall.source !== "npm" ||
    !previousPath ||
    !nextPath
  ) {
    return params.config;
  }
  const previousResolved = resolveUserPath(previousPath, params.env);
  const nextResolved = resolveUserPath(nextPath, params.env);
  const existing = params.config.plugins?.load?.paths;
  if (previousResolved === nextResolved || !existing?.length) {
    return params.config;
  }
  const replaceAt = existing.findIndex(
    (entry) => resolveUserPath(entry, params.env) === previousResolved,
  );
  if (replaceAt < 0) {
    return params.config;
  }
  const existingNextAt = existing.findIndex(
    (entry) => resolveUserPath(entry, params.env) === nextResolved,
  );

  // An explicit reference to the prior managed root carries precedence intent.
  // Preserve an existing target slot; otherwise move the prior slot with the record.
  const paths = existing.flatMap((entry, index) => {
    const resolved = resolveUserPath(entry, params.env);
    if (existingNextAt >= 0) {
      if (
        resolved === previousResolved ||
        (resolved === nextResolved && index !== existingNextAt)
      ) {
        return [];
      }
      return [entry];
    }
    if (index === replaceAt) {
      return [nextPath];
    }
    return resolved === previousResolved ? [] : [entry];
  });
  return {
    ...params.config,
    plugins: {
      ...params.config.plugins,
      load: { ...params.config.plugins?.load, paths },
    },
  };
}

/** Builds install record fields from resolved npm package metadata. */
export function buildNpmResolutionInstallFields(
  resolution?: NpmSpecResolution,
): Pick<
  PluginInstallRecord,
  "resolvedName" | "resolvedVersion" | "resolvedSpec" | "integrity" | "shasum" | "resolvedAt"
> {
  return buildNpmResolutionFields(resolution);
}

function isExactRegistryNpmSpec(spec: string | undefined): spec is string {
  const parsed = spec ? parseRegistryNpmSpec(spec) : null;
  return parsed?.selectorKind === "exact-version";
}

export function resolveNpmInstallRecordSpec(params: {
  requestedSpec?: string;
  resolution?: NpmSpecResolution;
  pinResolvedRegistrySpec?: boolean;
}): string | undefined {
  const resolvedSpec = params.resolution?.resolvedSpec;
  if (!params.pinResolvedRegistrySpec || !isExactRegistryNpmSpec(resolvedSpec)) {
    return params.requestedSpec;
  }
  return resolvedSpec;
}

/** Replaces a plugin install record with the authoritative completed install. */
export function recordPluginInstall(
  cfg: OpenClawConfig,
  update: PluginInstallUpdate,
): OpenClawConfig {
  const { pluginId, ...record } = update;
  const nextRecord = {
    ...record,
    installedAt: record.installedAt ?? new Date().toISOString(),
  };
  const installs = copyPluginInstallRecordMap(cfg.plugins?.installs);
  setPluginInstallRecordMapEntry(installs, pluginId, nextRecord);

  const next = {
    ...cfg,
    plugins: {
      // cfg.plugins may be absent on first install; spreading undefined is {}.
      ...cfg.plugins,
      installs,
    },
  };
  return reconcileNpmPluginLoadPath({
    config: next,
    previousInstall: getPluginInstallRecordMapEntry(cfg.plugins?.installs, pluginId),
    nextInstall: nextRecord,
  });
}
