// Creates backup archives while filtering volatile runtime state.
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type {
  BackupAgentRoot,
  BackupResourceInventory,
} from "../commands/backup-resource-inventory.js";
import {
  buildBackupArchiveBasename,
  buildBackupArchivePath,
  buildBackupArchiveRoot,
  canonicalizePathForContainment,
  type BackupAsset,
  resolveBackupPlanFromDisk,
} from "../commands/backup-shared.js";
import type { BackupManifest } from "../commands/backup-verify-manifest.js";
import { isPathWithin } from "../commands/cleanup-utils.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveHomeDir, resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { assertArchiveSymbolicLinkTarget } from "./backup-archive-path-policy.js";
import {
  cleanupBackupArchivePublication,
  createBackupArchivePublication,
  publishPreparedBackupArchive,
  type BackupArchivePublication,
} from "./backup-archive-publication.js";
import {
  observeBackupTarEntryProgress,
  removePreparedBackupArchive,
  writeArchiveStreamToFile,
} from "./backup-create-stream.js";
import {
  classifyBackupSqliteSource,
  createBackupSqliteSnapshotPlan,
} from "./backup-sqlite-snapshot.js";
import { writeTarArchiveWithRetry } from "./backup-tar-retry.js";
import {
  createBackupLinkCache,
  createBackupVolatileStatCache,
} from "./backup-volatile-stat-cache.js";
import { isErrno } from "./errors.js";
import { writeJson } from "./json-files.js";
import {
  createLegacyAuditBackupCapture,
  hasLegacyAuditBackupSources,
  legacyAuditBackupCapturesMatch,
  LegacyAuditBackupStateChangedError,
  isLegacyAuditMigrationBackupPath,
  type LegacyAuditBackupSnapshot,
} from "./state-migrations.audit-backup.js";
import { withLegacyAuditMigrationLease } from "./state-migrations.audit-coordination.js";

const loadTarRuntime = createLazyRuntimeModule(() => import("tar"));

export type BackupCreateOptions = {
  output?: string;
  dryRun?: boolean;
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  verify?: boolean;
  json?: boolean;
  nowMs?: number;
  /**
   * Optional info logger invoked for non-fatal backup events such as tar
   * retry notices or volatile-file skip counts. When omitted, events are
   * silent aside from the final result.
   */
  log?: (message: string) => void;
};

type BackupManifestAgentRoot = Pick<BackupAgentRoot, "agentId" | "sourcePath">;

export type BackupCreateResult = {
  createdAt: string;
  archiveRoot: string;
  archivePath: string;
  dryRun: boolean;
  includeWorkspace: boolean;
  onlyConfig: boolean;
  verified: boolean;
  assets: BackupAsset[];
  agentRoots?: readonly BackupManifestAgentRoot[];
  skipped: Array<{
    kind: string;
    sourcePath: string;
    displayPath: string;
    reason: string;
    coveredBy?: string;
  }>;
  /**
   * Count of files the archiver actively skipped because they matched the
   * known-volatile filter (live sessions, cron logs, queues, sockets, pid/tmp).
   * Populated on real writes only; dry runs report 0.
   */
  skippedVolatileCount: number;
};

async function resolveOutputPath(params: {
  output?: string;
  nowMs: number;
  includedAssets: BackupAsset[];
  stateDir: string;
}): Promise<string> {
  const basename = buildBackupArchiveBasename(params.nowMs);
  const rawOutput = params.output?.trim();
  if (!rawOutput) {
    const cwd = path.resolve(process.cwd());
    const canonicalCwd = await fs.realpath(cwd).catch(() => cwd);
    const cwdInsideSource = params.includedAssets.some((asset) =>
      isPathWithin(canonicalCwd, asset.sourcePath),
    );
    const defaultDir = cwdInsideSource ? (resolveHomeDir() ?? path.dirname(params.stateDir)) : cwd;
    return path.resolve(defaultDir, basename);
  }

  const resolved = resolveUserPath(rawOutput);
  if (rawOutput.endsWith("/") || rawOutput.endsWith("\\")) {
    return path.join(resolved, basename);
  }

  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return path.join(resolved, basename);
    }
  } catch {
    // Treat as a file path when the target does not exist yet.
  }

  return resolved;
}

type BackupOutputFailurePhase = "parent" | "publication" | "write";

function formatBackupOutputFailure(
  error: unknown,
  outputPath: string,
  phase: BackupOutputFailurePhase,
  ownedRoot?: string,
): unknown {
  const cause = phase === "write" && error instanceof Error ? error.cause : undefined;
  const filesystemError = isErrno(error) ? error : isErrno(cause) ? cause : null;
  if (!filesystemError) {
    return error;
  }
  if (ownedRoot) {
    const failedPath = filesystemError.path;
    if (typeof failedPath !== "string" || !isPathWithin(path.resolve(failedPath), ownedRoot)) {
      return error;
    }
  }

  const outputParent = path.dirname(outputPath);
  const retry = "run `openclaw backup create --output <archive>` again.";
  let detail: string;
  switch (filesystemError.code) {
    case "ENOENT":
      detail = `Backup output directory could not be created: ${outputParent}. Check the path and ${retry}`;
      break;
    case "EACCES":
    case "EPERM":
    case "EROFS":
      detail = `Backup output directory is not writable: ${outputParent}. Check the path and directory permissions, then ${retry}`;
      break;
    case "EEXIST":
    case "ENOTDIR":
      if (phase !== "parent") {
        return error;
      }
      detail = `Backup output parent is not a directory: ${outputParent}. Choose a directory path and ${retry}`;
      break;
    case "ENOSPC":
      detail = `The destination does not have enough free space: ${outputParent}. Free up disk space and ${retry}`;
      break;
    case "EDQUOT":
      detail = `The destination storage quota is exhausted: ${outputParent}. Free up space or choose another path, then ${retry}`;
      break;
    default:
      detail = `The output path could not be prepared: ${outputParent}. Check the path and filesystem, then ${retry}`;
  }
  return new Error(`Backup archive creation failed: ${outputPath}. ${detail}`, { cause: error });
}

async function assertOutputPathReady(outputPath: string): Promise<void> {
  try {
    await fs.access(outputPath);
    throw new Error(`Refusing to overwrite existing backup archive: ${outputPath}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return;
    }
    throw formatBackupOutputFailure(error, outputPath, "parent");
  }
}

async function prepareBackupOutputParent(outputPath: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
  } catch (error) {
    throw formatBackupOutputFailure(error, outputPath, "parent");
  }
}

// The temp manifest is passed to `tar.c` alongside the asset source paths. If
// the temp file lives inside any asset, recursive traversal pulls it in a
// second time and both copies remap to `<archiveRoot>/manifest.json`, which
// makes verify reject the archive. A `tar` filter cannot fix this in place: it
// fires for both the explicit-arg and the traversed entry, so excluding by
// path drops the manifest entirely. We instead place the temp dir somewhere
// guaranteed to be outside every asset.
async function chooseBackupTempRoot(params: {
  assets: readonly BackupAsset[];
  outputPath: string;
}): Promise<string> {
  const systemTmp = os.tmpdir();
  const canonicalSystemTmp = await canonicalizePathForContainment(systemTmp);
  const systemTmpInsideAsset = params.assets.some((asset) =>
    isPathWithin(canonicalSystemTmp, asset.sourcePath),
  );
  if (!systemTmpInsideAsset) {
    return systemTmp;
  }

  // Fallback: the directory holding the output archive. The earlier
  // output-containment check guarantees `outputPath` is outside every asset,
  // so its parent is too. The caller must already have write access there to
  // write the archive itself, so this stays within the existing sandbox.
  const fallback = path.dirname(params.outputPath);
  const canonicalFallback = await canonicalizePathForContainment(fallback);
  const fallbackInsideAsset = params.assets.find((asset) =>
    isPathWithin(canonicalFallback, asset.sourcePath),
  );
  if (fallbackInsideAsset) {
    throw new Error(
      `Backup temp root cannot be placed outside every source path: ${systemTmp} and ${fallback} both overlap ${fallbackInsideAsset.sourcePath}.`,
    );
  }
  return fallback;
}

function buildManifest(
  result: BackupCreateResult,
  plan: Awaited<ReturnType<typeof resolveBackupPlanFromDisk>>,
): BackupManifest {
  return {
    schemaVersion: 1,
    createdAt: result.createdAt,
    archiveRoot: result.archiveRoot,
    runtimeVersion: resolveRuntimeServiceVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    options: {
      includeWorkspace: result.includeWorkspace,
      onlyConfig: result.onlyConfig,
    },
    paths: {
      stateDir: plan.stateDir,
      configPath: plan.configPath,
      oauthDir: plan.oauthDir,
      workspaceDirs: plan.workspaceDirs,
      ...(result.agentRoots ? { agentRoots: [...result.agentRoots] } : {}),
    },
    assets: result.assets.map((asset) => ({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    })),
    skipped: result.skipped.map((entry) => ({
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      reason: entry.reason,
      coveredBy: entry.coveredBy,
    })),
  };
}

export function formatBackupCreateSummary(result: BackupCreateResult): string[] {
  const lines = [`Backup archive: ${result.archivePath}`];
  lines.push(`Included ${result.assets.length} path${result.assets.length === 1 ? "" : "s"}:`);
  for (const asset of result.assets) {
    lines.push(`- ${asset.kind}: ${asset.displayPath}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} path${result.skipped.length === 1 ? "" : "s"}:`);
    for (const entry of result.skipped) {
      if (entry.reason === "covered" && entry.coveredBy) {
        lines.push(`- ${entry.kind}: ${entry.displayPath} (${entry.reason} by ${entry.coveredBy})`);
      } else {
        lines.push(`- ${entry.kind}: ${entry.displayPath} (${entry.reason})`);
      }
    }
  }
  if (result.dryRun) {
    lines.push("Dry run only; archive was not written.");
  } else {
    lines.push(`Created ${result.archivePath}`);
    if (result.skippedVolatileCount > 0) {
      lines.push(
        `Skipped ${result.skippedVolatileCount} volatile file${
          result.skippedVolatileCount === 1 ? "" : "s"
        } (live sessions, cron logs, queues, managed runtime paths, sockets, pid/tmp).`,
      );
    }
    if (result.verified) {
      lines.push("Archive verification: passed");
    }
  }
  return lines;
}

function remapArchiveEntryPath(params: {
  entryPath: string;
  manifestPath: string;
  archiveRoot: string;
  sourcePathRemaps?: ReadonlyMap<string, string>;
}): string {
  const normalizedEntry = path.resolve(params.entryPath);
  if (normalizedEntry === params.manifestPath) {
    return path.posix.join(params.archiveRoot, "manifest.json");
  }
  const remappedSourcePath = params.sourcePathRemaps?.get(normalizedEntry);
  if (remappedSourcePath) {
    return buildBackupArchivePath(params.archiveRoot, remappedSourcePath);
  }
  return buildBackupArchivePath(params.archiveRoot, normalizedEntry);
}

function remapDeclaredAbsoluteSymbolicLinkTarget(params: {
  linkpath: string | undefined;
  archiveEntryPath: string;
  archiveRoot: string;
  assets: readonly BackupAsset[];
}): string | undefined {
  if (!params.linkpath || !path.isAbsolute(params.linkpath) || params.linkpath.includes("\\")) {
    return params.linkpath;
  }
  // Tar exposes the first link hop, while assets own the final canonical path.
  // Resolve before containment so chains map to one portable archive target.
  let targetSourcePath: string;
  try {
    targetSourcePath = realpathSync(params.linkpath);
  } catch {
    return params.linkpath;
  }
  if (!params.assets.some((asset) => isPathWithin(targetSourcePath, asset.sourcePath))) {
    return params.linkpath;
  }
  return path.posix.relative(
    path.posix.dirname(params.archiveEntryPath),
    buildBackupArchivePath(params.archiveRoot, targetSourcePath),
  );
}

function isBackupTarFilterFile(entry: import("node:fs").Stats | import("tar").ReadEntry): boolean {
  return "isFile" in entry ? entry.isFile() : entry.type === "File";
}

/**
 * Restores the native path spelling of a node-tar stat-cache key. node-tar
 * normalizes its absolute cache keys to forward slashes on Windows, while the
 * snapshot source sets hold native `path.resolve` spellings with backslashes,
 * so exact-match lookups must convert the key back first.
 */
function fromTarCacheKey(tarCacheKey: string): string {
  return path.sep === "/" ? tarCacheKey : tarCacheKey.replaceAll("/", path.sep);
}

const MAX_LEGACY_AUDIT_CAPTURE_ATTEMPTS = 3;

type ConsistentStateSnapshotPlan = {
  legacyAuditSnapshots: LegacyAuditBackupSnapshot[];
  stateSqliteBackup: Awaited<ReturnType<typeof createBackupSqliteSnapshotPlan>>;
};

async function createConsistentStateSnapshotPlan(params: {
  inventory: BackupResourceInventory;
  stateDir?: string;
  tempDir: string;
  onlyConfig: boolean;
}): Promise<ConsistentStateSnapshotPlan> {
  if (params.onlyConfig) {
    return {
      legacyAuditSnapshots: [],
      stateSqliteBackup: { snapshots: [], discoveredSourcePaths: new Set<string>() },
    };
  }
  if (!params.stateDir) {
    return {
      legacyAuditSnapshots: [],
      stateSqliteBackup: await createBackupSqliteSnapshotPlan({
        inventory: params.inventory,
        tempDir: params.tempDir,
        legacyAuditSnapshots: [],
      }),
    };
  }

  const stateDir = params.stateDir;
  if (!(await hasLegacyAuditBackupSources(stateDir))) {
    const fastAttemptDir = path.join(params.tempDir, "state-snapshot-no-legacy");
    await fs.mkdir(fastAttemptDir, { recursive: true });
    const stateSqliteBackup = await createBackupSqliteSnapshotPlan({
      inventory: params.inventory,
      tempDir: fastAttemptDir,
      legacyAuditSnapshots: [],
    });
    if (!(await hasLegacyAuditBackupSources(stateDir))) {
      return { legacyAuditSnapshots: [], stateSqliteBackup };
    }
    await fs.rm(fastAttemptDir, { recursive: true, force: true });
  }

  let lastStateChangeMessage: string | undefined;
  for (let attempt = 0; attempt < MAX_LEGACY_AUDIT_CAPTURE_ATTEMPTS; attempt += 1) {
    const attemptDir = path.join(params.tempDir, `state-snapshot-attempt-${attempt + 1}`);
    const verificationDir = path.join(attemptDir, "legacy-verification");
    await fs.mkdir(attemptDir, { recursive: true });
    try {
      const firstCapture = await withLegacyAuditMigrationLease(stateDir, () =>
        createLegacyAuditBackupCapture({ stateDir, tempDir: attemptDir }),
      );
      const stateSqliteBackup = await createBackupSqliteSnapshotPlan({
        inventory: params.inventory,
        tempDir: attemptDir,
        legacyAuditSnapshots: firstCapture.snapshots,
        legacyAuditDatabaseWitness: firstCapture.databaseWitness,
      });
      await fs.mkdir(verificationDir, { recursive: true });
      const secondCapture = await withLegacyAuditMigrationLease(stateDir, () =>
        createLegacyAuditBackupCapture({ stateDir, tempDir: verificationDir }),
      );
      if (!legacyAuditBackupCapturesMatch(firstCapture, secondCapture)) {
        throw new LegacyAuditBackupStateChangedError();
      }
      await fs.rm(verificationDir, { recursive: true, force: true });
      return { legacyAuditSnapshots: firstCapture.snapshots, stateSqliteBackup };
    } catch (error) {
      await fs.rm(attemptDir, { recursive: true, force: true });
      if (!(error instanceof LegacyAuditBackupStateChangedError)) {
        throw error;
      }
      lastStateChangeMessage = error.message;
    }
  }
  throw new LegacyAuditBackupStateChangedError(
    `${lastStateChangeMessage ?? "Legacy audit state changed while backup was capturing it"}; retry backup after legacy audit migration settles`,
  );
}

export async function createBackupArchive(
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  const nowMs = resolveDateTimestampMs(opts.nowMs);
  const archiveRoot = buildBackupArchiveRoot(nowMs);
  const onlyConfig = Boolean(opts.onlyConfig);
  const includeWorkspace = onlyConfig ? false : (opts.includeWorkspace ?? true);
  const plan = await resolveBackupPlanFromDisk({ includeWorkspace, onlyConfig, nowMs });
  const outputPath = await resolveOutputPath({
    output: opts.output,
    nowMs,
    includedAssets: plan.included,
    stateDir: plan.stateDir,
  });

  if (plan.included.length === 0) {
    throw new Error(
      onlyConfig
        ? "No OpenClaw config file was found to back up."
        : "No local OpenClaw state was found to back up.",
    );
  }

  const canonicalOutputPath = await canonicalizePathForContainment(outputPath);
  const overlappingAsset = plan.included.find((asset) =>
    isPathWithin(canonicalOutputPath, asset.sourcePath),
  );
  if (overlappingAsset) {
    throw new Error(
      `Backup output must not be written inside a source path: ${outputPath} is inside ${overlappingAsset.sourcePath}`,
    );
  }

  if (!opts.dryRun) {
    await assertOutputPathReady(outputPath);
  }

  const createdAt = new Date(nowMs).toISOString();
  const stateAsset = plan.included.find((asset) => asset.kind === "state");
  const result: BackupCreateResult = {
    createdAt,
    archiveRoot,
    archivePath: outputPath,
    dryRun: Boolean(opts.dryRun),
    includeWorkspace,
    onlyConfig,
    verified: false,
    assets: plan.included,
    ...(onlyConfig
      ? {}
      : {
          agentRoots: plan.inventory.agentRoots.map(({ agentId, sourcePath }) => ({
            agentId,
            sourcePath,
          })),
        }),
    skipped: plan.skipped,
    skippedVolatileCount: 0,
  };

  if (opts.dryRun) {
    return result;
  }

  await prepareBackupOutputParent(outputPath);
  const tempRoot = await chooseBackupTempRoot({ assets: result.assets, outputPath });
  await fs.mkdir(tempRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-backup-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  let publication: BackupArchivePublication;
  try {
    publication = await createBackupArchivePublication(outputPath);
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw formatBackupOutputFailure(error, outputPath, "publication");
  }
  const tempArchivePath = publication.tempArchivePath;
  try {
    const { legacyAuditSnapshots, stateSqliteBackup } = await createConsistentStateSnapshotPlan({
      inventory: plan.inventory,
      stateDir: stateAsset?.sourcePath,
      tempDir,
      onlyConfig,
    });
    const sourcePathRemaps = new Map<string, string>();
    const skippedStateSourcePaths = new Set<string>();
    for (const snapshot of stateSqliteBackup.snapshots) {
      sourcePathRemaps.set(path.resolve(snapshot.sourcePath), snapshot.archiveSourcePath);
      for (const skippedSourcePath of snapshot.skippedSourcePaths) {
        skippedStateSourcePaths.add(skippedSourcePath);
      }
    }
    for (const snapshot of legacyAuditSnapshots) {
      sourcePathRemaps.set(path.resolve(snapshot.sourcePath), snapshot.archiveSourcePath);
      for (const skippedSourcePath of snapshot.skippedSourcePaths) {
        skippedStateSourcePaths.add(skippedSourcePath);
      }
    }
    const manifest = buildManifest(result, plan);
    await writeJson(manifestPath, manifest, { trailingNewline: true });

    const tar = await loadTarRuntime();
    const gatewayLockDir = resolveGatewayLockDir(plan.stateDir);
    let skippedVolatileCount = 0;
    // node-tar invokes filter/onWriteEntry from async filesystem callbacks, so
    // collect violations there and reject only after tar settles.
    const unexpectedSqliteSourcePaths: string[] = [];
    let archiveSymlinkViolation: Error | undefined;
    const tarFilter = (
      entryPath: string,
      entryStat: import("node:fs").Stats | import("tar").ReadEntry,
    ): boolean => {
      // The manifest is staged in a tmp dir outside any state directory and
      // is always safe to include.
      const resolvedEntryPath = path.resolve(entryPath);
      if (resolvedEntryPath === manifestPath) {
        return true;
      }
      const isDirectory =
        "isDirectory" in entryStat ? entryStat.isDirectory() : entryStat.type === "Directory";
      if (
        !onlyConfig &&
        !(isDirectory
          ? plan.inventory.isTraversable(resolvedEntryPath)
          : plan.inventory.isIncluded(resolvedEntryPath))
      ) {
        return false;
      }
      if (isPathWithin(resolvedEntryPath, gatewayLockDir)) {
        return false;
      }
      if (
        stateAsset &&
        isLegacyAuditMigrationBackupPath(resolvedEntryPath, stateAsset.sourcePath)
      ) {
        return false;
      }
      const sqliteSourceKind = onlyConfig
        ? undefined
        : classifyBackupSqliteSource(resolvedEntryPath, plan.inventory);
      if (sqliteSourceKind === "excluded") {
        return false;
      }
      if (skippedStateSourcePaths.has(resolvedEntryPath)) {
        return false;
      }
      if (
        sqliteSourceKind === "sqlite" &&
        stateSqliteBackup.discoveredSourcePaths.has(resolvedEntryPath)
      ) {
        return false;
      }
      if (sqliteSourceKind === "sqlite" && isBackupTarFilterFile(entryStat)) {
        unexpectedSqliteSourcePaths.push(entryPath);
        return false;
      }
      if (plan.inventory.isVolatile(resolvedEntryPath)) {
        skippedVolatileCount += 1;
        return false;
      }
      return true;
    };
    const completedArchive = await writeTarArchiveWithRetry({
      tempArchivePath,
      log: opts.log,
      runTar: async (attemptTempArchivePath) => {
        // tar.c re-walks the tree (and thus re-invokes tarFilter) on every
        // attempt, so reset the closure counter here or retries would report
        // cumulative skip counts across attempts instead of the final one.
        skippedVolatileCount = 0;
        unexpectedSqliteSourcePaths.length = 0;
        archiveSymlinkViolation = undefined;
        const prepared = await writeArchiveStreamToFile({
          archivePath: attemptTempArchivePath,
          createArchiveStream: (reportProgress) =>
            tar.c(
              {
                gzip: true,
                portable: true,
                preservePaths: true,
                linkCache: createBackupLinkCache(),
                statCache: createBackupVolatileStatCache(
                  (sourcePath) =>
                    plan.inventory.isVolatile(sourcePath) ||
                    // node-tar lstats every enumerated entry before the tar
                    // filter can exclude it, and a live SQLite database can
                    // remove a transient sidecar (-wal/-shm/-journal) at any
                    // moment. Paths already excluded by a verified snapshot
                    // must not abort the whole archive when that happens, so
                    // they get a synthetic stat and are filtered out without
                    // touching the filesystem. Unsnapshotted SQLite sources
                    // stay uncovered so the filter still rejects them.
                    // node-tar normalizes its cache keys to forward slashes on
                    // Windows while the snapshot sets below hold native
                    // path.resolve spellings, so restore the native separator
                    // spelling before the exact-match lookups.
                    skippedStateSourcePaths.has(fromTarCacheKey(sourcePath)) ||
                    stateSqliteBackup.discoveredSourcePaths.has(fromTarCacheKey(sourcePath)),
                ),
                filter: (entryPath, entryStat) => {
                  reportProgress({ phase: "traversal", entryPath });
                  return tarFilter(entryPath, entryStat);
                },
                onWriteEntry: (entry) => {
                  const sourceEntryPath = entry.path;
                  reportProgress({ phase: "entry", entryPath: sourceEntryPath });
                  if (entry.type === "File" && (entry.stat?.size ?? 0) > 0) {
                    observeBackupTarEntryProgress(entry, (bytes) => {
                      reportProgress({ phase: "raw", entryPath: sourceEntryPath, bytes });
                    });
                  }
                  const archiveEntryPath = remapArchiveEntryPath({
                    entryPath: entry.path,
                    manifestPath,
                    archiveRoot,
                    sourcePathRemaps,
                  });
                  if (entry.type === "SymbolicLink" && !archiveSymlinkViolation) {
                    try {
                      entry.linkpath = remapDeclaredAbsoluteSymbolicLinkTarget({
                        linkpath: entry.linkpath,
                        archiveEntryPath,
                        archiveRoot,
                        assets: result.assets,
                      });
                      assertArchiveSymbolicLinkTarget({
                        archiveRoot,
                        entryPath: archiveEntryPath,
                        linkpath: entry.linkpath,
                        assets: manifest.assets,
                      });
                    } catch (error) {
                      archiveSymlinkViolation =
                        error instanceof Error ? error : new Error(String(error));
                    }
                  }
                  entry.path = archiveEntryPath;
                },
              },
              [
                manifestPath,
                ...stateSqliteBackup.snapshots.map((snapshot) => snapshot.sourcePath),
                ...legacyAuditSnapshots.map((snapshot) => snapshot.sourcePath),
                ...result.assets.map((asset) => asset.sourcePath),
              ],
            ),
          onPartialArchive: (partialArchive) => {
            publication.pendingCleanupArchives.push(partialArchive);
          },
        });
        const unexpectedSqliteSourcePath = unexpectedSqliteSourcePaths[0];
        const archiveValidationError = unexpectedSqliteSourcePath
          ? new Error(
              `SQLite state appeared after snapshot discovery: ${unexpectedSqliteSourcePath}. Retry backup so it can be snapshotted.`,
            )
          : archiveSymlinkViolation;
        if (archiveValidationError) {
          if (!removePreparedBackupArchive(prepared)) {
            publication.pendingCleanupArchives.push(prepared);
          }
          throw archiveValidationError;
        }
        return prepared;
      },
    }).catch((error: unknown) => {
      throw formatBackupOutputFailure(error, outputPath, "write", publication.stagingDir);
    });
    result.skippedVolatileCount = skippedVolatileCount;
    if (skippedVolatileCount > 0) {
      opts.log?.(
        `Backup skipped ${skippedVolatileCount} volatile file${
          skippedVolatileCount === 1 ? "" : "s"
        } (live sessions, cron logs, queues, managed runtime paths, sockets, pid/tmp).`,
      );
    }
    try {
      await publishPreparedBackupArchive({
        plan: publication,
        prepared: completedArchive,
        log: opts.log,
      });
    } catch (error) {
      throw formatBackupOutputFailure(error, outputPath, "publication");
    }
  } finally {
    await cleanupBackupArchivePublication(publication, opts.log);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}
