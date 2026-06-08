// Session disk-budget enforcement prunes orphaned artifacts before deleting store entries.
import fs from "node:fs";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
} from "../../trajectory/paths.js";
import {
  isCompactionCheckpointTranscriptFileName,
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  isSessionStoreTempArtifactName,
  isTrajectorySessionArtifactName,
} from "./artifacts.js";
import { resolveSessionFilePath } from "./paths.js";
import { shouldPreserveMaintenanceEntry } from "./store-maintenance.js";
import { loadSqliteSessionStore, resolveSqliteSessionStoreDatabasePath } from "./store-sqlite.js";
import type { SessionEntry } from "./types.js";

export type SessionDiskBudgetConfig = {
  maxDiskBytes: number | null;
  highWaterBytes: number | null;
};

export type SessionDiskBudgetSweepResult = {
  totalBytesBefore: number;
  totalBytesAfter: number;
  removedFiles: number;
  removedEntries: number;
  freedBytes: number;
  maxBytes: number;
  highWaterBytes: number;
  overBudget: boolean;
};

export type SessionUnreferencedArtifactSweepResult = {
  scannedFiles: number;
  removedFiles: number;
  freedBytes: number;
  olderThanMs: number;
};

export type SessionDiskBudgetLogger = {
  warn: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
};

const NOOP_LOGGER: SessionDiskBudgetLogger = {
  warn: () => {},
  info: () => {},
};

type SessionsDirFileStat = {
  path: string;
  canonicalPath: string;
  name: string;
  size: number;
  mtimeMs: number;
};

type LivePromptBlobRefs = {
  refCounts: Map<string, number>;
  hashesBySessionKey: Map<string, string[]>;
};

function canonicalizePathForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function measureSqliteSessionEntryBytes(key: string, entry: SessionEntry): number {
  return Buffer.byteLength(key, "utf-8") + Buffer.byteLength(JSON.stringify(entry), "utf-8");
}

function measureSqliteSessionStoreBytes(store: Record<string, SessionEntry>): number {
  let bytes = 0;
  for (const [key, entry] of Object.entries(store)) {
    bytes += measureSqliteSessionEntryBytes(key, entry);
  }
  return bytes;
}

function buildSqliteSessionEntrySizeMap(store: Record<string, SessionEntry>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, entry] of Object.entries(store)) {
    out.set(key, measureSqliteSessionEntryBytes(key, entry));
  }
  return out;
}

function resolveProjectedPromptBlobHash(entry: SessionEntry | undefined): string | undefined {
  const ref = entry?.skillsSnapshot?.promptRef;
  return ref?.algorithm === "sha256" && typeof ref.hash === "string" ? ref.hash : undefined;
}

function addPromptBlobRef(
  refs: LivePromptBlobRefs,
  sessionKey: string,
  hash: string | undefined,
): void {
  if (!hash) {
    return;
  }
  const existingHashes = refs.hashesBySessionKey.get(sessionKey);
  if (existingHashes?.includes(hash)) {
    return;
  }
  if (existingHashes) {
    existingHashes.push(hash);
  } else {
    refs.hashesBySessionKey.set(sessionKey, [hash]);
  }
  refs.refCounts.set(hash, (refs.refCounts.get(hash) ?? 0) + 1);
}

function buildProjectedPromptBlobRefs(store: Record<string, SessionEntry>): LivePromptBlobRefs {
  const refs: LivePromptBlobRefs = {
    refCounts: new Map<string, number>(),
    hashesBySessionKey: new Map<string, string[]>(),
  };
  for (const [sessionKey, entry] of Object.entries(store)) {
    const hash = resolveProjectedPromptBlobHash(entry);
    addPromptBlobRef(refs, sessionKey, hash);
  }
  return refs;
}

function mergePromptBlobRefs(
  into: LivePromptBlobRefs,
  store: Record<string, SessionEntry>,
): LivePromptBlobRefs {
  for (const [sessionKey, entry] of Object.entries(store)) {
    const hash = resolveProjectedPromptBlobHash(entry);
    addPromptBlobRef(into, sessionKey, hash);
  }
  return into;
}

function buildLivePromptBlobRefs(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
}): LivePromptBlobRefs {
  const refs = buildProjectedPromptBlobRefs(params.store);
  try {
    // Hydration replaces persisted promptRef with prompt text in memory. Merge
    // the raw SQLite rows so cleanup keeps legacy sidecars alive until the row
    // has actually been rewritten without promptRef.
    mergePromptBlobRefs(refs, loadSqliteSessionStore(params.storePath));
  } catch {
    // Artifact cleanup should stay best-effort; unreadable SQLite state is
    // handled by the normal session-store/doctor paths.
  }
  return refs;
}

function getEntryUpdatedAt(entry?: SessionEntry): number {
  if (!entry) {
    return 0;
  }
  const updatedAt = entry.updatedAt;
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function buildSessionIdRefCounts(store: Record<string, SessionEntry>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of Object.values(store)) {
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      continue;
    }
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
  }
  return counts;
}

function resolveSessionTranscriptPathForEntry(params: {
  sessionsDir: string;
  entry: SessionEntry;
}): string | null {
  if (!params.entry.sessionId) {
    return null;
  }
  try {
    const resolved = resolveSessionFilePath(params.entry.sessionId, params.entry, {
      sessionsDir: params.sessionsDir,
    });
    const resolvedSessionsDir = canonicalizePathForComparison(params.sessionsDir);
    const resolvedPath = canonicalizePathForComparison(resolved);
    const relative = path.relative(resolvedSessionsDir, resolvedPath);
    // Cleanup only owns artifacts under the sessions directory; absolute/parent escapes are
    // ignored even if a stale entry points there.
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return resolvedPath;
  } catch {
    return null;
  }
}

function resolveSessionArtifactPathsForEntry(params: {
  sessionsDir: string;
  entry: SessionEntry;
}): string[] {
  const transcriptPath = resolveSessionTranscriptPathForEntry(params);
  if (!transcriptPath) {
    return [];
  }
  const paths = [transcriptPath];
  if (params.entry.sessionId) {
    paths.push(resolveTrajectoryPointerFilePath(transcriptPath));
    paths.push(
      resolveTrajectoryFilePath({
        env: {},
        sessionFile: transcriptPath,
        sessionId: params.entry.sessionId,
      }),
    );
  }
  return paths;
}

export function resolveSessionArtifactCanonicalPathsForEntry(params: {
  sessionsDir: string;
  entry: SessionEntry;
}): string[] {
  return resolveSessionArtifactPathsForEntry(params).map(canonicalizePathForComparison);
}

function resolveReferencedSessionArtifactPaths(params: {
  sessionsDir: string;
  store: Record<string, SessionEntry>;
}): Set<string> {
  const referenced = new Set<string>();
  const resolvedSessionsDir = canonicalizePathForComparison(params.sessionsDir);
  for (const entry of Object.values(params.store)) {
    for (const resolved of resolveSessionArtifactCanonicalPathsForEntry({
      sessionsDir: params.sessionsDir,
      entry,
    })) {
      referenced.add(resolved);
    }
    for (const checkpoint of entry.compactionCheckpoints ?? []) {
      const checkpointFiles = [
        checkpoint.preCompaction.sessionFile?.trim(),
        checkpoint.postCompaction.sessionFile?.trim(),
      ].filter((filePath): filePath is string => Boolean(filePath));
      for (const checkpointFile of checkpointFiles) {
        const resolvedCheckpointPath = canonicalizePathForComparison(checkpointFile);
        const relative = path.relative(resolvedSessionsDir, resolvedCheckpointPath);
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          referenced.add(resolvedCheckpointPath);
        }
      }
    }
  }
  return referenced;
}

async function readSessionsDirFiles(sessionsDir: string): Promise<SessionsDirFileStat[]> {
  const dirEntries = await fs.promises
    .readdir(sessionsDir, { withFileTypes: true })
    .catch(() => []);
  const files: SessionsDirFileStat[] = [];
  for (const dirent of dirEntries) {
    if (!dirent.isFile()) {
      continue;
    }
    const filePath = path.join(sessionsDir, dirent.name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    files.push({
      path: filePath,
      canonicalPath: canonicalizePathForComparison(filePath),
      name: dirent.name,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  return files;
}

async function readSqliteSessionStoreFiles(storePath: string): Promise<SessionsDirFileStat[]> {
  const sqlitePath = resolveSqliteSessionStoreDatabasePath(storePath);
  const candidates = [
    sqlitePath,
    `${sqlitePath}-wal`,
    `${sqlitePath}-shm`,
    `${sqlitePath}-journal`,
  ];
  const files: SessionsDirFileStat[] = [];
  for (const filePath of candidates) {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    files.push({
      path: filePath,
      canonicalPath: canonicalizePathForComparison(filePath),
      name: path.basename(filePath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  return files;
}

function uniqueFilesByCanonicalPath(files: SessionsDirFileStat[]): SessionsDirFileStat[] {
  const byPath = new Map<string, SessionsDirFileStat>();
  for (const file of files) {
    byPath.set(file.canonicalPath, file);
  }
  return [...byPath.values()];
}

async function readSessionPromptBlobFiles(sessionsDir: string): Promise<SessionsDirFileStat[]> {
  const root = path.join(sessionsDir, "skills-prompts", "sha256");
  const prefixEntries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  const files: SessionsDirFileStat[] = [];
  for (const prefixEntry of prefixEntries) {
    if (!prefixEntry.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefixEntry.name)) {
      continue;
    }
    const prefixDir = path.join(root, prefixEntry.name);
    const blobEntries = await fs.promises
      .readdir(prefixDir, { withFileTypes: true })
      .catch(() => []);
    for (const blobEntry of blobEntries) {
      if (
        !blobEntry.isFile() ||
        (!/^[a-f0-9]{64}\.txt$/u.test(blobEntry.name) &&
          !isSessionPromptBlobTempArtifactName(blobEntry.name))
      ) {
        continue;
      }
      const filePath = path.join(prefixDir, blobEntry.name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      files.push({
        path: filePath,
        canonicalPath: canonicalizePathForComparison(filePath),
        name: blobEntry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  return files;
}

function resolvePromptBlobFileHash(file: Pick<SessionsDirFileStat, "name">): string | undefined {
  return /^[a-f0-9]{64}\.txt$/u.test(file.name) ? file.name.slice(0, -4) : undefined;
}

function isSessionPromptBlobTempArtifactName(name: string): boolean {
  return /^[a-f0-9]{64}\.txt\.(?:\d+\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u.test(
    name,
  );
}

function isUnreferencedSessionArtifactFile(
  file: Pick<SessionsDirFileStat, "canonicalPath" | "name">,
  referencedPaths: ReadonlySet<string>,
): boolean {
  if (referencedPaths.has(file.canonicalPath)) {
    return false;
  }
  return (
    isCompactionCheckpointTranscriptFileName(file.name) ||
    isTrajectorySessionArtifactName(file.name) ||
    isPrimarySessionTranscriptFileName(file.name)
  );
}

// An orphaned `sessions.json.<pid>.<uuid>.tmp` older than this is never a live
// atomic write (those rename within milliseconds), so it is safe to reclaim
// regardless of the general unreferenced-artifact age threshold (#56827).
const SESSION_STORE_TEMP_STALE_MS = 5 * 60 * 1000;
// Prompt blobs are written or mtime-refreshed before sessions.json points at
// them. Treat fresh unreferenced blobs as in-flight so cleanup cannot strand a
// durable promptRef that is about to be committed by another writer.
const SESSION_PROMPT_BLOB_UNREFERENCED_GRACE_MS = SESSION_STORE_TEMP_STALE_MS;

function isUnreferencedPromptBlobFileRemovable(
  file: Pick<SessionsDirFileStat, "name" | "mtimeMs">,
  projectedPromptBlobRefCounts: ReadonlyMap<string, number>,
  cutoffMs: number,
): boolean {
  if (file.mtimeMs > cutoffMs) {
    return false;
  }
  const hash = resolvePromptBlobFileHash(file);
  return hash ? !projectedPromptBlobRefCounts.has(hash) : false;
}

function isPromptBlobArtifactRemovable(
  file: Pick<SessionsDirFileStat, "name" | "mtimeMs">,
  projectedPromptBlobRefCounts: ReadonlyMap<string, number>,
  promptBlobCutoffMs: number,
  tempCutoffMs: number,
): boolean {
  if (isSessionPromptBlobTempArtifactName(file.name)) {
    return file.mtimeMs <= tempCutoffMs;
  }
  return isUnreferencedPromptBlobFileRemovable(
    file,
    projectedPromptBlobRefCounts,
    promptBlobCutoffMs,
  );
}

function isDiskBudgetRemovableSessionFile(
  file: Pick<SessionsDirFileStat, "canonicalPath" | "name" | "mtimeMs">,
  referencedPaths: ReadonlySet<string>,
  tempStaleCutoffMs: number,
  storeBasename: string,
): boolean {
  // Store temps are only removable once clearly stale, even under disk pressure:
  // `replaceFileAtomic` uses this exact path as the live source before its rename,
  // so deleting a fresh in-flight temp would make another process's save fail.
  if (isSessionStoreTempArtifactName(file.name, storeBasename)) {
    return file.mtimeMs <= tempStaleCutoffMs;
  }
  return (
    isSessionArchiveArtifactName(file.name) ||
    isUnreferencedSessionArtifactFile(file, referencedPaths)
  );
}

async function removeFileIfExists(filePath: string): Promise<number> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    return 0;
  }
  await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
  return stat.size;
}

async function removeFileForBudget(params: {
  filePath: string;
  canonicalPath?: string;
  dryRun: boolean;
  fileSizesByPath: Map<string, number>;
  simulatedRemovedPaths: Set<string>;
  onRemovedPath?: (canonicalPath: string) => void;
}): Promise<number> {
  const resolvedPath = path.resolve(params.filePath);
  const canonicalPath = params.canonicalPath ?? canonicalizePathForComparison(resolvedPath);
  if (params.dryRun) {
    // Dry-run deletion is path-deduped so a transcript and pointer alias cannot count the same
    // artifact twice against the simulated budget.
    if (params.simulatedRemovedPaths.has(canonicalPath)) {
      return 0;
    }
    const size = params.fileSizesByPath.get(canonicalPath) ?? 0;
    if (size <= 0) {
      return 0;
    }
    params.simulatedRemovedPaths.add(canonicalPath);
    params.onRemovedPath?.(canonicalPath);
    return size;
  }
  const size = await removeFileIfExists(resolvedPath);
  if (size > 0) {
    params.onRemovedPath?.(canonicalPath);
  }
  return size;
}

async function removePromptBlobFileForBudget(params: {
  file: SessionsDirFileStat;
  projectedPromptBlobRefCounts: ReadonlyMap<string, number>;
  promptBlobCutoffMs: number;
  tempCutoffMs: number;
  dryRun: boolean;
  fileSizesByPath: Map<string, number>;
  simulatedRemovedPaths: Set<string>;
  onRemovedPath?: (canonicalPath: string) => void;
}): Promise<number> {
  let file = params.file;
  if (!params.dryRun) {
    const stat = await fs.promises.stat(file.path).catch(() => null);
    if (!stat?.isFile()) {
      return 0;
    }
    file = {
      ...file,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }
  if (
    !isPromptBlobArtifactRemovable(
      file,
      params.projectedPromptBlobRefCounts,
      params.promptBlobCutoffMs,
      params.tempCutoffMs,
    )
  ) {
    return 0;
  }
  return await removeFileForBudget({
    filePath: file.path,
    canonicalPath: file.canonicalPath,
    dryRun: params.dryRun,
    fileSizesByPath: params.fileSizesByPath,
    simulatedRemovedPaths: params.simulatedRemovedPaths,
    onRemovedPath: params.onRemovedPath,
  });
}

export async function pruneUnreferencedSessionArtifacts(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  olderThanMs: number;
  dryRun?: boolean;
  excludeCanonicalPaths?: ReadonlySet<string>;
}): Promise<SessionUnreferencedArtifactSweepResult> {
  const olderThanMs =
    Number.isFinite(params.olderThanMs) && params.olderThanMs > 0 ? params.olderThanMs : 0;
  const sessionsDir = path.dirname(params.storePath);
  const files = await readSessionsDirFiles(sessionsDir);
  const promptBlobFiles = await readSessionPromptBlobFiles(sessionsDir);
  const fileSizesByPath = new Map(
    [...files, ...promptBlobFiles].map((file) => [file.canonicalPath, file.size]),
  );
  const simulatedRemovedPaths = new Set<string>();
  const referencedPaths = resolveReferencedSessionArtifactPaths({
    sessionsDir,
    store: params.store,
  });
  const projectedPromptBlobRefs = buildLivePromptBlobRefs({
    store: params.store,
    storePath: params.storePath,
  });
  const cutoffMs = Date.now() - olderThanMs;
  const tempCutoffMs = Date.now() - SESSION_STORE_TEMP_STALE_MS;
  const promptBlobCutoffMs =
    Date.now() - Math.max(olderThanMs, SESSION_PROMPT_BLOB_UNREFERENCED_GRACE_MS);
  const storeBasename = path.basename(params.storePath);
  const removableStoreFiles = files.filter((file) => {
    if (params.excludeCanonicalPaths?.has(file.canonicalPath)) {
      return false;
    }
    // Orphaned store atomic-write temps are reclaimed on their own short
    // staleness window, independent of the unreferenced-artifact age (#56827).
    if (isSessionStoreTempArtifactName(file.name, storeBasename)) {
      return file.mtimeMs <= tempCutoffMs;
    }
    return file.mtimeMs <= cutoffMs && isUnreferencedSessionArtifactFile(file, referencedPaths);
  });
  const removablePromptBlobFiles = promptBlobFiles.filter((file) => {
    if (params.excludeCanonicalPaths?.has(file.canonicalPath)) {
      return false;
    }
    return isPromptBlobArtifactRemovable(
      file,
      projectedPromptBlobRefs.refCounts,
      promptBlobCutoffMs,
      tempCutoffMs,
    );
  });
  const removableFiles = [
    ...removableStoreFiles.map((file) => ({ kind: "store" as const, file })),
    ...removablePromptBlobFiles.map((file) => ({ kind: "promptBlob" as const, file })),
  ]
    .filter((file) => {
      return !params.excludeCanonicalPaths?.has(file.file.canonicalPath);
    })
    .toSorted((a, b) => a.file.mtimeMs - b.file.mtimeMs);

  let removedFiles = 0;
  let freedBytes = 0;
  const dryRun = params.dryRun === true;
  for (const item of removableFiles) {
    const deletedBytes =
      item.kind === "promptBlob"
        ? await removePromptBlobFileForBudget({
            file: item.file,
            projectedPromptBlobRefCounts: projectedPromptBlobRefs.refCounts,
            promptBlobCutoffMs,
            tempCutoffMs,
            dryRun,
            fileSizesByPath,
            simulatedRemovedPaths,
          })
        : await removeFileForBudget({
            filePath: item.file.path,
            canonicalPath: item.file.canonicalPath,
            dryRun,
            fileSizesByPath,
            simulatedRemovedPaths,
          });
    if (deletedBytes <= 0) {
      continue;
    }
    removedFiles += 1;
    freedBytes += deletedBytes;
  }

  return {
    scannedFiles: files.length + promptBlobFiles.length,
    removedFiles,
    freedBytes,
    olderThanMs,
  };
}

export async function enforceSessionDiskBudget(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  activeSessionKey?: string;
  preserveKeys?: ReadonlySet<string>;
  maintenance: SessionDiskBudgetConfig;
  warnOnly: boolean;
  dryRun?: boolean;
  log?: SessionDiskBudgetLogger;
  onRemoveFile?: (canonicalPath: string) => void;
}): Promise<SessionDiskBudgetSweepResult | null> {
  const maxBytes = params.maintenance.maxDiskBytes;
  const highWaterBytes = params.maintenance.highWaterBytes;
  if (maxBytes == null || highWaterBytes == null) {
    return null;
  }
  const log = params.log ?? NOOP_LOGGER;
  const dryRun = params.dryRun === true;
  const sessionsDir = path.dirname(params.storePath);
  const files = await readSessionsDirFiles(sessionsDir);
  const promptBlobFiles = await readSessionPromptBlobFiles(sessionsDir);
  const sqliteFiles = await readSqliteSessionStoreFiles(params.storePath);
  const allCurrentFiles = uniqueFilesByCanonicalPath([
    ...files,
    ...promptBlobFiles,
    ...sqliteFiles,
  ]);
  const fileSizesByPath = new Map(allCurrentFiles.map((file) => [file.canonicalPath, file.size]));
  const simulatedRemovedPaths = new Set<string>();
  const resolvedStorePath = canonicalizePathForComparison(params.storePath);
  const storeFile = files.find((file) => file.canonicalPath === resolvedStorePath);
  const currentSqliteBytes = sqliteFiles.reduce((sum, file) => sum + file.size, 0);
  let projectedSqliteBytes = measureSqliteSessionStoreBytes(params.store);
  let sqliteBudgetBytes = projectedSqliteBytes;
  const existingPromptBlobFilesByHash = new Map<string, SessionsDirFileStat>();
  for (const file of promptBlobFiles) {
    const hash = resolvePromptBlobFileHash(file);
    if (hash) {
      existingPromptBlobFilesByHash.set(hash, file);
    }
  }
  const projectedPromptBlobRefs = buildLivePromptBlobRefs({
    store: params.store,
    storePath: params.storePath,
  });
  // Budget starts from current files, then swaps in projected session row bytes.
  // The agent DB can also contain auth profiles and unrelated cache scopes that
  // session eviction cannot reclaim, so those physical DB bytes are excluded.
  let total =
    allCurrentFiles.reduce((sum, file) => sum + file.size, 0) -
    (storeFile?.size ?? 0) -
    currentSqliteBytes +
    sqliteBudgetBytes;
  const totalBefore = total;
  if (total <= maxBytes) {
    return {
      totalBytesBefore: totalBefore,
      totalBytesAfter: total,
      removedFiles: 0,
      removedEntries: 0,
      freedBytes: 0,
      maxBytes,
      highWaterBytes,
      overBudget: false,
    };
  }

  if (params.warnOnly) {
    log.warn("session disk budget exceeded (warn-only mode)", {
      sessionsDir,
      totalBytes: total,
      maxBytes,
      highWaterBytes,
    });
    return {
      totalBytesBefore: totalBefore,
      totalBytesAfter: total,
      removedFiles: 0,
      removedEntries: 0,
      freedBytes: 0,
      maxBytes,
      highWaterBytes,
      overBudget: true,
    };
  }

  let removedFiles = 0;
  let removedEntries = 0;
  let freedBytes = 0;

  const referencedPaths = resolveReferencedSessionArtifactPaths({
    sessionsDir,
    store: params.store,
  });
  const tempStaleCutoffMs = Date.now() - SESSION_STORE_TEMP_STALE_MS;
  const promptBlobOrphanCutoffMs = Date.now() - SESSION_PROMPT_BLOB_UNREFERENCED_GRACE_MS;
  const storeBasename = path.basename(params.storePath);
  const unreferencedPromptBlobQueue = promptBlobFiles
    .filter((file) => {
      return isPromptBlobArtifactRemovable(
        file,
        projectedPromptBlobRefs.refCounts,
        promptBlobOrphanCutoffMs,
        tempStaleCutoffMs,
      );
    })
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
  // Cheapest cleanup first: orphaned prompt blobs can relieve pressure without losing sessions.
  for (const file of unreferencedPromptBlobQueue) {
    if (total <= highWaterBytes) {
      break;
    }
    const deletedBytes = await removePromptBlobFileForBudget({
      file,
      projectedPromptBlobRefCounts: projectedPromptBlobRefs.refCounts,
      promptBlobCutoffMs: promptBlobOrphanCutoffMs,
      tempCutoffMs: tempStaleCutoffMs,
      dryRun,
      fileSizesByPath,
      simulatedRemovedPaths,
      onRemovedPath: params.onRemoveFile,
    });
    if (deletedBytes <= 0) {
      continue;
    }
    total -= deletedBytes;
    freedBytes += deletedBytes;
    removedFiles += 1;
  }

  const removableFileQueue = files
    .filter((file) =>
      isDiskBudgetRemovableSessionFile(file, referencedPaths, tempStaleCutoffMs, storeBasename),
    )
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
  // Then remove stale artifacts already detached from live entries.
  for (const file of removableFileQueue) {
    if (total <= highWaterBytes) {
      break;
    }
    const deletedBytes = await removeFileForBudget({
      filePath: file.path,
      canonicalPath: file.canonicalPath,
      dryRun,
      fileSizesByPath,
      simulatedRemovedPaths,
      onRemovedPath: params.onRemoveFile,
    });
    if (deletedBytes <= 0) {
      continue;
    }
    total -= deletedBytes;
    freedBytes += deletedBytes;
    removedFiles += 1;
  }

  if (total > highWaterBytes) {
    const activeSessionKey = normalizeOptionalLowercaseString(params.activeSessionKey);
    const sessionIdRefCounts = buildSessionIdRefCounts(params.store);
    const sqliteEntryBytesByKey = buildSqliteSessionEntrySizeMap(params.store);
    const keys = Object.keys(params.store).toSorted((a, b) => {
      const aTime = getEntryUpdatedAt(params.store[a]);
      const bTime = getEntryUpdatedAt(params.store[b]);
      return aTime - bTime;
    });
    // Last resort: delete oldest non-preserved sessions, then their now-unreferenced artifacts.
    for (const key of keys) {
      if (total <= highWaterBytes) {
        break;
      }
      if (activeSessionKey && normalizeLowercaseStringOrEmpty(key) === activeSessionKey) {
        continue;
      }
      const entry = params.store[key];
      if (!entry) {
        continue;
      }
      if (shouldPreserveMaintenanceEntry({ key, entry, preserveKeys: params.preserveKeys })) {
        continue;
      }
      const promptBlobHashes = projectedPromptBlobRefs.hashesBySessionKey.get(key) ?? [];
      delete params.store[key];
      projectedPromptBlobRefs.hashesBySessionKey.delete(key);
      const previousSqliteBudgetBytes = sqliteBudgetBytes;
      const entryBytes = sqliteEntryBytesByKey.get(key);
      sqliteEntryBytesByKey.delete(key);
      if (typeof entryBytes === "number" && Number.isFinite(entryBytes) && entryBytes >= 0) {
        projectedSqliteBytes = Math.max(0, projectedSqliteBytes - entryBytes);
      } else {
        projectedSqliteBytes = measureSqliteSessionStoreBytes(params.store);
      }
      sqliteBudgetBytes = projectedSqliteBytes;
      total += sqliteBudgetBytes - previousSqliteBudgetBytes;
      for (const promptBlobHash of promptBlobHashes) {
        const nextRefCount = (projectedPromptBlobRefs.refCounts.get(promptBlobHash) ?? 1) - 1;
        if (nextRefCount > 0) {
          projectedPromptBlobRefs.refCounts.set(promptBlobHash, nextRefCount);
        } else {
          projectedPromptBlobRefs.refCounts.delete(promptBlobHash);
          const blobFile = existingPromptBlobFilesByHash.get(promptBlobHash);
          if (
            blobFile &&
            isPromptBlobArtifactRemovable(
              blobFile,
              projectedPromptBlobRefs.refCounts,
              promptBlobOrphanCutoffMs,
              tempStaleCutoffMs,
            )
          ) {
            const deletedBytes = await removePromptBlobFileForBudget({
              file: blobFile,
              projectedPromptBlobRefCounts: projectedPromptBlobRefs.refCounts,
              promptBlobCutoffMs: promptBlobOrphanCutoffMs,
              tempCutoffMs: tempStaleCutoffMs,
              dryRun,
              fileSizesByPath,
              simulatedRemovedPaths,
              onRemovedPath: params.onRemoveFile,
            });
            if (deletedBytes > 0) {
              total -= deletedBytes;
              freedBytes += deletedBytes;
              removedFiles += 1;
            }
          }
        }
      }
      removedEntries += 1;

      const sessionId = entry.sessionId;
      if (!sessionId) {
        continue;
      }
      const nextRefCount = (sessionIdRefCounts.get(sessionId) ?? 1) - 1;
      if (nextRefCount > 0) {
        sessionIdRefCounts.set(sessionId, nextRefCount);
        continue;
      }
      sessionIdRefCounts.delete(sessionId);
      for (const artifactPath of resolveSessionArtifactPathsForEntry({ sessionsDir, entry })) {
        const deletedBytes = await removeFileForBudget({
          filePath: artifactPath,
          dryRun,
          fileSizesByPath,
          simulatedRemovedPaths,
          onRemovedPath: params.onRemoveFile,
        });
        if (deletedBytes <= 0) {
          continue;
        }
        total -= deletedBytes;
        freedBytes += deletedBytes;
        removedFiles += 1;
      }
    }
  }

  if (!dryRun) {
    if (total > highWaterBytes) {
      log.warn("session disk budget still above high-water target after cleanup", {
        sessionsDir,
        totalBytes: total,
        maxBytes,
        highWaterBytes,
        removedFiles,
        removedEntries,
      });
    } else if (removedFiles > 0 || removedEntries > 0) {
      log.info("applied session disk budget cleanup", {
        sessionsDir,
        totalBytesBefore: totalBefore,
        totalBytesAfter: total,
        maxBytes,
        highWaterBytes,
        removedFiles,
        removedEntries,
      });
    }
  }

  return {
    totalBytesBefore: totalBefore,
    totalBytesAfter: total,
    removedFiles,
    removedEntries,
    freedBytes,
    maxBytes,
    highWaterBytes,
    overBudget: true,
  };
}
