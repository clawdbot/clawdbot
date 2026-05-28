import fs from "node:fs";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
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
import { projectSessionStoreForPersistence } from "./skill-prompt-blobs.js";
import { shouldPreserveMaintenanceEntry } from "./store-maintenance.js";
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

function canonicalizePathForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function measureStoreBytes(store: Record<string, SessionEntry>): number {
  return Buffer.byteLength(JSON.stringify(store, null, 2), "utf-8");
}

function measureStoreEntryChunkBytes(key: string, entry: SessionEntry): number {
  const singleEntryStore = JSON.stringify({ [key]: entry }, null, 2);
  if (!singleEntryStore.startsWith("{\n") || !singleEntryStore.endsWith("\n}")) {
    return measureStoreBytes({ [key]: entry }) - 4;
  }
  const chunk = singleEntryStore.slice(2, -2);
  return Buffer.byteLength(chunk, "utf-8");
}

function buildStoreEntryChunkSizeMap(store: Record<string, SessionEntry>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, entry] of Object.entries(store)) {
    out.set(key, measureStoreEntryChunkBytes(key, entry));
  }
  return out;
}

function resolveProjectedPromptBlobHash(entry: SessionEntry | undefined): string | undefined {
  const ref = entry?.skillsSnapshot?.promptRef;
  return ref?.algorithm === "sha256" && typeof ref.hash === "string" ? ref.hash : undefined;
}

function buildProjectedPromptBlobRefCounts(
  store: Record<string, SessionEntry>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of Object.values(store)) {
    const hash = resolveProjectedPromptBlobHash(entry);
    if (!hash) {
      continue;
    }
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  return counts;
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
  const projectedPromptBlobRefCounts = buildProjectedPromptBlobRefCounts(
    projectSessionStoreForPersistence({
      storePath: params.storePath,
      store: params.store,
    }).store,
  );
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
      projectedPromptBlobRefCounts,
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
            projectedPromptBlobRefCounts,
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
  const fileSizesByPath = new Map(
    [...files, ...promptBlobFiles].map((file) => [file.canonicalPath, file.size]),
  );
  const simulatedRemovedPaths = new Set<string>();
  const resolvedStorePath = canonicalizePathForComparison(params.storePath);
  const storeFile = files.find((file) => file.canonicalPath === resolvedStorePath);
  const projectedPersistence = projectSessionStoreForPersistence({
    storePath: params.storePath,
    store: params.store,
  });
  const projectedStore = projectedPersistence.store;
  let projectedStoreBytes = measureStoreBytes(projectedStore);
  const projectedPromptBlobBytesByHash = new Map<string, number>();
  const existingPromptBlobFilesByHash = new Map<string, SessionsDirFileStat>();
  for (const file of promptBlobFiles) {
    const hash = resolvePromptBlobFileHash(file);
    if (hash) {
      existingPromptBlobFilesByHash.set(hash, file);
    }
  }
  for (const [hash, blob] of projectedPersistence.promptBlobs) {
    if (!existingPromptBlobFilesByHash.has(hash)) {
      projectedPromptBlobBytesByHash.set(hash, blob.ref.bytes);
    }
  }
  const projectedPromptBlobRefCounts = buildProjectedPromptBlobRefCounts(projectedStore);
  const projectedPromptBlobBytes = [...projectedPromptBlobBytesByHash.values()].reduce(
    (sum, bytes) => sum + bytes,
    0,
  );
  let total =
    [...files, ...promptBlobFiles].reduce((sum, file) => sum + file.size, 0) -
    (storeFile?.size ?? 0) +
    projectedStoreBytes +
    projectedPromptBlobBytes;
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
        projectedPromptBlobRefCounts,
        promptBlobOrphanCutoffMs,
        tempStaleCutoffMs,
      );
    })
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of unreferencedPromptBlobQueue) {
    if (total <= highWaterBytes) {
      break;
    }
    const deletedBytes = await removePromptBlobFileForBudget({
      file,
      projectedPromptBlobRefCounts,
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
    const entryChunkBytesByKey = buildStoreEntryChunkSizeMap(projectedStore);
    const keys = Object.keys(params.store).toSorted((a, b) => {
      const aTime = getEntryUpdatedAt(params.store[a]);
      const bTime = getEntryUpdatedAt(params.store[b]);
      return aTime - bTime;
    });
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
      const previousProjectedBytes = projectedStoreBytes;
      const projectedEntry = projectedStore[key];
      const promptBlobHash = resolveProjectedPromptBlobHash(projectedEntry);
      delete params.store[key];
      delete projectedStore[key];
      const chunkBytes = entryChunkBytesByKey.get(key);
      entryChunkBytesByKey.delete(key);
      if (typeof chunkBytes === "number" && Number.isFinite(chunkBytes) && chunkBytes >= 0) {
        // Removing any one pretty-printed top-level entry always removes the entry chunk plus ",\n" (2 bytes).
        projectedStoreBytes = Math.max(2, projectedStoreBytes - (chunkBytes + 2));
      } else {
        projectedStoreBytes = measureStoreBytes(projectedStore);
      }
      total += projectedStoreBytes - previousProjectedBytes;
      if (promptBlobHash) {
        const nextRefCount = (projectedPromptBlobRefCounts.get(promptBlobHash) ?? 1) - 1;
        if (nextRefCount > 0) {
          projectedPromptBlobRefCounts.set(promptBlobHash, nextRefCount);
        } else {
          projectedPromptBlobRefCounts.delete(promptBlobHash);
          const virtualBlobBytes = projectedPromptBlobBytesByHash.get(promptBlobHash) ?? 0;
          if (virtualBlobBytes > 0) {
            total -= virtualBlobBytes;
          } else {
            const blobFile = existingPromptBlobFilesByHash.get(promptBlobHash);
            if (
              blobFile &&
              isPromptBlobArtifactRemovable(
                blobFile,
                projectedPromptBlobRefCounts,
                promptBlobOrphanCutoffMs,
                tempStaleCutoffMs,
              )
            ) {
              const deletedBytes = await removePromptBlobFileForBudget({
                file: blobFile,
                projectedPromptBlobRefCounts,
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
