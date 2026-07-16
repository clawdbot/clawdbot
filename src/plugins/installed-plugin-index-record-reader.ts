/** Reads installed-index records back into manifest registry records. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import { isPrereleaseResolutionAllowed, parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { isNotFoundPathError, normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { compareValidSemver } from "../infra/semver.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  resolveDefaultPluginNpmDir,
  resolvePluginNpmProjectsDir,
  validatePluginId,
} from "./install-paths.js";
import {
  getInstalledPluginIndexInstallRecordsCache,
  getInstalledPluginIndexInstallRecordsCacheGeneration,
  setInstalledPluginIndexInstallRecordsCache,
} from "./installed-plugin-index-record-cache.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";
import {
  hasRetainedManagedNpmInstallMarker,
  resolveRetainedManagedNpmInstallPackageInfo,
} from "./managed-npm-retention.js";
import { listManagedPluginNpmProjectRootsSync } from "./npm-project-roots.js";

export { clearLoadInstalledPluginIndexInstallRecordsCache } from "./installed-plugin-index-record-cache.js";

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
    if (hasRetainedManagedNpmInstallMarker(packageDir)) {
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

function isUnavailableManagedNpmInstallRecord(params: {
  npmRoot: string;
  persisted: PluginInstallRecord | undefined;
  recovered: PluginInstallRecord;
}): boolean {
  const installPath = params.persisted?.installPath;
  if (params.persisted?.source !== "npm" || !installPath) {
    return false;
  }
  try {
    if (fs.statSync(installPath).isDirectory()) {
      return false;
    }
  } catch (error) {
    if (!isNotFoundPathError(error)) {
      return false;
    }
  }

  const packageInfo = resolveRetainedManagedNpmInstallPackageInfo(installPath);
  if (!packageInfo || packageInfo.packageName !== params.recovered.resolvedName) {
    return false;
  }
  const normalizeForComparison = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? normalizeWindowsPathForComparison(resolved) : resolved;
  };
  // Persisted Windows paths can differ only by casing. Use filesystem comparison
  // semantics so a managed generation is not mistaken for a custom install.
  const npmRoot = normalizeForComparison(params.npmRoot);
  const projectRoot = normalizeForComparison(packageInfo.projectRoot);
  return (
    projectRoot === npmRoot ||
    normalizeForComparison(path.dirname(packageInfo.projectRoot)) ===
      normalizeForComparison(resolvePluginNpmProjectsDir(params.npmRoot))
  );
}

function mergeRecoveredManagedNpmMetadata(
  persisted: PluginInstallRecord,
  recovered: PluginInstallRecord,
  options: { preservePersistedSpec?: boolean } = {},
): PluginInstallRecord {
  const next: PluginInstallRecord = {
    ...persisted,
    ...recovered,
  };
  if (options.preservePersistedSpec) {
    const persistedSpec = persisted.spec ? parseRegistryNpmSpec(persisted.spec) : null;
    const selectorIsCompatible =
      persistedSpec !== null &&
      isPrereleaseResolutionAllowed({
        spec: persistedSpec,
        resolvedVersion: recovered.resolvedVersion,
      }) &&
      (persistedSpec.selectorKind !== "exact-version" ||
        (persistedSpec.selector !== undefined &&
          recovered.resolvedVersion !== undefined &&
          compareValidSemver(persistedSpec.selector, recovered.resolvedVersion) === 0));
    if (persistedSpec?.name === recovered.resolvedName && selectorIsCompatible) {
      next.spec = persisted.spec;
    }
  }
  delete next.integrity;
  delete next.shasum;
  delete next.resolvedAt;
  delete next.installedAt;
  return next;
}

function mergeRecoveredManagedNpmRecord(params: {
  npmRoot: string;
  persisted: PluginInstallRecord | undefined;
  recovered: PluginInstallRecord;
}): PluginInstallRecord {
  if (params.persisted && isUnavailableManagedNpmInstallRecord(params)) {
    return mergeRecoveredManagedNpmMetadata(params.persisted, params.recovered, {
      preservePersistedSpec: true,
    });
  }
  const persistedVersion = readInstallRecordVersion(params.persisted);
  const recoveredVersion = readInstallRecordVersion(params.recovered);
  if (
    params.persisted?.source === "npm" &&
    recordsShareInstallPath(params.persisted, params.recovered) &&
    recoveredVersion &&
    persistedVersion !== recoveredVersion
  ) {
    return mergeRecoveredManagedNpmMetadata(params.persisted, params.recovered);
  }
  return params.persisted ?? params.recovered;
}

function mergeRecoveredManagedNpmInstallRecords(
  persisted: Record<string, PluginInstallRecord> | null,
  options: InstalledPluginIndexStoreOptions,
): Record<string, PluginInstallRecord> {
  const npmRoot = resolveRecoveredManagedNpmRoot(options);
  const recovered = buildRecoveredManagedNpmInstallRecords(options);
  const merged: Record<string, PluginInstallRecord> = { ...persisted };
  for (const [pluginId, record] of Object.entries(recovered)) {
    merged[pluginId] = mergeRecoveredManagedNpmRecord({
      npmRoot,
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
  if (Object.hasOwn(index, "installRecords")) {
    return readRecordMap(index.installRecords) ?? {};
  }
  if (Object.hasOwn(index, "records")) {
    return readRecordMap(index.records) ?? {};
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

type InstalledPluginIndexRecordRow = {
  install_records_json: string;
  plugins_json: string;
};

function parseJsonColumn(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readPersistedInstalledPluginIndexForRecords(
  options: InstalledPluginIndexStoreOptions = {},
): unknown {
  const storePath = resolveInstalledPluginIndexStorePath(options);
  if (!fs.existsSync(storePath)) {
    return null;
  }
  if (options.filePath?.endsWith(".json")) {
    return tryReadJsonSync(options.filePath);
  }
  try {
    return withOpenClawStateDatabaseReadOnly(({ db }) => {
      const row = db
        .prepare(
          `
            SELECT install_records_json, plugins_json
              FROM installed_plugin_index
             WHERE index_key = ?
          `,
        )
        .get("installed-plugin-index") as InstalledPluginIndexRecordRow | undefined;
      if (!row) {
        return null;
      }
      return {
        installRecords: parseJsonColumn(row.install_records_json),
        plugins: parseJsonColumn(row.plugins_json),
      };
    }, resolveInstalledPluginIndexStateDatabaseOptions(options));
  } catch {
    return null;
  }
}

/** Reads install records from the persisted installed plugin index. */
export async function readPersistedInstalledPluginIndexInstallRecords(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<Record<string, PluginInstallRecord> | null> {
  const parsed = readPersistedInstalledPluginIndexForRecords(options);
  return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(parsed);
}

/** Synchronously reads install records from the persisted installed plugin index. */
export function readPersistedInstalledPluginIndexInstallRecordsSync(
  options: InstalledPluginIndexStoreOptions = {},
): Record<string, PluginInstallRecord> | null {
  const parsed = readPersistedInstalledPluginIndexForRecords(options);
  return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(parsed);
}

function resolveInstallRecordsCacheKey(options: InstalledPluginIndexStoreOptions): string {
  return [
    path.resolve(resolveInstalledPluginIndexStorePath(options)),
    resolveRecoveredManagedNpmRoot(options),
  ].join("\0");
}

/** Loads installed plugin records, recovering managed npm installs and caching the result. */
export async function loadInstalledPluginIndexInstallRecords(
  params: InstalledPluginIndexStoreOptions = {},
): Promise<Record<string, PluginInstallRecord>> {
  const cacheKey = resolveInstallRecordsCacheKey(params);
  const cached = getInstalledPluginIndexInstallRecordsCache(cacheKey);
  if (cached) {
    return cloneInstallRecords(cached.records);
  }
  const cacheGeneration = getInstalledPluginIndexInstallRecordsCacheGeneration();
  const records = cloneInstallRecords(
    mergeRecoveredManagedNpmInstallRecords(
      await readPersistedInstalledPluginIndexInstallRecords(params),
      params,
    ),
  );
  // A concurrent cache clear means the caller expects fresh data, so retry with the new generation.
  if (cacheGeneration !== getInstalledPluginIndexInstallRecordsCacheGeneration()) {
    return await loadInstalledPluginIndexInstallRecords(params);
  }
  setInstalledPluginIndexInstallRecordsCache(cacheKey, { records });
  return cloneInstallRecords(records);
}

/** Synchronously loads installed plugin records, recovering managed npm installs and caching them. */
export function loadInstalledPluginIndexInstallRecordsSync(
  params: InstalledPluginIndexStoreOptions = {},
): Record<string, PluginInstallRecord> {
  const cacheKey = resolveInstallRecordsCacheKey(params);
  const cached = getInstalledPluginIndexInstallRecordsCache(cacheKey);
  if (cached) {
    return cloneInstallRecords(cached.records);
  }
  const records = cloneInstallRecords(
    mergeRecoveredManagedNpmInstallRecords(
      readPersistedInstalledPluginIndexInstallRecordsSync(params),
      params,
    ),
  );
  setInstalledPluginIndexInstallRecordsCache(cacheKey, { records });
  return cloneInstallRecords(records);
}
