// Creates backup archives while filtering volatile runtime state.
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  buildBackupArchiveBasename,
  buildBackupArchivePath,
  buildBackupArchiveRoot,
  type BackupAsset,
  resolveBackupPlanFromDisk,
} from "../commands/backup-shared.js";
import { isPathWithin } from "../commands/cleanup-utils.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  sanitizeOpenClawGlobalStateSnapshot,
  sanitizeOpenClawStateLeaseRows,
} from "../state/openclaw-state-snapshot-sanitizer.js";
import { resolveHomeDir, resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { writeArchiveStreamToFile } from "./backup-create-stream.js";
import {
  removeBackupTempArchiveBestEffort,
  resolveBackupTarAttemptTempPaths,
  writeTarArchiveWithRetry,
} from "./backup-tar-retry.js";
import { isVolatileBackupPath } from "./backup-volatile-filter.js";
import { createBackupVolatileStatCache } from "./backup-volatile-stat-cache.js";
import { formatErrorMessage } from "./errors.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import { writeJson } from "./json-files.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

const loadTarRuntime = createLazyRuntimeModule(() => import("tar"));

type BackupLinkCacheKey = `${number}:${number}`;

class BackupLinkCache extends Map<BackupLinkCacheKey, string> {
  override get(_key: BackupLinkCacheKey): undefined {
    return undefined;
  }

  override set(_key: BackupLinkCacheKey, _value: string): this {
    return this;
  }
}

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

type BackupManifestAsset = {
  kind: BackupAsset["kind"];
  sourcePath: string;
  archivePath: string;
};

type BackupManifest = {
  schemaVersion: 1;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  options: {
    includeWorkspace: boolean;
    onlyConfig?: boolean;
  };
  paths: {
    stateDir: string;
    configPath: string;
    oauthDir: string;
    workspaceDirs: string[];
  };
  assets: BackupManifestAsset[];
  skipped: Array<{
    kind: string;
    sourcePath: string;
    reason: string;
    coveredBy?: string;
  }>;
};

export type BackupCreateResult = {
  createdAt: string;
  archiveRoot: string;
  archivePath: string;
  dryRun: boolean;
  includeWorkspace: boolean;
  onlyConfig: boolean;
  verified: boolean;
  assets: BackupAsset[];
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

async function assertOutputPathReady(outputPath: string): Promise<void> {
  try {
    await fs.access(outputPath);
    throw new Error(`Refusing to overwrite existing backup archive: ${outputPath}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }
}

function buildTempArchivePath(outputPath: string): string {
  return `${outputPath}.${randomUUID()}.tmp`;
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

function isLinkUnsupportedError(code: string | undefined): boolean {
  return code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM";
}

async function publishTempArchive(params: {
  tempArchivePath: string;
  outputPath: string;
}): Promise<void> {
  try {
    await fs.link(params.tempArchivePath, params.outputPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing backup archive: ${params.outputPath}`, {
        cause: err,
      });
    }
    if (!isLinkUnsupportedError(code)) {
      throw err;
    }

    try {
      // Some backup targets support ordinary files but not hard links.
      await fs.copyFile(params.tempArchivePath, params.outputPath, fsConstants.COPYFILE_EXCL);
    } catch (copyErr) {
      const copyCode = (copyErr as NodeJS.ErrnoException | undefined)?.code;
      if (copyCode !== "EEXIST") {
        await fs.rm(params.outputPath, { force: true }).catch(() => undefined);
      }
      if (copyCode === "EEXIST") {
        throw new Error(`Refusing to overwrite existing backup archive: ${params.outputPath}`, {
          cause: copyErr,
        });
      }
      throw copyErr;
    }
  }
  await fs.rm(params.tempArchivePath, { force: true });
}

async function canonicalizePathForContainment(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [];
  let probe = resolved;

  while (true) {
    try {
      const realProbe = await fs.realpath(probe);
      return suffix.length === 0 ? realProbe : path.join(realProbe, ...suffix.toReversed());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return resolved;
      }
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

function buildManifest(params: {
  createdAt: string;
  archiveRoot: string;
  includeWorkspace: boolean;
  onlyConfig: boolean;
  assets: BackupAsset[];
  skipped: BackupCreateResult["skipped"];
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
}): BackupManifest {
  return {
    schemaVersion: 1,
    createdAt: params.createdAt,
    archiveRoot: params.archiveRoot,
    runtimeVersion: resolveRuntimeServiceVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    options: {
      includeWorkspace: params.includeWorkspace,
      onlyConfig: params.onlyConfig,
    },
    paths: {
      stateDir: params.stateDir,
      configPath: params.configPath,
      oauthDir: params.oauthDir,
      workspaceDirs: params.workspaceDirs,
    },
    assets: params.assets.map((asset) => ({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    })),
    skipped: params.skipped.map((entry) => ({
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
        } (live sessions, cron logs, queues, sockets, pid/tmp).`,
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

function normalizeBackupFilterPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "");
}

const REINSTALLABLE_STATE_ROOTS = new Set(["dev", "git", "npm", "npm-runtime", "tools"]);

function buildStateBackupFilter(
  stateDir: string,
  preservedStatePaths: readonly string[] = [],
): (filePath: string) => boolean {
  const normalizedStateDir = normalizeBackupFilterPath(stateDir);
  const statePrefix = `${normalizedStateDir}/`;
  const resolvedPreservedPaths = preservedStatePaths.map((entry) => path.resolve(entry));

  return (filePath: string): boolean => {
    const normalizedFilePath = normalizeBackupFilterPath(filePath);
    if (!normalizedFilePath.startsWith(statePrefix)) {
      return true;
    }

    const segments = normalizedFilePath.slice(statePrefix.length).split("/");
    if (REINSTALLABLE_STATE_ROOTS.has(segments[0] ?? "")) {
      const resolvedFilePath = path.resolve(filePath);
      // Configured workspaces nested under a managed root remain authoritative
      // user state. Keep their ancestors traversable without admitting siblings.
      return resolvedPreservedPaths.some(
        (preservedPath) =>
          isPathWithin(resolvedFilePath, preservedPath) ||
          isPathWithin(preservedPath, resolvedFilePath),
      );
    }

    return segments[0] !== "extensions" || !segments.includes("node_modules");
  };
}

type SqliteBackupAsset = {
  sourcePath: string;
  archiveSourcePath: string;
  skippedSourcePaths: Set<string>;
};

type StateSqliteBackupPlan = {
  snapshots: SqliteBackupAsset[];
  discoveredSourcePaths: Set<string>;
};

const SQLITE_BACKUP_SOURCE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const SQLITE_BACKUP_EXCLUDED_SUFFIXES = [".reindex-lock.sqlite"] as const;
const SQLITE_BACKUP_REINDEX_TRANSIENT_PATTERN =
  /\.sqlite\.(?:backup|memory-reindex|tmp)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isCanonicalAgentSqlitePathOrAncestor(sourcePath: string, stateDir: string): boolean {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(sourcePath));
  const segments = relativePath.split(path.sep);
  if (segments[0] !== "agents" || !segments[1]) {
    return false;
  }
  if (segments.length === 2) {
    return true;
  }
  if (segments[2] !== "agent") {
    return false;
  }
  if (segments.length === 3) {
    return true;
  }
  if (segments.length !== 4) {
    return false;
  }
  return SQLITE_BACKUP_SOURCE_SUFFIXES.some(
    (suffix) => segments[3] === `openclaw-agent.sqlite${suffix}`,
  );
}

function isCanonicalAgentSqliteDatabasePath(sourcePath: string, stateDir: string): boolean {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(sourcePath));
  const segments = relativePath.split(path.sep);
  return (
    segments.length === 4 &&
    segments[0] === "agents" &&
    Boolean(segments[1]) &&
    segments[2] === "agent" &&
    segments[3] === "openclaw-agent.sqlite"
  );
}

function isStatePackageContentPath(sourcePath: string, stateDir: string): boolean {
  const resolvedStateDir = path.resolve(stateDir);
  const resolvedSourcePath = path.resolve(sourcePath);
  return (
    isPathWithin(resolvedSourcePath, resolvedStateDir) &&
    !isCanonicalAgentSqlitePathOrAncestor(resolvedSourcePath, resolvedStateDir) &&
    path.relative(resolvedStateDir, resolvedSourcePath).split(path.sep).includes("node_modules")
  );
}

function resolveSqliteBackupDatabasePath(sourcePath: string): string | undefined {
  for (const suffix of SQLITE_BACKUP_SOURCE_SUFFIXES.slice(1)) {
    if (sourcePath.endsWith(suffix)) {
      const databasePath = sourcePath.slice(0, -suffix.length);
      return databasePath.endsWith(".sqlite") ? databasePath : undefined;
    }
  }
  return sourcePath.endsWith(".sqlite") ? sourcePath : undefined;
}

function resolveSqliteBackupBasePath(sourcePath: string): string {
  for (const suffix of SQLITE_BACKUP_SOURCE_SUFFIXES.slice(1)) {
    if (sourcePath.endsWith(suffix)) {
      return sourcePath.slice(0, -suffix.length);
    }
  }
  return sourcePath;
}

function classifyStateSqliteBackupSourcePath(
  sourcePath: string,
  stateDir: string,
): "excluded" | "sqlite" | undefined {
  const resolvedSourcePath = path.resolve(sourcePath);
  if (!isPathWithin(resolvedSourcePath, stateDir)) {
    return undefined;
  }
  if (isStatePackageContentPath(resolvedSourcePath, stateDir)) {
    return undefined;
  }
  if (
    SQLITE_BACKUP_REINDEX_TRANSIENT_PATTERN.test(resolveSqliteBackupBasePath(resolvedSourcePath))
  ) {
    return "excluded";
  }
  const databasePath = resolveSqliteBackupDatabasePath(resolvedSourcePath);
  if (!databasePath) {
    return undefined;
  }
  return SQLITE_BACKUP_EXCLUDED_SUFFIXES.some((suffix) => databasePath.endsWith(suffix))
    ? "excluded"
    : "sqlite";
}

function isBackupTarFilterFile(entry: import("node:fs").Stats | import("tar").ReadEntry): boolean {
  return "isFile" in entry ? entry.isFile() : entry.type === "File";
}

async function listStateSqlitePaths(params: {
  stateDir: string;
  globalStateSqlitePath: string;
  preservedStatePaths?: readonly string[];
}): Promise<{ snapshotPaths: string[]; discoveredSourcePaths: Set<string> }> {
  const snapshotPaths = new Set<string>();
  const discoveredSourcePaths = new Set<string>();
  const stateFilter = buildStateBackupFilter(params.stateDir, params.preservedStatePaths);
  async function visit(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      // Preserve noncanonical state-tree symlinks instead of dereferencing
      // their SQLite-looking targets. Canonical agent DBs mirror the global
      // DB contract: snapshot the target so restore receives a regular file.
      if (entry.isSymbolicLink()) {
        if (isCanonicalAgentSqliteDatabasePath(entryPath, params.stateDir)) {
          let targetEntry: import("node:fs").Stats;
          try {
            targetEntry = await fs.stat(entryPath);
          } catch (err) {
            throw new Error(`Canonical agent SQLite symlink cannot be snapshotted: ${entryPath}`, {
              cause: err,
            });
          }
          if (!targetEntry.isFile()) {
            throw new Error(
              `Canonical agent SQLite symlink must resolve to a regular file: ${entryPath}`,
            );
          }
          const resolvedEntryPath = path.resolve(entryPath);
          snapshotPaths.add(resolvedEntryPath);
          discoveredSourcePaths.add(resolvedEntryPath);
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (stateFilter(entryPath) && !isStatePackageContentPath(entryPath, params.stateDir)) {
          await visit(entryPath);
        }
      } else if (
        entry.isFile() &&
        stateFilter(entryPath) &&
        !isStatePackageContentPath(entryPath, params.stateDir)
      ) {
        const resolvedEntryPath = path.resolve(entryPath);
        if (resolveSqliteBackupDatabasePath(resolvedEntryPath)) {
          discoveredSourcePaths.add(resolvedEntryPath);
        }
        if (
          entry.name.endsWith(".sqlite") &&
          !SQLITE_BACKUP_EXCLUDED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
        ) {
          snapshotPaths.add(resolvedEntryPath);
        }
      }
    }
  }
  await visit(params.stateDir);

  const globalStateSqlitePath = path.resolve(params.globalStateSqlitePath);
  let globalStateEntry: import("node:fs").Stats | undefined;
  try {
    globalStateEntry = await fs.lstat(globalStateSqlitePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  if (globalStateEntry?.isFile()) {
    snapshotPaths.add(globalStateSqlitePath);
    discoveredSourcePaths.add(globalStateSqlitePath);
  } else if (globalStateEntry?.isSymbolicLink()) {
    let targetEntry: import("node:fs").Stats;
    try {
      targetEntry = await fs.stat(globalStateSqlitePath);
    } catch (err) {
      throw new Error(
        `Canonical global SQLite symlink cannot be snapshotted: ${globalStateSqlitePath}`,
        { cause: err },
      );
    }
    if (!targetEntry.isFile()) {
      throw new Error(
        `Canonical global SQLite symlink must resolve to a regular file: ${globalStateSqlitePath}`,
      );
    }
    snapshotPaths.add(globalStateSqlitePath);
    discoveredSourcePaths.add(globalStateSqlitePath);
  } else if (globalStateEntry) {
    throw new Error(
      `Canonical global SQLite path must be a regular file or symlink to one: ${globalStateSqlitePath}`,
    );
  }

  return {
    snapshotPaths: [...snapshotPaths].toSorted((left, right) => left.localeCompare(right)),
    discoveredSourcePaths,
  };
}

async function createStateSqliteBackupPlan(params: {
  stateDir: string;
  tempDir: string;
  preservedStatePaths?: readonly string[];
}): Promise<StateSqliteBackupPlan> {
  // Complete discovery before writing snapshots. chooseBackupTempRoot keeps
  // tempDir outside stateDir, and this ordering prevents future overlap from
  // making backup discover one of its own staged SQLite files.
  const globalStateSqlitePath = path.resolve(
    resolveOpenClawStateSqlitePath({
      ...process.env,
      OPENCLAW_STATE_DIR: params.stateDir,
    }),
  );
  const discovery = await listStateSqlitePaths({
    stateDir: params.stateDir,
    globalStateSqlitePath,
    preservedStatePaths: params.preservedStatePaths,
  });
  const globalStateIdentity = await fs.stat(globalStateSqlitePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  const canonicalGlobalSourcePath = globalStateIdentity
    ? await fs.realpath(globalStateSqlitePath)
    : globalStateSqlitePath;
  const canonicalAgentSources = await Promise.all(
    discovery.snapshotPaths
      .filter((sourcePath) => isCanonicalAgentSqliteDatabasePath(sourcePath, params.stateDir))
      .map(async (sourcePath) => ({
        identity: await fs.stat(sourcePath),
        sourcePath: await fs.realpath(sourcePath),
      })),
  );
  const snapshots: SqliteBackupAsset[] = [];
  for (const archiveSourcePath of discovery.snapshotPaths) {
    // A discovered *.sqlite file that SQLite cannot snapshot aborts backup.
    // Raw-copying malformed or unreadable databases would restore unsafe state.
    // Resolve the canonical global path so a symlinked DB reads the target's
    // live WAL/SHM state instead of looking for sidecars beside the symlink.
    const archiveSourceIdentity = await fs.stat(archiveSourcePath);
    const isGlobalStateDatabase =
      globalStateIdentity !== undefined &&
      sameFileIdentity(globalStateIdentity, archiveSourceIdentity);
    const canonicalAgentSource = canonicalAgentSources.find((source) =>
      sameFileIdentity(source.identity, archiveSourceIdentity),
    );
    // Every alias of a canonical DB must read that database's WAL and receive
    // the same role-specific transient-row sanitizer.
    const sourceDatabasePath = isGlobalStateDatabase
      ? canonicalGlobalSourcePath
      : (canonicalAgentSource?.sourcePath ?? archiveSourcePath);
    const sourcePath = path.join(params.tempDir, `openclaw-state-db-${snapshots.length}.sqlite`);
    try {
      await createVerifiedSqliteSnapshot({
        sourcePath: sourceDatabasePath,
        targetPath: sourcePath,
        // Agent coordination is transient, while unrelated plugin databases
        // remain owner-defined. Queue and TTL-blob policy is global-only.
        transform: isGlobalStateDatabase
          ? sanitizeOpenClawGlobalStateSnapshot
          : canonicalAgentSource
            ? sanitizeOpenClawStateLeaseRows
            : undefined,
      });
    } catch (err) {
      throw new Error(
        `SQLite database cannot be compacted safely for backup: ${archiveSourcePath}. ${formatErrorMessage(err)}. The source must pass full integrity checks and VACUUM INTO with its required SQLite capabilities; raw page backup was refused because it can retain deleted data.`,
        { cause: err },
      );
    }
    snapshots.push({
      sourcePath,
      archiveSourcePath,
      skippedSourcePaths: new Set(
        [archiveSourcePath, sourceDatabasePath].flatMap((databasePath) =>
          SQLITE_BACKUP_SOURCE_SUFFIXES.map((suffix) => path.resolve(`${databasePath}${suffix}`)),
        ),
      ),
    });
  }
  return { snapshots, discoveredSourcePaths: discovery.discoveredSourcePaths };
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
  const result: BackupCreateResult = {
    createdAt,
    archiveRoot,
    archivePath: outputPath,
    dryRun: Boolean(opts.dryRun),
    includeWorkspace,
    onlyConfig,
    verified: false,
    assets: plan.included,
    skipped: plan.skipped,
    skippedVolatileCount: 0,
  };

  if (opts.dryRun) {
    return result;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempRoot = await chooseBackupTempRoot({ assets: result.assets, outputPath });
  await fs.mkdir(tempRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-backup-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  const tempArchivePath = buildTempArchivePath(outputPath);
  const tempArchiveCleanupPaths = resolveBackupTarAttemptTempPaths(tempArchivePath);
  const stateAsset = result.assets.find((asset) => asset.kind === "state");
  const preservedStatePaths = [
    plan.configPath,
    plan.oauthDir,
    ...plan.skipped
      .filter((asset) => asset.kind === "workspace" && asset.reason === "covered")
      .map((asset) => asset.sourcePath),
  ].filter((entry) => stateAsset && isPathWithin(entry, stateAsset.sourcePath));
  try {
    const stateSqliteBackup = stateAsset
      ? await createStateSqliteBackupPlan({
          stateDir: stateAsset.sourcePath,
          tempDir,
          preservedStatePaths,
        })
      : { snapshots: [], discoveredSourcePaths: new Set<string>() };
    const sourcePathRemaps = new Map<string, string>();
    const skippedSqliteSourcePaths = new Set<string>();
    for (const snapshot of stateSqliteBackup.snapshots) {
      sourcePathRemaps.set(path.resolve(snapshot.sourcePath), snapshot.archiveSourcePath);
      for (const skippedSourcePath of snapshot.skippedSourcePaths) {
        skippedSqliteSourcePaths.add(skippedSourcePath);
      }
    }
    const manifest = buildManifest({
      createdAt,
      archiveRoot,
      includeWorkspace,
      onlyConfig,
      assets: result.assets,
      skipped: result.skipped,
      stateDir: plan.stateDir,
      configPath: plan.configPath,
      oauthDir: plan.oauthDir,
      workspaceDirs: plan.workspaceDirs,
    });
    await writeJson(manifestPath, manifest, { trailingNewline: true });

    const tar = await loadTarRuntime();
    const stateFilter = stateAsset
      ? buildStateBackupFilter(stateAsset.sourcePath, preservedStatePaths)
      : undefined;
    const volatilePlan = { stateDirs: [stateAsset?.sourcePath ?? plan.stateDir] };
    let skippedVolatileCount = 0;
    // node-tar invokes filters from async stat callbacks, so throwing inside
    // the filter is uncaught. Omit unexpected SQLite and reject after tar settles.
    const unexpectedSqliteSourcePaths: string[] = [];
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
      if (stateFilter && !stateFilter(entryPath)) {
        return false;
      }
      const sqliteSourceKind = stateAsset
        ? classifyStateSqliteBackupSourcePath(resolvedEntryPath, stateAsset.sourcePath)
        : undefined;
      if (sqliteSourceKind === "excluded") {
        return false;
      }
      if (skippedSqliteSourcePaths.has(resolvedEntryPath)) {
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
      if (isVolatileBackupPath(entryPath, volatilePlan)) {
        skippedVolatileCount += 1;
        return false;
      }
      return true;
    };
    const completedTempArchivePath = await writeTarArchiveWithRetry({
      tempArchivePath,
      log: opts.log,
      runTar: async (attemptTempArchivePath) => {
        // tar.c re-walks the tree (and thus re-invokes tarFilter) on every
        // attempt, so reset the closure counter here or retries would report
        // cumulative skip counts across attempts instead of the final one.
        skippedVolatileCount = 0;
        unexpectedSqliteSourcePaths.length = 0;
        await writeArchiveStreamToFile({
          archivePath: attemptTempArchivePath,
          archiveStream: tar.c(
            {
              gzip: true,
              portable: true,
              preservePaths: true,
              linkCache: new BackupLinkCache(),
              statCache: createBackupVolatileStatCache(volatilePlan),
              filter: tarFilter,
              onWriteEntry: (entry) => {
                entry.path = remapArchiveEntryPath({
                  entryPath: entry.path,
                  manifestPath,
                  archiveRoot,
                  sourcePathRemaps,
                });
              },
            },
            [
              manifestPath,
              ...stateSqliteBackup.snapshots.map((snapshot) => snapshot.sourcePath),
              ...result.assets.map((asset) => asset.sourcePath),
            ],
          ),
        });
        const unexpectedSqliteSourcePath = unexpectedSqliteSourcePaths[0];
        if (unexpectedSqliteSourcePath) {
          throw new Error(
            `SQLite state appeared after snapshot discovery: ${unexpectedSqliteSourcePath}. Retry backup so it can be snapshotted.`,
          );
        }
      },
    });
    result.skippedVolatileCount = skippedVolatileCount;
    if (skippedVolatileCount > 0) {
      opts.log?.(
        `Backup skipped ${skippedVolatileCount} volatile file${
          skippedVolatileCount === 1 ? "" : "s"
        } (live sessions, cron logs, queues, sockets, pid/tmp).`,
      );
    }
    await publishTempArchive({ tempArchivePath: completedTempArchivePath, outputPath });
  } finally {
    for (const cleanupPath of tempArchiveCleanupPaths) {
      await removeBackupTempArchiveBestEffort(cleanupPath);
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
