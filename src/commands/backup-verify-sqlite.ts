import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import {
  isArchivePathWithin,
  normalizeArchivePath,
  normalizeArchiveRoot,
} from "../infra/backup-archive-path-policy.js";
import { isTransientSqliteBackupPath } from "../infra/backup-volatile-filter.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "../infra/disk-space.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { BACKUP_MAX_DECOMPRESSION_RATIO, buildBackupArchivePath } from "./backup-shared.js";

const MAX_SQLITE_SNAPSHOT_EXTRACT_BYTES = 64 * 1024 * 1024 * 1024;
const SQLITE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES = 256 * 1024 * 1024;
const SQLITE_SNAPSHOT_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

export type BackupManifestAsset = {
  kind: string;
  sourcePath: string;
  archivePath: string;
};

export type BackupManifest = {
  schemaVersion: number;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: string;
  nodeVersion: string;
  options?: {
    includeWorkspace?: boolean;
  };
  paths?: {
    stateDir?: string;
    configPath?: string;
    oauthDir?: string;
    workspaceDirs?: string[];
  };
  assets: BackupManifestAsset[];
  skipped?: Array<{
    kind?: string;
    sourcePath?: string;
    reason?: string;
    coveredBy?: string;
  }>;
};

export type NormalizedArchiveEntry = {
  raw: string;
  normalized: string;
  size?: number;
  type?: string;
};

type SqliteSnapshotEntry = NormalizedArchiveEntry & {
  stateAssetRoot: string;
};

type ExpectedSqliteRole = "agent" | "global";

export function resolvePortableArchivePathKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
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
  for (const suffix of SQLITE_SNAPSHOT_SIDECAR_SUFFIXES) {
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
  const declaredStateAssetRoots = manifest.assets
    .filter((asset) => asset.kind === "state")
    .map((asset) => normalizeArchivePath(asset.archivePath, "Backup manifest state asset path"));
  for (const root of declaredStateAssetRoots) {
    const portableRoot = resolvePortableArchivePathKey(root);
    for (const entry of entries) {
      const isExactStateEntry = isArchivePathWithin(entry.normalized, root);
      const isPortableStateEntry = isArchivePathWithin(
        resolvePortableArchivePathKey(entry.normalized),
        portableRoot,
      );
      if (isPortableStateEntry && !isExactStateEntry) {
        throw new Error(`Backup contains a case-mangled state asset path: ${entry.normalized}`);
      }
    }
  }

  const hasSqliteCandidate = entries.some((entry) =>
    declaredStateAssetRoots.some((root) => {
      if (!isArchivePathWithin(entry.normalized, root)) {
        return false;
      }
      const relativePath = path.posix.relative(root, entry.normalized);
      return (
        isSqliteSnapshotRelativePath(relativePath) ||
        resolveSqliteSnapshotSidecarDatabasePath(relativePath) !== undefined
      );
    }),
  );
  if (!hasSqliteCandidate) {
    return [];
  }

  const stateAssetRoot = resolveCanonicalStateAssetRoot(manifest);
  if (!stateAssetRoot) {
    return [];
  }

  for (const entry of entries) {
    if (!isArchivePathWithin(entry.normalized, stateAssetRoot)) {
      continue;
    }
    const relativePath = path.posix.relative(stateAssetRoot, entry.normalized);
    assertCanonicalSqlitePathCasing(relativePath, entry.normalized);
    if (resolveSqliteSnapshotSidecarDatabasePath(relativePath)) {
      throw new Error(`Backup contains a SQLite snapshot sidecar: ${entry.normalized}`);
    }
  }

  return entries.flatMap((entry) => {
    if (!isArchivePathWithin(entry.normalized, stateAssetRoot)) {
      return [];
    }
    const relativePath = path.posix.relative(stateAssetRoot, entry.normalized);
    // Only state-owned database snapshots should be opened during verification.
    // Package content, excluded reindex artifacts, and noncanonical symlinks are
    // preserved or skipped by backup creation without becoming SQLite snapshots.
    if (!isSqliteSnapshotRelativePath(relativePath)) {
      return [];
    }
    const candidate = { ...entry, stateAssetRoot };
    if (!resolveExpectedSqliteRole(candidate) && !isRegularArchiveFile(entry.type)) {
      return [];
    }
    return [candidate];
  });
}

function resolveExpectedSqliteRole(entry: SqliteSnapshotEntry): ExpectedSqliteRole | undefined {
  const relativePath = path.posix.relative(entry.stateAssetRoot, entry.normalized);
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

export function assertSqliteExtractionBudget(params: {
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
      header.subarray(0, 16).toString("utf8") !== "SQLite format 3 "
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

export async function verifySqliteSnapshots(params: {
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
        assertExpectedSqliteRole(database, entry.normalized, expectedRole);
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
