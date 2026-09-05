// Commit helpers that move transient plugin install records into the persisted install index.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveConfigWriteAfterWrite,
  transformConfigFileWithRetry,
  type ConfigMutationCommit,
  type ConfigReplaceResult,
  type ConfigMutationResult,
  type TransformConfigFileWithRetryParams,
} from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import {
  copyPluginInstallRecordMap,
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import { copyRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveDefaultPluginNpmDir, resolvePluginNpmProjectsDir } from "./install-paths.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import {
  loadInstalledPluginIndexInstallRecords,
  PLUGIN_INSTALLS_CONFIG_PATH,
  type InstalledPluginIndexRecordStoreOptions,
  withoutPluginInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
} from "./installed-plugin-index-records.js";
import {
  restorePersistedInstalledPluginIndexIfCurrent,
  type InstalledPluginIndexWriteReceipt,
} from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "./managed-npm-retention-contract.js";
import {
  clearRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallPackageInfo,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { recordPluginPackageUninstallPlan } from "./uninstall-package-plan.js";
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

function pluginInstallRecordMapsEqual(
  left: Readonly<Record<string, PluginInstallRecord>>,
  right: Readonly<Record<string, PluginInstallRecord>>,
): boolean {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(
      ([pluginId, record]) =>
        Object.hasOwn(right, pluginId) &&
        isDeepStrictEqual(getPluginInstallRecordMapEntry(right, pluginId), record),
    )
  );
}

/** Find pending install records that match the base config and can be stripped as unchanged. */
export function unchangedPendingPluginInstallRecordIds(
  config: OpenClawConfig,
  baseConfig: OpenClawConfig,
): string[] {
  const pendingInstalls = config.plugins?.installs ?? {};
  return Object.entries(baseConfig.plugins?.installs ?? {})
    .filter(([pluginId, baseInstall]) =>
      isDeepStrictEqual(getPluginInstallRecordMapEntry(pendingInstalls, pluginId), baseInstall),
    )
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
  const remainingInstalls = createPluginInstallRecordMap<PluginInstallRecord>();
  for (const [pluginId, record] of Object.entries(config.plugins.installs)) {
    if (!removeIds.has(pluginId)) {
      setPluginInstallRecordMapEntry(remainingInstalls, pluginId, record);
    }
  }
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
  return copyRuntimeConfigWriteApplication(writeOptions, {
    ...writeOptions,
    afterWrite,
  });
}

function isMissingInstallPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function resolveExistingInstallPath(installPath: string): string {
  const resolvedPath = path.resolve(installPath);
  try {
    return fs.realpathSync(resolvedPath);
  } catch (error) {
    if (isMissingInstallPathError(error)) {
      return resolvedPath;
    }
    throw error;
  }
}

function installPathsOverlap(left: string, right: string): boolean {
  const resolvedLeft = resolveExistingInstallPath(left);
  const resolvedRight = resolveExistingInstallPath(right);
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
  if (params.previousRecord?.source !== "npm") {
    return null;
  }
  const previousInstallPath = params.previousRecord.installPath?.trim();
  const nextInstallPath = params.nextRecord?.installPath?.trim();
  if (!previousInstallPath) {
    return null;
  }
  if (
    params.nextRecord &&
    (!nextInstallPath || installPathsOverlap(previousInstallPath, nextInstallPath))
  ) {
    return null;
  }

  if (params.nextRecord?.source !== "npm") {
    const packageInfo = resolveRetainedManagedNpmInstallPackageInfo(previousInstallPath);
    if (!packageInfo) {
      return null;
    }
    try {
      const configuredNpmRoot = path.resolve(resolveDefaultPluginNpmDir());
      const npmRoot = fs.realpathSync(configuredNpmRoot);
      const configuredProjectRoot = path.resolve(packageInfo.projectRoot);
      const projectRoot = fs.realpathSync(configuredProjectRoot);
      const packageDir = fs.realpathSync(previousInstallPath);
      if (
        path.relative(configuredNpmRoot, configuredProjectRoot) !==
          path.relative(npmRoot, projectRoot) ||
        path.relative(configuredProjectRoot, path.resolve(previousInstallPath)) !==
          path.relative(projectRoot, packageDir)
      ) {
        return null;
      }
      if (projectRoot === npmRoot) {
        return previousInstallPath;
      }
      const projectsRoot = fs.realpathSync(resolvePluginNpmProjectsDir(npmRoot));
      return path.dirname(projectRoot) === projectsRoot ? previousInstallPath : null;
    } catch (error) {
      if (isMissingInstallPathError(error)) {
        return null;
      }
      throw error;
    }
  }
  const installs = createPluginInstallRecordMap<PluginInstallRecord>();
  setPluginInstallRecordMapEntry(installs, params.pluginId, params.previousRecord);
  const plan = planPluginUninstall(
    recordPluginPackageUninstallPlan(
      {
        config: {
          plugins: {
            installs,
          },
        } as OpenClawConfig,
        pluginId: params.pluginId,
        deleteFiles: true,
      },
      { runtimePluginIds: [] },
    ),
  );
  if (!plan.ok || !plan.directoryRemoval || plan.directoryRemoval.cleanup?.kind !== "npm") {
    return null;
  }
  if (nextInstallPath && installPathsOverlap(previousInstallPath, nextInstallPath)) {
    return null;
  }
  return previousInstallPath;
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

async function markRetiredManagedNpmInstallRecords(params: {
  previousInstallRecords: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  createdMarkerPaths: string[];
}): Promise<void> {
  const markedPreviousPluginIds = new Set<string>();
  const activeInstallPaths = Object.values(params.nextInstallRecords).flatMap((record) => {
    const installPath = record.installPath?.trim();
    return installPath ? [installPath] : [];
  });
  const markRetiredInstall = async (
    pluginId: string,
    previousRecord: PluginInstallRecord | undefined,
    nextRecord: PluginInstallRecord | undefined,
  ) => {
    const previousInstallPath = previousRecord?.installPath?.trim();
    if (
      previousInstallPath &&
      activeInstallPaths.some((installPath) =>
        installPathsOverlap(previousInstallPath, installPath),
      )
    ) {
      return;
    }
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
      reason:
        nextRecord?.source === "npm"
          ? "replaced-by-managed-npm-generation-update"
          : nextRecord
            ? "replaced-by-plugin-source-change"
            : RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
    });
    if (marked && !markerAlreadyExisted) {
      // Record each marker immediately so a later filesystem failure can roll it back.
      params.createdMarkerPaths.push(markerPath);
    }
    markedPreviousPluginIds.add(pluginId);
  };

  for (const [pluginId, nextRecord] of Object.entries(params.nextInstallRecords)) {
    await markRetiredInstall(
      pluginId,
      getPluginInstallRecordMapEntry(params.previousInstallRecords, pluginId),
      nextRecord,
    );
  }
  for (const [pluginId, previousRecord] of Object.entries(params.previousInstallRecords)) {
    if (
      markedPreviousPluginIds.has(pluginId) ||
      getPluginInstallRecordMapEntry(params.nextInstallRecords, pluginId)
    ) {
      continue;
    }
    await markRetiredInstall(
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
  clearedMarkers: Array<{ markerPath: string; contents: string }>,
): Promise<void> {
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
      // Record each cleared marker immediately so a later filesystem failure can roll it back.
      clearedMarkers.push({ markerPath, contents });
    }
  }
}

async function restoreClearedRetainedManagedNpmInstallMarkers(
  markerSnapshots: Array<{ markerPath: string; contents: string }>,
): Promise<void> {
  for (const snapshot of markerSnapshots) {
    await fs.promises.mkdir(path.dirname(snapshot.markerPath), { recursive: true });
    await fs.promises.writeFile(snapshot.markerPath, snapshot.contents, "utf8");
  }
}

/** Recheck staged enablement at its config writer, after any intervening plugin update. */
async function assertPluginConfigActivationConsent(params: {
  nextConfig: OpenClawConfig;
  previousInstallRecords?: Record<string, PluginInstallRecord>;
  nextInstallRecords?: Record<string, PluginInstallRecord>;
}): Promise<void> {
  const records = params.nextInstallRecords ?? (await loadInstalledPluginIndexInstallRecords());
  if (Object.keys(records).length === 0) {
    return;
  }
  const { resolvePluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
  const { resolvePluginCapabilityConsent } = await import("./capability-consent.js");
  const { resolvePluginControlPlaneWorkspace } = await import("./control-plane-workspace.js");
  const snapshot = await readConfigFileSnapshot();
  const metadataForConfig = (config: OpenClawConfig) =>
    resolvePluginMetadataSnapshot({
      config,
      allowCurrent: false,
      workspaceDir: resolvePluginControlPlaneWorkspace({ config }).workspaceDir,
    });
  const previous = metadataForConfig(snapshot.config);
  const next = metadataForConfig(params.nextConfig);
  const previouslyEnabled = new Set(
    previous.index.plugins
      .filter((plugin) => snapshot.valid && plugin.enabled)
      .map((plugin) => plugin.pluginId),
  );
  for (const plugin of next.index.plugins) {
    if (!plugin.enabled || plugin.origin === "bundled") {
      continue;
    }
    const owner = resolveInstalledPluginIndexInstallOwner(plugin) ?? plugin.pluginId;
    const record = records[owner];
    const previousRecord = params.previousInstallRecords?.[owner];
    const replaced =
      params.previousInstallRecords !== undefined &&
      (!previousRecord || record?.acceptedSurface !== undefined) &&
      !isDeepStrictEqual(previousRecord, record);
    // Metadata refreshes do not retroactively require consent from a running legacy install.
    if (replaced || !previouslyEnabled.has(plugin.pluginId)) {
      await resolvePluginCapabilityConsent({
        config: params.nextConfig,
        pluginId: plugin.pluginId,
        metadata: next,
      });
    }
  }
}

async function commitPluginInstallRecordsWithWriter(params: {
  prepareInstallRecords: (storeOptions: InstalledPluginIndexRecordStoreOptions) => Promise<{
    previousInstallRecords: Record<string, PluginInstallRecord>;
    nextInstallRecords: Record<string, PluginInstallRecord>;
  }>;
  nextConfig: OpenClawConfig;
  recheckStagedActivation?: boolean;
  beforePersistentEffect?: () => void | Promise<void>;
  writeOptions?: ConfigWriteOptions;
  commit: ConfigCommit;
}): Promise<{
  committed: ConfigReplaceResult | void;
  nextInstallRecords: Record<string, PluginInstallRecord>;
}> {
  return await withPluginLifecycleLease({}, async (lease) => {
    let tentativeWrite: InstalledPluginIndexWriteReceipt | undefined;
    const retainedMarkerPaths: string[] = [];
    const clearedMarkerSnapshots: Array<{ markerPath: string; contents: string }> = [];
    try {
      const storeOptions = { filePath: lease.databasePath };
      const prepared = await params.prepareInstallRecords(storeOptions);
      // Preparation and lease acquisition can outlive the approving operation.
      // The index writer below completes its mutation synchronously.
      await params.beforePersistentEffect?.();
      tentativeWrite = await writePersistedInstalledPluginIndexInstallRecordsWithLease(
        prepared.nextInstallRecords,
        {
          ...storeOptions,
          config: params.nextConfig,
          lease,
        },
      );
      if (params.recheckStagedActivation) {
        const nextIndex = await readPersistedInstalledPluginIndex(storeOptions);
        // Direct installers already hold the review lease; staged setup may have waited through login.
        if (
          !nextIndex ||
          nextIndex.plugins.some((plugin) => plugin.enabled && plugin.origin !== "bundled")
        ) {
          await assertPluginConfigActivationConsent({
            nextConfig: params.nextConfig,
            previousInstallRecords: prepared.previousInstallRecords,
            nextInstallRecords: prepared.nextInstallRecords,
          });
        }
      }
      await markRetiredManagedNpmInstallRecords({
        previousInstallRecords: prepared.previousInstallRecords,
        nextInstallRecords: prepared.nextInstallRecords,
        // Keep partial progress visible to the rollback path.
        createdMarkerPaths: retainedMarkerPaths,
      });
      await clearActiveRetainedManagedNpmInstallMarkers(
        prepared.nextInstallRecords,
        clearedMarkerSnapshots,
      );
      const installRecordsChanged = !pluginInstallRecordMapsEqual(
        prepared.previousInstallRecords,
        prepared.nextInstallRecords,
      );
      const writeOptions = copyRuntimeConfigWriteApplication(params.writeOptions, {
        ...params.writeOptions,
        ...(params.beforePersistentEffect
          ? {
              beforeCommit: async () => {
                await params.writeOptions?.beforeCommit?.();
                await params.beforePersistentEffect?.();
              },
            }
          : {}),
        ...(installRecordsChanged && params.writeOptions?.afterWrite === undefined
          ? {
              afterWrite: {
                mode: "restart" as const,
                reason: PLUGIN_SOURCE_CHANGED_RESTART_REASON,
              },
            }
          : {}),
        unsetPaths: mergeUnsetPaths(params.writeOptions?.unsetPaths, [
          Array.from(PLUGIN_INSTALLS_CONFIG_PATH),
        ]),
      });
      const committed = await params.commit(params.nextConfig, writeOptions);
      return { committed, nextInstallRecords: prepared.nextInstallRecords };
    } catch (error) {
      const tentative = tentativeWrite;
      if (tentative) {
        try {
          const restored = await restorePersistedInstalledPluginIndexIfCurrent(
            tentative.previous,
            tentative.revision,
            {
              filePath: lease.databasePath,
              lease,
            },
          );
          if (restored) {
            // Marker compensation belongs to the same tentative revision. A newer
            // index owner may rely on the current marker state.
            await restoreClearedRetainedManagedNpmInstallMarkers(clearedMarkerSnapshots);
            await removeCreatedRetainedManagedNpmInstallMarkers(retainedMarkerPaths);
          }
        } catch (rollbackError) {
          throw new Error(
            "Failed to commit plugin install records and could not roll back tentative plugin state",
            { cause: rollbackError },
          );
        }
      }
      throw error;
    }
  });
}

/** Persist plugin install records and commit the matching config update to disk. */
export async function commitPluginInstallRecordsWithConfig(params: {
  previousInstallRecords?: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  nextConfig: OpenClawConfig;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<void> {
  await commitPluginInstallRecordsWithWriter({
    prepareInstallRecords: async (storeOptions) => ({
      previousInstallRecords:
        params.previousInstallRecords ??
        (await loadInstalledPluginIndexInstallRecords(storeOptions)),
      nextInstallRecords: params.nextInstallRecords,
    }),
    nextConfig: params.nextConfig,
    beforePersistentEffect: params.beforePersistentEffect,
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

/** Persist plugin install records without rewriting the user-authored config file. */
export async function commitPluginInstallRecordsOnly(params: {
  previousInstallRecords?: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  nextConfig: OpenClawConfig;
  verifyConfigFresh?: () => Promise<void>;
}): Promise<void> {
  await commitPluginInstallRecordsWithWriter({
    prepareInstallRecords: async (storeOptions) => ({
      previousInstallRecords:
        params.previousInstallRecords ??
        (await loadInstalledPluginIndexInstallRecords(storeOptions)),
      nextInstallRecords: params.nextInstallRecords,
    }),
    nextConfig: params.nextConfig,
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
  const sourceInstallRecords = params.sourceConfig?.plugins?.installs ?? {};
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
    // Setup can wait through login after review; validate and commit the current generation together.
    const committed = await withPluginLifecycleLease({}, async () => {
      await assertPluginConfigActivationConsent({ nextConfig: params.nextConfig });
      return params.writeOptions
        ? await params.commit(params.nextConfig, params.writeOptions)
        : await params.commit(params.nextConfig);
    });
    return {
      config: committed ? committed.nextConfig : params.nextConfig,
      installRecords: {},
      movedInstallRecords: false,
      persistedHash: committed?.persistedHash ?? null,
    };
  }

  const pendingInstallRecords = nextPendingConfig.plugins?.installs ?? {};
  const strippedConfig = withoutPluginInstallRecords(params.nextConfig);
  const result = await commitPluginInstallRecordsWithWriter({
    prepareInstallRecords: async (storeOptions) => {
      const previousInstallRecords = await loadInstalledPluginIndexInstallRecords(storeOptions);
      const nextInstallRecords = copyPluginInstallRecordMap(sourceInstallRecords);
      for (const records of [previousInstallRecords, pendingInstallRecords]) {
        for (const [pluginId, record] of Object.entries(records)) {
          setPluginInstallRecordMapEntry(nextInstallRecords, pluginId, record);
        }
      }
      return {
        previousInstallRecords,
        nextInstallRecords,
      };
    },
    nextConfig: strippedConfig,
    recheckStagedActivation: true,
    ...(params.writeOptions ? { writeOptions: params.writeOptions } : {}),
    commit: params.commit,
  });
  return {
    config: result.committed ? result.committed.nextConfig : strippedConfig,
    installRecords: result.nextInstallRecords,
    movedInstallRecords: true,
    persistedHash: result.committed?.persistedHash ?? null,
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

  // The config lock is acquired inside the transform. Own the plugin lifecycle
  // lease first so pending-record commits keep the canonical lock order.
  return await withPluginLifecycleLease({}, async () => {
    return await transformConfigFileWithRetry<T>({
      ...params,
      commit,
    });
  });
}
