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
  isTrajectorySessionArtifactName,
} from "./artifacts.js";
import { resolveSessionFilePath } from "./paths.js";
import { isProtectedSessionMaintenanceEntry } from "./store-maintenance.js";
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
      const checkpointFile = checkpoint.preCompaction.sessionFile?.trim();
      if (!checkpointFile) {
        continue;
      }
      const resolvedCheckpointPath = canonicalizePathForComparison(checkpointFile);
      const relative = path.relative(resolvedSessionsDir, resolvedCheckpointPath);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        referenced.add(resolvedCheckpointPath);
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

function isDiskBudgetRemovableSessionFile(
  file: Pick<SessionsDirFileStat, "canonicalPath" | "name">,
  referencedPaths: ReadonlySet<string>,
): boolean {
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
  const fileSizesByPath = new Map(files.map((file) => [file.canonicalPath, file.size]));
  const simulatedRemovedPaths = new Set<string>();
  const referencedPaths = resolveReferencedSessionArtifactPaths({
    sessionsDir,
    store: params.store,
  });
  const cutoffMs = Date.now() - olderThanMs;
  const removableFiles = files
    .filter(
      (file) =>
        !params.excludeCanonicalPaths?.has(file.canonicalPath) &&
        file.mtimeMs <= cutoffMs &&
        isUnreferencedSessionArtifactFile(file, referencedPaths),
    )
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs);

  let removedFiles = 0;
  let freedBytes = 0;
  for (const file of removableFiles) {
    const deletedBytes = await removeFileForBudget({
      filePath: file.path,
      canonicalPath: file.canonicalPath,
      dryRun: params.dryRun === true,
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
    scannedFiles: files.length,
    removedFiles,
    freedBytes,
    olderThanMs,
  };
}

export async function enforceSessionDiskBudget(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  activeSessionKey?: string;
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
  const fileSizesByPath = new Map(files.map((file) => [file.canonicalPath, file.size]));
  const simulatedRemovedPaths = new Set<string>();
  const resolvedStorePath = canonicalizePathForComparison(params.storePath);
  const storeFile = files.find((file) => file.canonicalPath === resolvedStorePath);
  let projectedStoreBytes = measureStoreBytes(params.store);
  let total =
    files.reduce((sum, file) => sum + file.size, 0) - (storeFile?.size ?? 0) + projectedStoreBytes;
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
  const removableFileQueue = files
    .filter((file) => isDiskBudgetRemovableSessionFile(file, referencedPaths))
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
    const entryChunkBytesByKey = buildStoreEntryChunkSizeMap(params.store);
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
      if (isProtectedSessionMaintenanceEntry(key, entry)) {
        continue;
      }
      const previousProjectedBytes = projectedStoreBytes;
      delete params.store[key];
      const chunkBytes = entryChunkBytesByKey.get(key);
      entryChunkBytesByKey.delete(key);
      if (typeof chunkBytes === "number" && Number.isFinite(chunkBytes) && chunkBytes >= 0) {
        // Removing any one pretty-printed top-level entry always removes the entry chunk plus ",\n" (2 bytes).
        projectedStoreBytes = Math.max(2, projectedStoreBytes - (chunkBytes + 2));
      } else {
        projectedStoreBytes = measureStoreBytes(params.store);
      }
      total += projectedStoreBytes - previousProjectedBytes;
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
