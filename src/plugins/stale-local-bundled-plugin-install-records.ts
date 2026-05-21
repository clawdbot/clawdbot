import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { normalizeBundledLookupPath } from "./bundled-load-path-aliases.js";
import { resolveBundledPluginSources, type BundledPluginSource } from "./bundled-sources.js";

export type StaleLocalBundledPluginInstallRecord = {
  pluginId: string;
  record: PluginInstallRecord;
  recordPathField: "installPath" | "sourcePath";
  stalePath: string;
  bundledPath: string;
};

function normalizePathForCompare(rawPath: string, env?: NodeJS.ProcessEnv): string {
  return path.resolve(normalizeBundledLookupPath(resolveUserPath(rawPath, env)));
}

function primaryInstallRecordPath(record: PluginInstallRecord): {
  field: "installPath" | "sourcePath";
  path: string;
} | null {
  if (typeof record.installPath === "string" && record.installPath.trim()) {
    return { field: "installPath", path: record.installPath };
  }
  if (typeof record.sourcePath === "string" && record.sourcePath.trim()) {
    return { field: "sourcePath", path: record.sourcePath };
  }
  return null;
}

function looksLikeCompiledBundledPluginPath(targetPath: string, pluginId: string): boolean {
  const segments = normalizeBundledLookupPath(targetPath).split(/[\\/]+/u);
  return segments.some((segment, index) => {
    return (
      (segment === "dist" || segment === "dist-runtime") &&
      segments[index + 1] === "extensions" &&
      segments[index + 2] === pluginId
    );
  });
}

function hasStaleBundledVersion(
  record: PluginInstallRecord,
  bundledSource: BundledPluginSource,
): boolean {
  const recordVersion = record.version?.trim();
  const bundledVersion = bundledSource.version?.trim();
  return Boolean(recordVersion && bundledVersion && recordVersion !== bundledVersion);
}

export function listStaleLocalBundledPluginInstallRecords(params: {
  installRecords: Record<string, PluginInstallRecord>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  bundled?: ReadonlyMap<string, BundledPluginSource>;
}): StaleLocalBundledPluginInstallRecord[] {
  const bundled =
    params.bundled ??
    resolveBundledPluginSources({
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  const stale: StaleLocalBundledPluginInstallRecord[] = [];

  for (const [pluginId, record] of Object.entries(params.installRecords).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (record.source !== "path") {
      continue;
    }
    const bundledSource = bundled.get(pluginId);
    if (!bundledSource?.localPath) {
      continue;
    }
    if (!hasStaleBundledVersion(record, bundledSource)) {
      continue;
    }
    const recordPath = primaryInstallRecordPath(record);
    if (!recordPath) {
      continue;
    }
    const stalePath = normalizePathForCompare(recordPath.path, params.env);
    const bundledPath = normalizePathForCompare(bundledSource.localPath, params.env);
    if (stalePath === bundledPath) {
      continue;
    }
    if (!looksLikeCompiledBundledPluginPath(stalePath, pluginId)) {
      continue;
    }
    stale.push({
      pluginId,
      record,
      recordPathField: recordPath.field,
      stalePath,
      bundledPath,
    });
  }

  return stale;
}

export function pruneStaleLocalBundledPluginInstallRecords(params: {
  installRecords: Record<string, PluginInstallRecord>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  bundled?: ReadonlyMap<string, BundledPluginSource>;
}): {
  records: Record<string, PluginInstallRecord>;
  stale: StaleLocalBundledPluginInstallRecord[];
} {
  const stale = listStaleLocalBundledPluginInstallRecords(params);
  if (stale.length === 0) {
    return { records: params.installRecords, stale };
  }
  const staleIds = new Set(stale.map((record) => record.pluginId));
  return {
    records: Object.fromEntries(
      Object.entries(params.installRecords).filter(([pluginId]) => !staleIds.has(pluginId)),
    ),
    stale,
  };
}
