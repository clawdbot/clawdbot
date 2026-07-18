// Commit helpers that move transient plugin install records into the persisted install index.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  replaceConfigFile,
  resolveConfigWriteAfterWrite,
  transformConfigFileWithRetry,
  type ConfigMutationCommit,
  type ConfigReplaceResult,
  type ConfigMutationResult,
  type TransformConfigFileWithRetryParams,
} from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { extractShippedPluginInstallConfigRecords } from "../config/plugin-install-config-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  loadInstalledPluginIndexInstallRecords,
  PLUGIN_INSTALLS_CONFIG_PATH,
  withoutPluginInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./installed-plugin-index-records.js";
import {
  clearRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallPackageInfo,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";
import { planPluginUninstall } from "./uninstall.js";

function mergeUnsetPaths(
  left?: ConfigWriteOptions["unsetPaths"],
  right?: ConfigWriteOptions["unsetPaths"],
): ConfigWriteOptions["unsetPaths"] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  return merged.length > 0 ? merged : undefined;
}

/** Return whether config still contains legacy/transient plugin install records. */
export function hasPendingPluginInstallRecords(config: OpenClawConfig): boolean {
  return Object.keys(config.plugins?.installs ?? {}).length > 0;
}

/** Find pending install records that match the base config and can be stripped as unchanged. */
export function unchangedPendingPluginInstallRecordIds(
  config: OpenClawConfig,
  baseConfig: OpenClawConfig,
): string[] {
  const pendingInstalls = config.plugins?.installs ?? {};
  return Object.entries(baseConfig.plugins?.installs ?? {})
    .filter(([pluginId, baseInstall]) => isDeepStrictEqual(pendingInstalls[pluginId], baseInstall))
    .map(([pluginId]) => pluginId);
}

/** Remove pending plugin install records from config, optionally only for selected ids. */
export function stripPendingPluginInstallRecords(
  config: OpenClawConfig,
  pluginIds?: Iterable<string>,
): OpenClawConfig {
  if (!pluginIds) {
    return withoutPluginInstallRecords(config);
  }
  const removeIds = new Set(pluginIds);
  if (removeIds.size === 0 || !config.plugins?.installs) {
    return config;
  }
  const remainingInstalls = Object.fromEntries(
    Object.entries(config.plugins.installs).filter(([pluginId]) => !removeIds.has(pluginId)),
  );
  if (Object.keys(remainingInstalls).length === 0) {
    return withoutPluginInstallRecords(config);
  }
  return {
    ...config,
    plugins: {
      ...config.plugins,
      installs: remainingInstalls,
    },
  };
}

type ConfigCommit = (
  config: OpenClawConfig,
  writeOptions?: ConfigWriteOptions,
) => Promise<ConfigReplaceResult | void>;
const PLUGIN_SOURCE_CHANGED_RESTART_REASON = "plugin source changed";

function mergeAfterWrite(
  writeOptions: ConfigWriteOptions | undefined,
  afterWrite: ConfigWriteOptions["afterWrite"],
): ConfigWriteOptions | undefined {
  if (afterWrite === undefined) {
    return writeOptions;
  }
  return {
    ...writeOptions,
    afterWrite,
  };
}

function installPathsOverlap(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return (
    resolvedLeft === resolvedRight ||
    isPathInside(resolvedLeft, resolvedRight) ||
    isPathInside(resolvedRight, resolvedLeft)
  );
}

function resolveRetainedManagedNpmInstallMarkerTarget(params: {
  pluginId: string;
  previousRecord?: PluginInstallRecord;
  nextRecord?: PluginInstallRecord;
}): string | null {
  if (params.previousRecord?.source !== "npm" || params.nextRecord?.source !== "npm") {
    return null;
  }
  const previousInstallPath = params.previousRecord.installPath?.trim();
  const nextInstallPath = params.nextRecord.installPath?.trim();
  if (!previousInstallPath || !nextInstallPath) {
    return null;
  }
  if (installPathsOverlap(previousInstallPath, nextInstallPath)) {
    return null;
  }

  const plan = planPluginUninstall({
    config: {
      plugins: {
        installs: {
          [params.pluginId]: params.previousRecord,
        },
      },
    } as OpenClawConfig,
    pluginId: params.pluginId,
    deleteFiles: true,
  });
  if (
    !plan.ok ||
    !plan.directoryRemoval ||
    plan.directoryRemoval.cleanup?.kind !== "npm" ||
    path.resolve(plan.directoryRemoval.target) !== path.resolve(previousInstallPath)
  ) {
    return null;
  }
  if (installPathsOverlap(plan.directoryRemoval.target, nextInstallPath)) {
    return null;
  }
  return plan.directoryRemoval.target;
}

function resolveNpmInstallRecordPackageName(record: PluginInstallRecord): string | null {
  if (record.source !== "npm" || !record.installPath?.trim()) {
    return null;
  }
  return resolveRetainedManagedNpmInstallPackageInfo(record.installPath)?.packageName ?? null;
}

function findReplacementNpmRecordForRemovedRecord(params: {
  previousRecord: PluginInstallRecord;
  nextInstallRecords: Record<string, PluginInstallRecord>;
}): PluginInstallRecord | null {
  const previousPackageName = resolveNpmInstallRecordPackageName(params.previousRecord);
  if (!previousPackageName) {
    return null;
  }
  for (const nextRecord of Object.values(params.nextInstallRecords)) {
    if (resolveNpmInstallRecordPackageName(nextRecord) === previousPackageName) {
      return nextRecord;
    }
  }
  return null;
}

async function markRetainedReplacedManagedNpmInstallRecords(params: {
  previousInstallRecords: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  createdMarkerPaths: string[];
}): Promise<void> {
  const markedPreviousPluginIds = new Set<string>();
  const markReplacement = async (
    pluginId: string,
    previousRecord: PluginInstallRecord | undefined,
    nextRecord: PluginInstallRecord | undefined,
  ) => {
    const packageDir = resolveRetainedManagedNpmInstallMarkerTarget({
      pluginId,
      previousRecord,
      nextRecord,
    });
    if (!packageDir) {
      return;
    }
    const markerPath = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
    const markerAlreadyExisted = fs.existsSync(markerPath);
    const marked = await markRetainedManagedNpmInstall({
      packageDir,
      pluginId,
      reason: "replaced-by-managed-npm-generation-update",
    });
    if (marked && !markerAlreadyExisted) {
      // Record each marker immediately so a later filesystem failure can roll it back.
      params.createdMarkerPaths.push(markerPath);
    }
    markedPreviousPluginIds.add(pluginId);
  };

  for (const [pluginId, nextRecord] of Object.entries(params.nextInstallRecords)) {
    await markReplacement(pluginId, params.previousInstallRecords[pluginId], nextRecord);
  }
  for (const [pluginId, previousRecord] of Object.entries(params.previousInstallRecords)) {
    if (markedPreviousPluginIds.has(pluginId) || params.nextInstallRecords[pluginId]) {
      continue;
    }
    await markReplacement(
      pluginId,
      previousRecord,
      findReplacementNpmRecordForRemovedRecord({
        previousRecord,
        nextInstallRecords: params.nextInstallRecords,
      }) ?? undefined,
    );
  }
}

async function removeCreatedRetainedManagedNpmInstallMarkers(markerPaths: string[]): Promise<void> {
  for (const markerPath of markerPaths) {
    await fs.promises.rm(markerPath, { force: true });
  }
}

async function clearActiveRetainedManagedNpmInstallMarkers(
  nextInstallRecords: Record<string, PluginInstallRecord>,
): Promise<Array<{ markerPath: string; contents: string }>> {
  const clearedMarkers: Array<{ markerPath: string; contents: string }> = [];
  for (const record of Object.values(nextInstallRecords)) {
    if (record.source !== "npm" || !record.installPath?.trim()) {
      continue;
    }
    let markerPath: string;
    try {
      markerPath = resolveRetainedManagedNpmInstallMarkerPath(record.installPath);
    } catch {
      continue;
    }
    let contents: string;
    try {
      contents = await fs.promises.readFile(markerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const cleared = await clearRetainedManagedNpmInstallMarker(record.installPath);
    if (cleared) {
      clearedMarkers.push({ markerPath, contents });
    }
  }
  return clearedMarkers;
}

async function restoreClearedRetainedManagedNpmInstallMarkers(
  markerSnapshots: Array<{ markerPath: string; contents: string }>,
): Promise<void> {
  for (const snapshot of markerSnapshots) {
    await fs.promises.mkdir(path.dirname(snapshot.markerPath), { recursive: true });
    await fs.promises.writeFile(snapshot.markerPath, snapshot.contents, "utf8");
  }
}

async function commitPluginInstallRecordsWithWriter(params: {
  previousInstallRecords?: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  nextConfig: OpenClawConfig;
  writeOptions?: ConfigWriteOptions;
  commit: ConfigCommit;
}): Promise<ConfigReplaceResult | void> {
  const previousInstallRecords =
    params.previousInstallRecords ?? (await loadInstalledPluginIndexInstallRecords());
  const retainedMarkerPaths: string[] = [];
  const clearedMarkerSnapshots: Array<{ markerPath: string; contents: string }> = [];
  try {
    await writePersistedInstalledPluginIndexInstallRecords(params.nextInstallRecords);
    try {
      await markRetainedReplacedManagedNpmInstallRecords({
        previousInstallRecords,
        nextInstallRecords: params.nextInstallRecords,
        // Keep partial progress visible to the outer rollback path.
        createdMarkerPaths: retainedMarkerPaths,
      });
      clearedMarkerSnapshots.push(
        ...(await clearActiveRetainedManagedNpmInstallMarkers(params.nextInstallRecords)),
      );
      const installRecordsChanged = !isDeepStrictEqual(
        previousInstallRecords,
        params.nextInstallRecords,
      );
      return await params.commit(params.nextConfig, {
        ...params.writeOptions,
        ...(installRecordsChanged && params.writeOptions?.afterWrite === undefined
          ? { afterWrite: { mode: "restart", reason: PLUGIN_SOURCE_CHANGED_RESTART_REASON } }
          : {}),
        unsetPaths: mergeUnsetPaths(params.writeOptions?.unsetPaths, [
          Array.from(PLUGIN_INSTALLS_CONFIG_PATH),
        ]),
      });
    } catch (error) {
      try {
        // Keep config and install index atomic from the caller's perspective.
        await writePersistedInstalledPluginIndexInstallRecords(previousInstallRecords);
      } catch (rollbackError) {
        throw new Error(
          "Failed to commit plugin install records and could not restore the previous plugin index",
          { cause: rollbackError },
        );
      }
      throw error;
    }
  } catch (error) {
    await restoreClearedRetainedManagedNpmInstallMarkers(clearedMarkerSnapshots);
    await removeCreatedRetainedManagedNpmInstallMarkers(retainedMarkerPaths);
    throw error;
  }
}

/** Persist plugin install records and commit the matching config update to disk. */
export async function commitPluginInstallRecordsWithConfig(params: {
  previousInstallRecords?: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  nextConfig: OpenClawConfig;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
}): Promise<void> {
  await commitPluginInstallRecordsWithWriter({
    ...params,
    commit: async (nextConfig, writeOptions) => {
      return await replaceConfigFile({
        nextConfig,
        ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
        ...(writeOptions ? { writeOptions } : {}),
      });
    },
  });
}

/** Persist plugin install records without rewriting the user-authored config file. */
export async function commitPluginInstallRecordsOnly(params: {
  previousInstallRecords?: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  verifyConfigFresh?: () => Promise<void>;
}): Promise<void> {
  await commitPluginInstallRecordsWithWriter({
    previousInstallRecords: params.previousInstallRecords,
    nextInstallRecords: params.nextInstallRecords,
    nextConfig: {},
    commit: async () => {
      await params.verifyConfigFresh?.();
      return undefined;
    },
  });
}

/** Commit config while migrating any pending install records into the install index. */
export async function commitConfigWriteWithPendingPluginInstalls(params: {
  nextConfig: OpenClawConfig;
  /** Source snapshot whose transient records migrate below the canonical index. */
  sourceConfig?: OpenClawConfig;
  writeOptions?: ConfigWriteOptions;
  commit: ConfigCommit;
}): Promise<{
  config: OpenClawConfig;
  installRecords: Record<string, PluginInstallRecord>;
  movedInstallRecords: boolean;
  persistedHash: string | null;
}> {
  const sourceInstallRecords = extractShippedPluginInstallConfigRecords(params.sourceConfig);
  const nextPendingConfig = params.sourceConfig
    ? stripPendingPluginInstallRecords(
        params.nextConfig,
        unchangedPendingPluginInstallRecordIds(params.nextConfig, {
          plugins: { installs: sourceInstallRecords },
        }),
      )
    : params.nextConfig;
  if (
    Object.keys(sourceInstallRecords).length === 0 &&
    !hasPendingPluginInstallRecords(nextPendingConfig)
  ) {
    const committed = params.writeOptions
      ? await params.commit(params.nextConfig, params.writeOptions)
      : await params.commit(params.nextConfig);
    return {
      config: params.nextConfig,
      installRecords: {},
      movedInstallRecords: false,
      persistedHash: committed?.persistedHash ?? null,
    };
  }

  const pendingInstallRecords = nextPendingConfig.plugins?.installs ?? {};
  const previousInstallRecords = await loadInstalledPluginIndexInstallRecords();
  const nextInstallRecords = {
    ...sourceInstallRecords,
    ...previousInstallRecords,
    ...pendingInstallRecords,
  };
  const strippedConfig = withoutPluginInstallRecords(params.nextConfig);
  const committed = await commitPluginInstallRecordsWithWriter({
    previousInstallRecords,
    nextInstallRecords,
    nextConfig: strippedConfig,
    ...(params.writeOptions ? { writeOptions: params.writeOptions } : {}),
    commit: params.commit,
  });
  return {
    config: strippedConfig,
    installRecords: nextInstallRecords,
    movedInstallRecords: true,
    persistedHash: committed?.persistedHash ?? null,
  };
}

/** Replace the config file after moving pending plugin install records into the install index. */
export async function commitConfigWithPendingPluginInstalls(params: {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
}): Promise<{
  config: OpenClawConfig;
  installRecords: Record<string, PluginInstallRecord>;
  movedInstallRecords: boolean;
  persistedHash: string | null;
}> {
  return await commitConfigWriteWithPendingPluginInstalls({
    nextConfig: params.nextConfig,
    ...(params.writeOptions ? { writeOptions: params.writeOptions } : {}),
    commit: async (nextConfig, writeOptions) => {
      return await replaceConfigFile({
        nextConfig,
        ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
        ...(writeOptions ? { writeOptions } : {}),
      });
    },
  });
}

/** Transform config with retry support while preserving plugin install index consistency. */
export async function transformConfigWithPendingPluginInstalls<T = void>(
  params: Omit<TransformConfigFileWithRetryParams<T>, "commit">,
): Promise<ConfigMutationResult<T>> {
  const commit: ConfigMutationCommit = async ({ nextConfig, snapshot, baseHash, writeOptions }) => {
    const requestedAfterWrite = params.afterWrite ?? params.writeOptions?.afterWrite;
    const committed = await commitConfigWriteWithPendingPluginInstalls({
      nextConfig,
      sourceConfig: snapshot.sourceConfig,
      ...(writeOptions ? { writeOptions: mergeAfterWrite(writeOptions, params.afterWrite) } : {}),
      commit: async (config, commitWriteOptions) => {
        return await replaceConfigFile({
          nextConfig: config,
          snapshot,
          writeOptions: commitWriteOptions ?? {},
          ...(baseHash !== undefined ? { baseHash } : {}),
        });
      },
    });
    const afterWrite = resolveConfigWriteAfterWrite(
      requestedAfterWrite ??
        (committed.movedInstallRecords
          ? { mode: "restart", reason: PLUGIN_SOURCE_CHANGED_RESTART_REASON }
          : undefined),
    );
    return {
      config: committed.config,
      persistedHash: committed.persistedHash,
      afterWrite,
    };
  };

  return await transformConfigFileWithRetry<T>({
    ...params,
    commit,
  });
}
