import fs from "node:fs";
import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { tryReadJson, tryReadJsonSync } from "../infra/json-files.js";
import { isRecord } from "../shared/record-coerce.js";
import { resolveDefaultPluginNpmDir, validatePluginId } from "./install-paths.js";
import {
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";
import { listManagedPluginNpmProjectRootsSync } from "./npm-project-roots.js";

function cloneInstallRecords(
  records: Record<string, PluginInstallRecord> | undefined,
): Record<string, PluginInstallRecord> {
  return readRecordMap(records) ?? {};
}

const BLOCKED_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeRecordKey(key: string): boolean {
  return !BLOCKED_RECORD_KEYS.has(key);
}

function readRecordMap(value: unknown): Record<string, PluginInstallRecord> | null {
  if (!isRecord(value)) {
    return null;
  }
  const records: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, record] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isSafeRecordKey(pluginId)) {
      continue;
    }
    if (isRecord(record) && typeof record.source === "string") {
      records[pluginId] = structuredClone(record) as PluginInstallRecord;
    }
  }
  return records;
}

function readJsonObjectFileSync(filePath: string): Record<string, unknown> | null {
  const parsed = tryReadJsonSync(filePath);
  return isRecord(parsed) ? parsed : null;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const record: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isSafeRecordKey(key)) {
      continue;
    }
    if (typeof raw === "string" && raw.trim()) {
      record[key] = raw.trim();
    }
  }
  return record;
}

function hasPackagePluginMetadata(manifest: Record<string, unknown>): boolean {
  const openclaw = manifest.openclaw;
  if (!isRecord(openclaw)) {
    return false;
  }
  const extensions = openclaw.extensions;
  return Array.isArray(extensions) && extensions.some((entry) => typeof entry === "string");
}

function readManifestPluginId(packageDir: string): string | undefined {
  const manifest = readJsonObjectFileSync(path.join(packageDir, "openclaw.plugin.json"));
  const id = typeof manifest?.id === "string" ? manifest.id.trim() : "";
  return id || undefined;
}

function resolveRecoveredManagedNpmRoot(options: InstalledPluginIndexStoreOptions = {}): string {
  return path.resolve(
    options.stateDir ? path.join(options.stateDir, "npm") : resolveDefaultPluginNpmDir(options.env),
  );
}

function resolveRecoveredManagedNpmPluginId(params: {
  packageName: string;
  packageDir: string;
}): string | undefined {
  const packageManifest = readJsonObjectFileSync(path.join(params.packageDir, "package.json"));
  if (!packageManifest || !hasPackagePluginMetadata(packageManifest)) {
    return undefined;
  }
  const packageName =
    typeof packageManifest.name === "string" && packageManifest.name.trim()
      ? packageManifest.name.trim()
      : params.packageName;
  const pluginId = readManifestPluginId(params.packageDir) ?? packageName;
  return validatePluginId(pluginId) ? undefined : pluginId;
}

function buildRecoveredManagedNpmInstallRecordsForRoot(
  npmRoot: string,
): Record<string, PluginInstallRecord> {
  const rootManifest = readJsonObjectFileSync(path.join(npmRoot, "package.json"));
  const dependencies = readStringRecord(rootManifest?.dependencies);
  const records: Record<string, PluginInstallRecord> = {};
  for (const [packageName, dependencySpec] of Object.entries(dependencies)) {
    const packageDir = path.join(npmRoot, "node_modules", ...packageName.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(packageDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    const pluginId = resolveRecoveredManagedNpmPluginId({ packageName, packageDir });
    if (!pluginId) {
      continue;
    }
    const packageManifest = readJsonObjectFileSync(path.join(packageDir, "package.json"));
    const version =
      typeof packageManifest?.version === "string" && packageManifest.version.trim()
        ? packageManifest.version.trim()
        : undefined;
    records[pluginId] = {
      source: "npm",
      spec: `${packageName}@${dependencySpec}`,
      installPath: packageDir,
      ...(version ? { version, resolvedName: packageName, resolvedVersion: version } : {}),
      ...(version ? { resolvedSpec: `${packageName}@${version}` } : {}),
    };
  }
  return records;
}

function buildRecoveredManagedNpmInstallRecords(
  options: InstalledPluginIndexStoreOptions = {},
): Record<string, PluginInstallRecord> {
  const npmRoot = resolveRecoveredManagedNpmRoot(options);
  const legacyRecords = buildRecoveredManagedNpmInstallRecordsForRoot(npmRoot);
  const projectRecords: Record<string, PluginInstallRecord> = {};
  for (const projectRoot of listManagedPluginNpmProjectRootsSync(npmRoot)) {
    Object.assign(projectRecords, buildRecoveredManagedNpmInstallRecordsForRoot(projectRoot));
  }
  return { ...legacyRecords, ...projectRecords };
}

function recordsShareInstallPath(
  left: PluginInstallRecord | undefined,
  right: PluginInstallRecord,
): boolean {
  if (!left?.installPath || !right.installPath) {
    return false;
  }
  return path.resolve(left.installPath) === path.resolve(right.installPath);
}

function readInstallRecordVersion(record: PluginInstallRecord | undefined): string | undefined {
  return record?.resolvedVersion ?? record?.version;
}

function mergeRecoveredManagedNpmRecord(params: {
  persisted: PluginInstallRecord | undefined;
  recovered: PluginInstallRecord;
}): PluginInstallRecord {
  const persistedVersion = readInstallRecordVersion(params.persisted);
  const recoveredVersion = readInstallRecordVersion(params.recovered);
  if (
    params.persisted?.source === "npm" &&
    recordsShareInstallPath(params.persisted, params.recovered) &&
    recoveredVersion &&
    persistedVersion !== recoveredVersion
  ) {
    const next: PluginInstallRecord = {
      ...params.persisted,
      ...params.recovered,
    };
    delete next.integrity;
    delete next.shasum;
    delete next.resolvedAt;
    delete next.installedAt;
    return next;
  }
  return params.persisted ?? params.recovered;
}

function mergeRecoveredManagedNpmInstallRecords(
  persisted: Record<string, PluginInstallRecord> | null,
  options: InstalledPluginIndexStoreOptions,
): Record<string, PluginInstallRecord> {
  const recovered = buildRecoveredManagedNpmInstallRecords(options);
  const merged: Record<string, PluginInstallRecord> = { ...persisted };
  for (const [pluginId, record] of Object.entries(recovered)) {
    merged[pluginId] = mergeRecoveredManagedNpmRecord({
      persisted: merged[pluginId],
      recovered: record,
    });
  }
  return merged;
}

function extractPluginInstallRecordsFromPersistedInstalledPluginIndex(
  index: unknown,
): Record<string, PluginInstallRecord> | null {
  if (!isRecord(index)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(index, "installRecords")) {
    return readRecordMap(index.installRecords) ?? {};
  }
  if (!Array.isArray(index.plugins)) {
    return null;
  }
  const records: Record<string, PluginInstallRecord> = {};
  for (const entry of index.plugins) {
    if (!isRecord(entry) || typeof entry.pluginId !== "string" || !isRecord(entry.installRecord)) {
      continue;
    }
    if (!isSafeRecordKey(entry.pluginId)) {
      continue;
    }
    records[entry.pluginId] = structuredClone(entry.installRecord) as PluginInstallRecord;
  }
  return records;
}

export async function readPersistedInstalledPluginIndexInstallRecords(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<Record<string, PluginInstallRecord> | null> {
  const parsed = await tryReadJson<unknown>(resolveInstalledPluginIndexStorePath(options));
  return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(parsed);
}

export function readPersistedInstalledPluginIndexInstallRecordsSync(
  options: InstalledPluginIndexStoreOptions = {},
): Record<string, PluginInstallRecord> | null {
  const parsed = tryReadJsonSync(resolveInstalledPluginIndexStorePath(options));
  return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(parsed);
}

type InstallRecordsCacheEntry = {
  records: Record<string, PluginInstallRecord>;
};

const installRecordsCache = new Map<string, InstallRecordsCacheEntry>();
let installRecordsCacheGeneration = 0;

function resolveInstallRecordsCacheKey(options: InstalledPluginIndexStoreOptions): string {
  return [
    path.resolve(resolveInstalledPluginIndexStorePath(options)),
    resolveRecoveredManagedNpmRoot(options),
  ].join("\0");
}

export function clearLoadInstalledPluginIndexInstallRecordsCache(): void {
  installRecordsCacheGeneration += 1;
  installRecordsCache.clear();
}

export async function loadInstalledPluginIndexInstallRecords(
  params: InstalledPluginIndexStoreOptions = {},
): Promise<Record<string, PluginInstallRecord>> {
  const cacheKey = resolveInstallRecordsCacheKey(params);
  const cached = installRecordsCache.get(cacheKey);
  if (cached) {
    return cloneInstallRecords(cached.records);
  }
  const cacheGeneration = installRecordsCacheGeneration;
  const records = cloneInstallRecords(
    mergeRecoveredManagedNpmInstallRecords(
      await readPersistedInstalledPluginIndexInstallRecords(params),
      params,
    ),
  );
  if (cacheGeneration !== installRecordsCacheGeneration) {
    return await loadInstalledPluginIndexInstallRecords(params);
  }
  installRecordsCache.set(cacheKey, { records });
  return cloneInstallRecords(records);
}

export function loadInstalledPluginIndexInstallRecordsSync(
  params: InstalledPluginIndexStoreOptions = {},
): Record<string, PluginInstallRecord> {
  const cacheKey = resolveInstallRecordsCacheKey(params);
  const cached = installRecordsCache.get(cacheKey);
  if (cached) {
    return cloneInstallRecords(cached.records);
  }
  const records = cloneInstallRecords(
    mergeRecoveredManagedNpmInstallRecords(
      readPersistedInstalledPluginIndexInstallRecordsSync(params),
      params,
    ),
  );
  installRecordsCache.set(cacheKey, { records });
  return cloneInstallRecords(records);
}
