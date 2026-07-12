// Verifies backup archives by validating their manifest, payload entries, and hardlink targets.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import * as tar from "tar";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "../infra/disk-space.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRecord, resolveUserPath } from "../utils.js";
import { buildBackupArchivePath } from "./backup-shared.js";

const WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SQLITE_SNAPSHOT_EXTRACT_BYTES = 64 * 1024 * 1024 * 1024;
const SQLITE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES = 256 * 1024 * 1024;
const SQLITE_SNAPSHOT_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const SQLITE_BACKUP_EXCLUDED_SUFFIXES = [".reindex-lock.sqlite"] as const;
const SQLITE_BACKUP_REINDEX_TRANSIENT_PATTERN =
  /\.sqlite\.(?:backup|memory-reindex|tmp)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type BackupManifestAsset = {
  kind: string;
  sourcePath: string;
  archivePath: string;
};

type BackupManifest = {
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
};

type ExpectedSqliteRole = "agent" | "global";

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeArchivePath(entryPath: string, label: string): string {
  const trimmed = stripTrailingSlashes(entryPath.trim());
  if (!trimmed) {
    throw new Error(`${label} is empty.`);
  }
  if (trimmed.startsWith("/") || WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE.test(trimmed)) {
    throw new Error(`${label} must be relative: ${entryPath}`);
  }
  if (trimmed.includes("\\")) {
    throw new Error(`${label} must use forward slashes: ${entryPath}`);
  }
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} contains path traversal segments: ${entryPath}`);
  }

  const normalized = stripTrailingSlashes(path.posix.normalize(trimmed));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} resolves outside the archive root: ${entryPath}`);
  }
  return normalized;
}

function normalizeArchiveRoot(rootName: string): string {
  const normalized = normalizeArchivePath(rootName, "Backup manifest archiveRoot");
  if (normalized.includes("/")) {
    throw new Error(`Backup manifest archiveRoot must be a single path segment: ${rootName}`);
  }
  return normalized;
}

function isArchivePathWithin(child: string, parent: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

function parseManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Backup manifest is not valid JSON.", { cause: err });
  }

  if (!isRecord(parsed)) {
    throw new Error("Backup manifest must be an object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported backup manifest schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {
    throw new Error("Backup manifest is missing archiveRoot.");
  }
  if (typeof parsed.createdAt !== "string" || !parsed.createdAt.trim()) {
    throw new Error("Backup manifest is missing createdAt.");
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Backup manifest is missing assets.");
  }

  const assets: BackupManifestAsset[] = [];
  for (const asset of parsed.assets) {
    if (!isRecord(asset)) {
      throw new Error("Backup manifest contains a non-object asset.");
    }
    if (typeof asset.kind !== "string" || !asset.kind.trim()) {
      throw new Error("Backup manifest asset is missing kind.");
    }
    if (typeof asset.sourcePath !== "string" || !asset.sourcePath.trim()) {
      throw new Error("Backup manifest asset is missing sourcePath.");
    }
    if (typeof asset.archivePath !== "string" || !asset.archivePath.trim()) {
      throw new Error("Backup manifest asset is missing archivePath.");
    }
    assets.push({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    });
  }

  return {
    schemaVersion: 1,
    archiveRoot: parsed.archiveRoot,
    createdAt: parsed.createdAt,
    runtimeVersion:
      typeof parsed.runtimeVersion === "string" && parsed.runtimeVersion.trim()
        ? parsed.runtimeVersion
        : "unknown",
    platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
    options: isRecord(parsed.options)
      ? { includeWorkspace: parsed.options.includeWorkspace as boolean | undefined }
      : undefined,
    paths: isRecord(parsed.paths)
      ? {
          stateDir: readStringValue(parsed.paths.stateDir),
          configPath: readStringValue(parsed.paths.configPath),
          oauthDir: readStringValue(parsed.paths.oauthDir),
          workspaceDirs: Array.isArray(parsed.paths.workspaceDirs)
            ? parsed.paths.workspaceDirs.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : undefined,
        }
      : undefined,
    assets,
    skipped: Array.isArray(parsed.skipped) ? parsed.skipped : undefined,
  };
}

async function listArchiveEntries(archivePath: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push({
        path: entry.path,
        ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        ...(Number.isSafeInteger(entry.size) && entry.size >= 0 ? { size: entry.size } : {}),
        ...(entry.type ? { type: entry.type } : {}),
      });
      entry.resume();
    },
  });
  return entries;
}

async function extractManifest(params: {
  archivePath: string;
  manifestEntryPath: string;
}): Promise<string> {
  let manifestContentPromise: Promise<{ content?: string; error?: Error }> | undefined;
  await tar.t({
    file: params.archivePath,
    gzip: true,
    onentry: (entry) => {
      if (entry.path !== params.manifestEntryPath) {
        entry.resume();
        return;
      }

      manifestContentPromise = new Promise<{ content?: string; error?: Error }>((resolve) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let exceededLimit = false;
        let settled = false;
        const settle = (result: { content?: string; error?: Error }) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(result);
        };
        entry.on("data", (chunk: Buffer | string) => {
          if (exceededLimit) {
            return;
          }
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.byteLength;
          if (totalBytes > MAX_MANIFEST_BYTES) {
            exceededLimit = true;
            chunks.length = 0;
            return;
          }
          chunks.push(buffer);
        });
        entry.on("error", (error) => {
          settle({
            error: error instanceof Error ? error : new Error(String(error)),
          });
        });
        entry.on("end", () => {
          if (exceededLimit) {
            settle({
              error: new Error(`Backup manifest exceeds ${MAX_MANIFEST_BYTES} byte limit.`),
            });
            return;
          }
          settle({ content: Buffer.concat(chunks, totalBytes).toString("utf8") });
        });
      });
    },
  });

  if (!manifestContentPromise) {
    throw new Error(`Archive is missing manifest entry: ${params.manifestEntryPath}`);
  }
  const result = await manifestContentPromise;
  if (result.error) {
    throw result.error;
  }
  return result.content ?? "";
}

function isRootManifestEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}

function verifyManifestAgainstEntries(manifest: BackupManifest, entries: Set<string>): void {
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const manifestEntryPath = path.posix.join(archiveRoot, "manifest.json");
  const normalizedEntries = [...entries];
  const normalizedEntrySet = new Set(normalizedEntries);

  if (!normalizedEntrySet.has(manifestEntryPath)) {
    throw new Error(`Archive is missing manifest entry: ${manifestEntryPath}`);
  }

  for (const entry of normalizedEntries) {
    if (!isArchivePathWithin(entry, archiveRoot)) {
      throw new Error(`Archive entry is outside the declared archive root: ${entry}`);
    }
  }

  const payloadRoot = path.posix.join(archiveRoot, "payload");
  for (const asset of manifest.assets) {
    const assetArchivePath = normalizeArchivePath(asset.archivePath, "Backup manifest asset path");
    if (!isArchivePathWithin(assetArchivePath, payloadRoot)) {
      throw new Error(`Manifest asset path is outside payload root: ${asset.archivePath}`);
    }
    const exact = normalizedEntrySet.has(assetArchivePath);
    const nested = normalizedEntries.some(
      (entry) => entry !== assetArchivePath && isArchivePathWithin(entry, assetArchivePath),
    );
    if (!exact && !nested) {
      throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);
    }
  }
}

function verifyHardlinkTargetsAgainstArchiveRoot(
  hardlinkTargets: Array<{ entryPath: string; normalized: string }>,
  archiveRoot: string,
  entries: Set<string>,
): void {
  const normalizedRoot = normalizeArchiveRoot(archiveRoot);
  for (const target of hardlinkTargets) {
    // Older backup archives may store hardlink linkpath values relative to the
    // archive root instead of including the root segment. Accept that form only
    // when it resolves to a real entry inside this archive.
    const normalizedTarget = isArchivePathWithin(target.normalized, normalizedRoot)
      ? target.normalized
      : path.posix.join(normalizedRoot, target.normalized);
    if (!isArchivePathWithin(normalizedTarget, normalizedRoot)) {
      throw new Error(
        `Archive hardlink target is outside the declared archive root: ${target.entryPath} -> ${normalizedTarget}`,
      );
    }
    if (!entries.has(normalizedTarget)) {
      throw new Error(
        `Archive hardlink target is missing from archive entries: ${target.entryPath} -> ${normalizedTarget}`,
      );
    }
  }
}

function formatResult(result: BackupVerifyResult): string {
  return [
    `Backup archive OK: ${result.archivePath}`,
    `Archive root: ${result.archiveRoot}`,
    `Created at: ${result.createdAt}`,
    `Runtime version: ${result.runtimeVersion}`,
    `Assets verified: ${result.assetCount}`,
    `Archive entries scanned: ${result.entryCount}`,
  ].join("\n");
}

function findDuplicateNormalizedEntryPath(
  entries: Array<{ normalized: string }>,
): string | undefined {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.normalized)) {
      return entry.normalized;
    }
    seen.add(entry.normalized);
  }
  return undefined;
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
    !portablePath.split("/").includes("node_modules") &&
    !SQLITE_BACKUP_REINDEX_TRANSIENT_PATTERN.test(relativePath) &&
    !SQLITE_BACKUP_EXCLUDED_SUFFIXES.some((suffix) => portablePath.endsWith(suffix))
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
      cwd: tempDir,
      strict: true,
      preserveOwner: false,
      noChmod: true,
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
        const sqlite = requireNodeSqlite();
        database = new sqlite.DatabaseSync(extractedPath, {
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

/** Verify a backup archive, including snapshot shape and canonical SQLite integrity checks. */
export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: BackupVerifyOptions,
): Promise<BackupVerifyResult> {
  const archivePath = resolveUserPath(opts.archive);
  const rawEntries = await listArchiveEntries(archivePath);
  if (rawEntries.length === 0) {
    throw new Error("Backup archive is empty.");
  }

  const entries = rawEntries.map((entry) => ({
    raw: entry.path,
    normalized: normalizeArchivePath(entry.path, "Archive entry"),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.type ? { type: entry.type } : {}),
  }));
  const hardlinkTargets = rawEntries
    .filter((entry) => entry.type === "Link" && entry.linkpath)
    .map((entry) => ({
      entryPath: entry.path,
      normalized: normalizeArchivePath(
        entry.linkpath ?? "",
        `Archive hardlink target for ${entry.path}`,
      ),
    }));
  const normalizedEntrySet = new Set(entries.map((entry) => entry.normalized));

  const manifestMatches = entries.filter((entry) => isRootManifestEntry(entry.normalized));
  if (manifestMatches.length !== 1) {
    throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
  }
  const duplicateEntryPath = findDuplicateNormalizedEntryPath(entries);
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
  const manifest = parseManifest(manifestRaw);
  verifyManifestAgainstEntries(manifest, normalizedEntrySet);
  verifyHardlinkTargetsAgainstArchiveRoot(
    hardlinkTargets,
    manifest.archiveRoot,
    normalizedEntrySet,
  );
  await verifySqliteSnapshots({ archivePath, entries, manifest });

  const result: BackupVerifyResult = {
    ok: true,
    archivePath,
    archiveRoot: manifest.archiveRoot,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
    assetCount: manifest.assets.length,
    entryCount: rawEntries.length,
  };

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
