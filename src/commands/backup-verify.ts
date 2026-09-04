import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import * as tar from "tar";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import {
  assertArchiveSymbolicLinkTarget,
  isArchivePathWithin,
  normalizeArchivePath,
  normalizeArchiveRoot,
} from "../infra/backup-archive-path-policy.js";
import { isTransientSqliteBackupPath } from "../infra/backup-volatile-filter.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "../infra/disk-space.js";
import { formatErrorMessage, hasErrnoCode } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SQLITE_SIDECAR_SUFFIXES } from "../infra/sqlite-files.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { resolveUserPath } from "../utils.js";
import { BACKUP_MAX_DECOMPRESSION_RATIO, buildBackupArchivePath } from "./backup-shared.js";
import {
  type BackupManifest,
  isRootBackupManifestEntry,
  parseBackupManifest,
  verifyBackupManifestEntries,
} from "./backup-verify-manifest.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SQLITE_SNAPSHOT_EXTRACT_BYTES = 64 * 1024 * 1024 * 1024;
const SQLITE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES = 256 * 1024 * 1024;

type BackupVerifyOptions = {
  archive: string;
  json?: boolean;
};

type BackupVerifyResult = {
  ok: true;
  archivePath: string;
  archiveRoot: string;
  createdAt: string;
  runtimeVersion: string;
  assetCount: number;
  entryCount: number;
  symlinkCount: number;
};

type PreparedBackupArchive = {
  result: BackupVerifyResult;
  hardlinkTargets: ReadonlyMap<string, string>;
};

type ArchiveEntry = {
  path: string;
  linkpath?: string;
  size?: number;
  type?: string;
};

type NormalizedArchiveEntry = {
  raw: string;
  normalized: string;
  size?: number;
  type?: string;
};

type SqliteSnapshotEntry = NormalizedArchiveEntry & {
  stateAssetRoot: string;
  agentId?: string;
};

type ExpectedSqliteRole = "agent" | "global";

async function listArchiveEntries(archivePath: string) {
  const entries: ArchiveEntry[] = [];
  let invalidReason: string | undefined;
  await tar.t({
    file: archivePath,
    gzip: true,
    maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
    onwarn: (code, message) => {
      // tar skips invalid headers; a readable remainder is not a complete backup.
      if (code === "TAR_BAD_ARCHIVE" || code === "TAR_ENTRY_INVALID") {
        invalidReason ??= formatErrorMessage(message);
      }
    },
    onReadEntry: (entry) => {
      entries.push({
        path: entry.path,
        ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        ...(Number.isSafeInteger(entry.size) && entry.size >= 0 ? { size: entry.size } : {}),
        ...(entry.type ? { type: entry.type } : {}),
      });
    },
  });
  return { entries, invalidReason };
}

async function extractManifest(params: {
  archivePath: string;
  manifestEntryPath: string;
}): Promise<string> {
  const limitError = new Error(`Backup manifest exceeds ${MAX_MANIFEST_BYTES} byte limit.`);
  let manifestContentPromise: Promise<Buffer | Error> | undefined;
  await tar.t({
    file: params.archivePath,
    gzip: true,
    maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
    filter: (entryPath) => entryPath === params.manifestEntryPath,
    onReadEntry: (entry) => {
      manifestContentPromise =
        entry.size > MAX_MANIFEST_BYTES
          ? Promise.resolve(limitError)
          : entry.concat().catch((error: unknown) => toStringifiedError(error));
    },
  });

  if (!manifestContentPromise) {
    throw new Error(`Archive is missing manifest entry: ${params.manifestEntryPath}`);
  }
  const content = await manifestContentPromise;
  if (content instanceof Error) {
    throw content;
  }
  return content.toString("utf8");
}

function formatResult(result: BackupVerifyResult): string {
  return [
    `Backup archive OK: ${result.archivePath}`,
    `Archive root: ${result.archiveRoot}`,
    `Created at: ${result.createdAt}`,
    `Runtime version: ${result.runtimeVersion}`,
    `Assets verified: ${result.assetCount}`,
    `Archive entries scanned: ${result.entryCount}`,
    `Symbolic links checked: ${result.symlinkCount}`,
  ].join("\n");
}

function resolvePortableArchivePathKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function findPortableArchiveEntryPathCollision(
  entries: Array<{ normalized: string }>,
): { first: string; second: string } | undefined {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const key = resolvePortableArchivePathKey(entry.normalized);
    const first = seen.get(key);
    if (first && first !== entry.normalized) {
      return { first, second: entry.normalized };
    }
    seen.set(key, entry.normalized);
  }
  return undefined;
}

function isRegularArchiveFile(entryType: string | undefined): boolean {
  return entryType === "File" || entryType === "OldFile" || entryType === "ContiguousFile";
}

function resolveCanonicalStateAssetRoot(manifest: BackupManifest): string | undefined {
  const stateAssets = manifest.assets.filter((asset) => asset.kind === "state");
  if (stateAssets.length === 0) {
    return undefined;
  }
  if (stateAssets.length !== 1) {
    throw new Error(
      `Backup manifest must contain at most one state asset; found ${stateAssets.length}.`,
    );
  }

  const stateAsset = stateAssets[0];
  if (!stateAsset) {
    return undefined;
  }

  const stateAssetRoot = normalizeArchivePath(
    stateAsset.archivePath,
    "Backup manifest state asset path",
  );
  const expectedStateAssetRoot = buildBackupArchivePath(
    normalizeArchiveRoot(manifest.archiveRoot),
    stateAsset.sourcePath,
  );
  if (stateAssetRoot !== expectedStateAssetRoot) {
    throw new Error("Backup manifest state asset archivePath does not match its sourcePath.");
  }
  return stateAssetRoot;
}

function isSqliteSnapshotRelativePath(relativePath: string): boolean {
  const portablePath = resolvePortableArchivePathKey(relativePath);
  if (!portablePath.endsWith(".sqlite")) {
    return false;
  }
  if (resolveExpectedSqliteRoleFromRelativePath(relativePath)) {
    return true;
  }
  return (
    !portablePath.split("/").includes("node_modules") && !isTransientSqliteBackupPath(portablePath)
  );
}

function resolveSqliteSnapshotSidecarDatabasePath(relativePath: string): string | undefined {
  const portablePath = resolvePortableArchivePathKey(relativePath);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (portablePath.endsWith(suffix)) {
      const databasePath = relativePath.slice(0, -suffix.length);
      return isSqliteSnapshotRelativePath(databasePath) ? databasePath : undefined;
    }
  }
  return undefined;
}

function assertCanonicalSqlitePathCasing(relativePath: string, archivePath: string): void {
  const segments = relativePath.split("/");
  const portablePath = resolvePortableArchivePathKey(relativePath);
  const isGlobalAlias =
    portablePath === "state/openclaw.sqlite" && relativePath !== "state/openclaw.sqlite";
  const isAgentAlias =
    segments.length === 4 &&
    segments[0]?.toLowerCase() === "agents" &&
    Boolean(segments[1]) &&
    segments[2]?.toLowerCase() === "agent" &&
    segments[3]?.toLowerCase() === "openclaw-agent.sqlite" &&
    (segments[0] !== "agents" ||
      segments[2] !== "agent" ||
      segments[3] !== "openclaw-agent.sqlite");
  if (isGlobalAlias || isAgentAlias) {
    throw new Error(`Backup contains a case-mangled canonical SQLite path: ${archivePath}`);
  }
}

function listSqliteSnapshotEntries(
  manifest: BackupManifest,
  entries: NormalizedArchiveEntry[],
): SqliteSnapshotEntry[] {
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const roots = [
    ...(manifest.paths?.stateDir
      ? [
          {
            kind: "state" as const,
            archiveRoot: buildBackupArchivePath(archiveRoot, manifest.paths.stateDir),
          },
        ]
      : manifest.assets
          .filter((asset) => asset.kind === "state")
          .map((asset) => ({
            kind: "state" as const,
            archiveRoot: normalizeArchivePath(
              asset.archivePath,
              "Backup manifest state asset path",
            ),
          }))),
    ...(manifest.paths?.agentRoots ?? []).map(({ agentId, sourcePath }) => ({
      kind: "agent" as const,
      archiveRoot: buildBackupArchivePath(archiveRoot, sourcePath),
      agentId,
    })),
  ]
    .map((root) =>
      Object.assign(root, {
        portableArchiveRoot: resolvePortableArchivePathKey(root.archiveRoot),
      }),
    )
    .toSorted((left, right) => right.archiveRoot.length - left.archiveRoot.length);
  const sqliteEntries: SqliteSnapshotEntry[] = [];

  for (const entry of entries) {
    const portableEntryPath = resolvePortableArchivePathKey(entry.normalized);
    const portableRoot = roots.find((root) =>
      isArchivePathWithin(portableEntryPath, root.portableArchiveRoot),
    );
    const sqliteRoot = roots.find((root) =>
      isArchivePathWithin(entry.normalized, root.archiveRoot),
    );
    if (portableRoot && portableRoot !== sqliteRoot) {
      throw new Error(
        `Backup contains a case-mangled ${portableRoot.kind} asset path: ${entry.normalized}`,
      );
    }
    if (!sqliteRoot) {
      continue;
    }

    const relativePath = path.posix.relative(sqliteRoot.archiveRoot, entry.normalized);
    assertCanonicalSqlitePathCasing(relativePath, entry.normalized);
    if (
      sqliteRoot.kind === "agent" &&
      resolvePortableArchivePathKey(relativePath) === "openclaw-agent.sqlite" &&
      relativePath !== "openclaw-agent.sqlite"
    ) {
      throw new Error(`Backup contains a case-mangled canonical SQLite path: ${entry.normalized}`);
    }
    if (resolveSqliteSnapshotSidecarDatabasePath(relativePath)) {
      throw new Error(`Backup contains a SQLite snapshot sidecar: ${entry.normalized}`);
    }
    // Only state-owned database snapshots should be opened during verification.
    // Package content, excluded reindex artifacts, and noncanonical symlinks are
    // preserved or skipped by backup creation without becoming SQLite snapshots.
    if (!isSqliteSnapshotRelativePath(relativePath)) {
      continue;
    }
    const candidate: SqliteSnapshotEntry = {
      ...entry,
      stateAssetRoot: sqliteRoot.archiveRoot,
      ...(sqliteRoot.kind === "agent" ? { agentId: sqliteRoot.agentId } : {}),
    };
    if (resolveExpectedSqliteRole(candidate) || isRegularArchiveFile(entry.type)) {
      sqliteEntries.push(candidate);
    }
  }

  if (sqliteEntries.length > 0) {
    resolveCanonicalStateAssetRoot(manifest);
  }
  return sqliteEntries;
}

function resolveExpectedSqliteRole(entry: SqliteSnapshotEntry): ExpectedSqliteRole | undefined {
  const relativePath = path.posix.relative(entry.stateAssetRoot, entry.normalized);
  if (entry.agentId) {
    return relativePath === "openclaw-agent.sqlite" ? "agent" : undefined;
  }
  return resolveExpectedSqliteRoleFromRelativePath(relativePath);
}

function resolveExpectedSqliteRoleFromRelativePath(
  relativePath: string,
): ExpectedSqliteRole | undefined {
  if (relativePath === "state/openclaw.sqlite") {
    return "global";
  }
  const segments = relativePath.split("/");
  if (
    segments.length === 4 &&
    segments[0] === "agents" &&
    segments[1] &&
    segments[2] === "agent" &&
    segments[3] === "openclaw-agent.sqlite"
  ) {
    return "agent";
  }
  return undefined;
}

function resolveSqliteExtractionBytes(entries: SqliteSnapshotEntry[]): number {
  let totalBytes = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0) {
      throw new Error(`SQLite snapshot has an invalid archive size: ${entry.normalized}`);
    }
    if (entry.size === 0) {
      throw new Error(`SQLite snapshot is empty: ${entry.normalized}`);
    }
    totalBytes += entry.size ?? 0;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new Error("SQLite snapshot extraction size exceeds the supported integer range.");
    }
  }
  return totalBytes;
}

function assertSqliteExtractionBudget(params: {
  entries: SqliteSnapshotEntry[];
  tempRoot: string;
  readDiskSpace?: typeof tryReadDiskSpace;
}): void {
  const totalBytes = resolveSqliteExtractionBytes(params.entries);
  if (totalBytes > MAX_SQLITE_SNAPSHOT_EXTRACT_BYTES) {
    throw new Error(
      `SQLite snapshots require ${formatDiskSpaceBytes(totalBytes)} of extraction space; the verification limit is ${formatDiskSpaceBytes(MAX_SQLITE_SNAPSHOT_EXTRACT_BYTES)}.`,
    );
  }

  const diskSpace = (params.readDiskSpace ?? tryReadDiskSpace)(params.tempRoot);
  if (
    diskSpace &&
    totalBytes + SQLITE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES > diskSpace.availableBytes
  ) {
    throw new Error(
      `SQLite snapshots require ${formatDiskSpaceBytes(totalBytes)} of extraction space, but only ${formatDiskSpaceBytes(diskSpace.availableBytes)} is available near ${params.tempRoot}; verification reserves ${formatDiskSpaceBytes(SQLITE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES)} for the host.`,
    );
  }
}

function assertExpectedSqliteRole(
  database: DatabaseSync,
  archivePath: string,
  expectedRole: ExpectedSqliteRole,
): void {
  const schemaMetaTable = database
    .prepare("SELECT type FROM sqlite_schema WHERE name = 'schema_meta'")
    .get() as { type?: unknown } | undefined;
  if (schemaMetaTable?.type !== "table") {
    throw new Error(`SQLite snapshot ${archivePath} is missing the expected schema_meta table.`);
  }

  const metadata = database
    .prepare("SELECT role FROM schema_meta WHERE meta_key = 'primary'")
    .get() as { role?: unknown } | undefined;
  const actualRole = typeof metadata?.role === "string" ? metadata.role : "missing";
  if (actualRole !== expectedRole) {
    throw new Error(
      `SQLite snapshot ${archivePath} has role ${actualRole}; expected ${expectedRole}.`,
    );
  }
}

async function assertSqliteSnapshotFileShape(
  extractedPath: string,
  archivePath: string,
  expectedSize: number,
): Promise<void> {
  const header = Buffer.alloc(100);
  const handle = await fs.open(extractedPath, "r");
  try {
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (
      bytesRead !== header.byteLength ||
      header.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000"
    ) {
      throw new Error(`SQLite snapshot ${archivePath} has an invalid database header.`);
    }
  } finally {
    await handle.close();
  }

  const encodedPageSize = header.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  const validPageSize = pageSize >= 512 && pageSize <= 65_536 && (pageSize & (pageSize - 1)) === 0;
  if (!validPageSize || expectedSize % pageSize !== 0) {
    throw new Error(`SQLite snapshot ${archivePath} has an invalid page layout.`);
  }

  const changeCounter = header.readUInt32BE(24);
  const declaredPageCount = header.readUInt32BE(28);
  const versionValidFor = header.readUInt32BE(92);
  const hasAuthoritativePageCount = declaredPageCount !== 0 && changeCounter === versionValidFor;
  if (hasAuthoritativePageCount && declaredPageCount !== expectedSize / pageSize) {
    throw new Error(`SQLite snapshot ${archivePath} has an invalid page layout.`);
  }
}

async function verifySqliteSnapshots(params: {
  archivePath: string;
  entries: NormalizedArchiveEntry[];
  manifest: BackupManifest;
}): Promise<void> {
  const sqliteEntries = listSqliteSnapshotEntries(params.manifest, params.entries);
  if (sqliteEntries.length === 0) {
    return;
  }
  for (const entry of sqliteEntries) {
    if (!isRegularArchiveFile(entry.type)) {
      throw new Error(`SQLite snapshot must be a regular archive file: ${entry.normalized}`);
    }
  }

  const tempRoot = os.tmpdir();
  assertSqliteExtractionBudget({ entries: sqliteEntries, tempRoot });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-backup-verify-sqlite-"));
  try {
    const sqliteEntriesByRawPath = new Map(sqliteEntries.map((entry) => [entry.raw, entry]));
    await tar.x({
      file: params.archivePath,
      gzip: true,
      maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
      cwd: tempDir,
      strict: true,
      preserveOwner: false,
      filter: (entryPath, archiveEntry) => {
        const expected = sqliteEntriesByRawPath.get(entryPath);
        if (!expected) {
          return false;
        }
        if (archiveEntry.size !== expected.size) {
          throw new Error(`SQLite snapshot size changed during verification: ${entryPath}`);
        }
        return true;
      },
    });

    for (const entry of sqliteEntries) {
      const extractedPath = path.join(tempDir, ...entry.normalized.split("/"));
      const extractedStat = await fs.lstat(extractedPath);
      if (!extractedStat.isFile()) {
        throw new Error(`Extracted SQLite snapshot is not a regular file: ${entry.normalized}`);
      }
      if (extractedStat.size !== entry.size) {
        throw new Error(
          `Extracted SQLite snapshot size does not match archive: ${entry.normalized}`,
        );
      }

      let database: DatabaseSync | undefined;
      try {
        await assertSqliteSnapshotFileShape(extractedPath, entry.normalized, extractedStat.size);
        const expectedRole = resolveExpectedSqliteRole(entry);
        if (!expectedRole) {
          // Plugin-owned databases may require owner-specific functions,
          // collations, or virtual-table modules. Core can validate their
          // snapshot shape, but only canonical schemas are safe to interpret.
          continue;
        }
        database = openNodeSqliteDatabase(extractedPath, {
          allowExtension: true,
          readOnly: true,
        });
        database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
        await loadSqliteVecExtension({ db: database });
        assertSqliteIntegrity(database, entry.normalized);
        if (entry.agentId) {
          assertOpenClawAgentDatabaseOwner(database, {
            agentId: entry.agentId,
            pathname: entry.normalized,
          });
        } else {
          assertExpectedSqliteRole(database, entry.normalized, expectedRole);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Backup SQLite snapshot failed verification: ${entry.normalized}. ${message}`,
          { cause: err },
        );
      } finally {
        database?.close();
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function verifyResolvedBackupArchive(archivePath: string): Promise<PreparedBackupArchive> {
  let archiveStat;
  try {
    archiveStat = await fs.stat(archivePath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new Error(
        "Archive does not exist. Check the path and run `openclaw backup verify <archive>` again.",
        { cause: error },
      );
    }
    throw new Error(
      `Archive could not be inspected. ${formatErrorMessage(error)} Check the path and file permissions, then try again.`,
      { cause: error },
    );
  }
  if (!archiveStat.isFile()) {
    throw new Error(
      "Archive must be a regular file. Choose a backup archive created by `openclaw backup create` and try again.",
    );
  }

  const listing = await listArchiveEntries(archivePath).catch((error: unknown) => {
    throw new Error(
      `Archive could not be read or parsed. ${formatErrorMessage(error)} Check the file permissions and archive integrity, then try again.`,
    );
  });
  if (listing.invalidReason) {
    throw new Error(
      `Archive is not a valid OpenClaw backup. ${listing.invalidReason.replace(/[.!?]*$/u, ".")} Choose another archive or create a new one with \`openclaw backup create\`.`,
    );
  }
  const rawEntries = listing.entries;

  const entries = rawEntries.map((entry) => ({
    raw: entry.path,
    normalized: normalizeArchivePath(entry.path, "Archive entry"),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.type ? { type: entry.type } : {}),
  }));
  const symbolicLinks = rawEntries
    .filter((entry) => entry.type === "SymbolicLink")
    .map((entry) => ({ entryPath: entry.path, linkpath: entry.linkpath }));
  const rawEntryPaths = new Map<string, string>();
  let duplicateEntryPath: string | undefined;
  // Keep the first duplicate for validation below; manifest-count errors still win.
  for (const entry of entries) {
    if (rawEntryPaths.has(entry.normalized)) {
      duplicateEntryPath ??= entry.normalized;
    }
    rawEntryPaths.set(entry.normalized, entry.raw);
  }
  const normalizedEntrySet = new Set(rawEntryPaths.keys());

  const manifestMatches = entries.filter((entry) => isRootBackupManifestEntry(entry.normalized));
  if (manifestMatches.length !== 1) {
    throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
  }
  if (duplicateEntryPath) {
    throw new Error(`Archive contains duplicate entry path: ${duplicateEntryPath}`);
  }
  const portablePathCollision = findPortableArchiveEntryPathCollision(entries);
  if (portablePathCollision) {
    throw new Error(
      `Archive contains a portable path collision: ${portablePathCollision.first} and ${portablePathCollision.second}`,
    );
  }
  const manifestEntryPath = manifestMatches[0]?.raw;
  if (!manifestEntryPath) {
    throw new Error("Backup archive manifest entry could not be resolved.");
  }

  const manifestRaw = await extractManifest({ archivePath, manifestEntryPath });
  const manifest = parseBackupManifest(manifestRaw);
  verifyBackupManifestEntries(manifest, normalizedEntrySet);
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const hardlinkTargets = new Map<string, string>();
  for (const entry of rawEntries) {
    if (entry.type === "Link") {
      const target = normalizeArchivePath(
        entry.linkpath ?? "",
        `Archive hardlink target for ${entry.path}`,
      );
      // Older backups omit the archive root. Resolve once, retaining the actual
      // entry spelling: normalization is a lookup key, not a filename rewrite.
      const resolved = isArchivePathWithin(target, archiveRoot)
        ? target
        : path.posix.join(archiveRoot, target);
      const rawTarget = rawEntryPaths.get(resolved);
      if (!rawTarget) {
        throw new Error(
          `Archive hardlink target is missing from archive entries: ${entry.path} -> ${resolved}`,
        );
      }
      hardlinkTargets.set(entry.path, rawTarget);
    }
  }
  for (const link of symbolicLinks) {
    assertArchiveSymbolicLinkTarget({
      ...link,
      archiveRoot: manifest.archiveRoot,
      assetArchivePaths: manifest.assets.map((asset) => asset.archivePath),
    });
  }
  await verifySqliteSnapshots({ archivePath, entries, manifest });

  const result: BackupVerifyResult = {
    ok: true,
    archivePath,
    archiveRoot: manifest.archiveRoot,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
    assetCount: manifest.assets.length,
    entryCount: rawEntries.length,
    symlinkCount: symbolicLinks.length,
  };

  return { result, hardlinkTargets };
}

/** Verify an archive and prepare the exact hardlink targets needed by extraction. */
export async function prepareBackupArchive(archive: string): Promise<PreparedBackupArchive> {
  const archivePath = resolveUserPath(archive);
  return await verifyResolvedBackupArchive(archivePath).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : formatErrorMessage(error);
    throw new Error(`Backup archive verification failed: ${archivePath}. ${detail}`);
  });
}

/** Verify a backup archive without exposing extraction metadata in CLI output. */
export async function verifyBackupArchive(archive: string): Promise<BackupVerifyResult> {
  return (await prepareBackupArchive(archive)).result;
}

/** Verify a backup archive, including snapshot shape and canonical SQLite integrity checks. */
export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: BackupVerifyOptions,
): Promise<BackupVerifyResult> {
  const result = await verifyBackupArchive(opts.archive);

  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatResult(result));
  }
  return result;
}

export const testApi = {
  assertSqliteExtractionBudget,
};
