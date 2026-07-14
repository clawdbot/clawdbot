// Filesystem session transcript helpers.
// Resolves, archives, and cleans up transcript files owned by Gateway sessions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import {
  formatSessionArchiveTimestamp,
  parseSessionArchiveTimestamp,
  type SessionArchiveReason,
} from "../config/sessions/artifacts.js";
import { extractGeneratedTranscriptSessionId } from "../config/sessions/generated-transcript-session-id.js";
import {
  resolveSessionFilePath,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
} from "../config/sessions/paths.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";

type ArchiveFileReason = SessionArchiveReason;
type ResetArchiveCandidate = { archivePath: string; name: string; timestamp: number };
export type ArchivedSessionTranscript = {
  sourcePath: string;
  archivedPath: string;
};

const MAX_RESET_ARCHIVE_DISCOVERY_CACHE_ENTRIES = 2048;
const MAX_RESET_ARCHIVE_HEADER_MATCH_CACHE_ENTRIES = 4096;
const MAX_RESET_ARCHIVE_CANDIDATES_PER_TRANSCRIPT = 128;

const resetArchiveDiscoveryCache = new Map<
  string,
  {
    dirMtimeMs: number;
    dirSize: number;
    archives: ResetArchiveCandidate[];
  }
>();
const resetArchiveHeaderMatchCache = new Map<
  string,
  {
    mtimeMs: number;
    size: number;
    matches: boolean;
  }
>();

function clearSessionTranscriptResetArchiveDiscoveryCache(): void {
  resetArchiveDiscoveryCache.clear();
  resetArchiveHeaderMatchCache.clear();
}

function deleteResetArchiveHeaderMatchesForArchives(archives: ResetArchiveCandidate[]): void {
  if (archives.length === 0 || resetArchiveHeaderMatchCache.size === 0) {
    return;
  }
  const archivePaths = new Set(archives.map((archive) => archive.archivePath));
  for (const cacheKey of resetArchiveHeaderMatchCache.keys()) {
    const archivePath = cacheKey.slice(cacheKey.indexOf("\0") + 1);
    if (archivePaths.has(archivePath)) {
      resetArchiveHeaderMatchCache.delete(cacheKey);
    }
  }
}

function setResetArchiveDiscoveryCacheEntry(
  cacheKey: string,
  entry: { dirMtimeMs: number; dirSize: number; archives: ResetArchiveCandidate[] },
): void {
  resetArchiveDiscoveryCache.set(cacheKey, entry);
  while (resetArchiveDiscoveryCache.size > MAX_RESET_ARCHIVE_DISCOVERY_CACHE_ENTRIES) {
    const oldestKey = resetArchiveDiscoveryCache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    const oldestEntry = resetArchiveDiscoveryCache.get(oldestKey);
    if (oldestEntry) {
      deleteResetArchiveHeaderMatchesForArchives(oldestEntry.archives);
    }
    resetArchiveDiscoveryCache.delete(oldestKey);
  }
}

function setResetArchiveHeaderMatchCacheEntry(
  cacheKey: string,
  entry: { mtimeMs: number; size: number; matches: boolean },
): void {
  resetArchiveHeaderMatchCache.set(cacheKey, entry);
  while (resetArchiveHeaderMatchCache.size > MAX_RESET_ARCHIVE_HEADER_MATCH_CACHE_ENTRIES) {
    const oldestKey = resetArchiveHeaderMatchCache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    resetArchiveHeaderMatchCache.delete(oldestKey);
  }
}

function classifySessionTranscriptCandidate(
  sessionId: string,
  sessionFile?: string,
): "current" | "stale" | "custom" {
  const transcriptSessionId = extractGeneratedTranscriptSessionId(sessionFile);
  if (!transcriptSessionId) {
    return "custom";
  }
  return transcriptSessionId === sessionId ? "current" : "stale";
}

function canonicalizePathForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function resolveSessionTranscriptCandidates(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string[] {
  const candidates: string[] = [];
  const sessionFileState = classifySessionTranscriptCandidate(sessionId, sessionFile);
  const pushCandidate = (resolve: () => string): void => {
    try {
      candidates.push(resolve());
    } catch {
      // Ignore invalid paths/IDs and keep scanning other safe candidates.
    }
  };

  if (storePath) {
    const sessionsDir = path.dirname(storePath);
    if (sessionFile && sessionFileState !== "stale") {
      pushCandidate(() =>
        resolveSessionFilePath(sessionId, { sessionFile }, { sessionsDir, agentId }),
      );
    }
    pushCandidate(() => resolveSessionTranscriptPathInDir(sessionId, sessionsDir));
    if (sessionFile && sessionFileState === "stale") {
      pushCandidate(() =>
        resolveSessionFilePath(sessionId, { sessionFile }, { sessionsDir, agentId }),
      );
    }
  } else if (sessionFile) {
    if (agentId) {
      if (sessionFileState !== "stale") {
        pushCandidate(() => resolveSessionFilePath(sessionId, { sessionFile }, { agentId }));
      }
    } else {
      const trimmed = sessionFile.trim();
      if (trimmed) {
        candidates.push(path.resolve(trimmed));
      }
    }
  }

  if (agentId) {
    pushCandidate(() => resolveSessionTranscriptPath(sessionId, agentId));
    if (sessionFile && sessionFileState === "stale") {
      pushCandidate(() => resolveSessionFilePath(sessionId, { sessionFile }, { agentId }));
    }
  }

  // Keep the legacy global sessions directory as a final candidate so tagged
  // upgrades can still find transcripts created before per-agent paths.
  const home = resolveRequiredHomeDir(process.env, os.homedir);
  const legacyDir = path.join(home, ".openclaw", "sessions");
  pushCandidate(() => resolveSessionTranscriptPathInDir(sessionId, legacyDir));

  return uniqueStrings(candidates);
}

async function resetArchiveHeaderMatchesSessionId(
  sessionId: string,
  archivePath: string,
): Promise<boolean> {
  // Compressed archives must be probed through the materialized JSONL cache:
  // a raw prefix read of zstd bytes never matches a session header, which
  // would silently drop every compressed archive from fallback history.
  let probePath: string;
  try {
    probePath = materializeSessionArchiveForRead(archivePath);
  } catch {
    return false;
  }
  const stat = await fs.promises.stat(probePath).catch(() => null);
  if (!stat?.isFile()) {
    return false;
  }
  const cacheKey = `${sessionId}\0${archivePath}`;
  const cached = resetArchiveHeaderMatchCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    resetArchiveHeaderMatchCache.delete(cacheKey);
    resetArchiveHeaderMatchCache.set(cacheKey, cached);
    return cached.matches;
  }

  let matches = false;
  const handle = await fs.promises.open(probePath, "r").catch(() => null);
  if (!handle) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.toString("utf-8", 0, bytesRead).split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const record = JSON.parse(trimmed) as unknown;
      matches =
        Boolean(record) &&
        typeof record === "object" &&
        !Array.isArray(record) &&
        (record as { type?: unknown; id?: unknown }).type === "session" &&
        (record as { type?: unknown; id?: unknown }).id === sessionId;
      return matches;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
    setResetArchiveHeaderMatchCacheEntry(cacheKey, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      matches,
    });
  }
}

async function listResetArchiveCandidatesForTranscriptAsync(
  transcriptPath: string,
): Promise<ResetArchiveCandidate[] | undefined> {
  const base = path.basename(transcriptPath);
  if (!base.endsWith(".jsonl")) {
    return undefined;
  }
  const dir = path.dirname(transcriptPath);
  const dirStat = await fs.promises.stat(dir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    return undefined;
  }
  const cacheKey = `${dir}\0${base}`;
  const cached = resetArchiveDiscoveryCache.get(cacheKey);
  if (cached && cached.dirMtimeMs === dirStat.mtimeMs && cached.dirSize === dirStat.size) {
    resetArchiveDiscoveryCache.delete(cacheKey);
    resetArchiveDiscoveryCache.set(cacheKey, cached);
    return cached.archives;
  }

  const archives: ResetArchiveCandidate[] = [];
  try {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(`${base}.reset.`)) {
        continue;
      }
      const timestamp = parseSessionArchiveTimestamp(entry.name, "reset");
      if (timestamp == null) {
        continue;
      }
      archives.push({ archivePath: path.join(dir, entry.name), name: entry.name, timestamp });
    }
  } catch {
    return undefined;
  }
  archives.sort(
    (left, right) => right.timestamp - left.timestamp || right.name.localeCompare(left.name),
  );
  const boundedArchives = archives.slice(0, MAX_RESET_ARCHIVE_CANDIDATES_PER_TRANSCRIPT);
  setResetArchiveDiscoveryCacheEntry(cacheKey, {
    dirMtimeMs: dirStat.mtimeMs,
    dirSize: dirStat.size,
    archives: boundedArchives,
  });
  return boundedArchives;
}

async function resolveLatestResetArchiveForTranscriptAsync(
  sessionId: string,
  transcriptPath: string,
  opts?: { requireSessionHeader?: boolean },
): Promise<ResetArchiveCandidate | undefined> {
  const archives = await listResetArchiveCandidatesForTranscriptAsync(transcriptPath);
  if (!archives) {
    return undefined;
  }
  if (opts?.requireSessionHeader !== true) {
    return archives[0];
  }
  for (const archive of archives) {
    if (await resetArchiveHeaderMatchesSessionId(sessionId, archive.archivePath)) {
      return archive;
    }
  }
  return undefined;
}

function transcriptArchiveIdentity(
  sessionId: string,
  transcriptPath: string,
): { key: string; requireSessionHeader: boolean } | undefined {
  const generatedSessionId = extractGeneratedTranscriptSessionId(transcriptPath);
  return {
    key: path.basename(transcriptPath),
    requireSessionHeader: !generatedSessionId || generatedSessionId !== sessionId,
  };
}

export async function resolveSessionTranscriptResetArchiveCandidatesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): Promise<string[]> {
  const candidatesByIdentity = new Map<
    string,
    Array<{ path: string; requireSessionHeader: boolean }>
  >();
  for (const candidate of resolveSessionTranscriptCandidates(
    sessionId,
    storePath,
    sessionFile,
    agentId,
  )) {
    const identity = transcriptArchiveIdentity(sessionId, candidate);
    if (!identity) {
      continue;
    }
    candidatesByIdentity.set(identity.key, [
      ...(candidatesByIdentity.get(identity.key) ?? []),
      { path: candidate, requireSessionHeader: identity.requireSessionHeader },
    ]);
  }
  const archives = (
    await Promise.all(
      Array.from(candidatesByIdentity.values(), (candidates) =>
        Promise.all(
          candidates.map((candidate) =>
            resolveLatestResetArchiveForTranscriptAsync(sessionId, candidate.path, {
              requireSessionHeader: candidate.requireSessionHeader,
            }),
          ),
        ),
      ),
    )
  ).flatMap((identityArchives) =>
    identityArchives
      .flatMap((archive) => (archive ? [archive] : []))
      .toSorted(
        (left, right) => right.timestamp - left.timestamp || right.name.localeCompare(left.name),
      )
      .slice(0, 1),
  );
  return uniqueStrings(archives.map((archive) => archive.archivePath));
}

function archiveFileOnDisk(filePath: string, reason: ArchiveFileReason): string {
  const ts = formatSessionArchiveTimestamp();
  const archived = `${filePath}.${reason}.${ts}`;
  fs.renameSync(filePath, archived);
  clearSessionTranscriptResetArchiveDiscoveryCache();
  // Notify the session transcript subscribers (memory index, sessions-history
  // HTTP, etc.) that a mutation landed on a session-owned path. Without this
  // emit the memory sync's incremental path never learns the new archive
  // exists: chokidar does not watch the sessions directory, and the event bus
  // is the only channel gateway code uses to signal session-file mutations.
  // All other in-process mutations (append, compaction, tool-result rewrite,
  // chat inject, command execution) already emit here; archive was the sole
  // remaining gap, which is why `.jsonl.reset.<iso>` / `.jsonl.deleted.<iso>`
  // files only surfaced in the index after a full reindex.
  emitSessionTranscriptUpdate({ sessionFile: archived });
  return archived;
}

export function archiveSessionTranscriptPaths(opts: {
  paths: Iterable<string>;
  reason: ArchiveFileReason;
  onArchiveError?: (err: unknown, sourcePath: string) => void;
}): ArchivedSessionTranscript[] {
  const archived: ArchivedSessionTranscript[] = [];
  const paths = uniqueStrings(
    Array.from(opts.paths, (candidate) => canonicalizePathForComparison(candidate)),
  );
  for (const sourcePath of paths) {
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    try {
      archived.push({
        sourcePath,
        archivedPath: archiveFileOnDisk(sourcePath, opts.reason),
      });
    } catch (err) {
      opts.onArchiveError?.(err, sourcePath);
    }
  }
  return archived;
}

export function archiveSessionTranscripts(opts: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
  /**
   * When true, only archive files resolved under the session store directory.
   * This prevents maintenance operations from mutating paths outside the agent sessions dir.
   */
  restrictToStoreDir?: boolean;
  onArchiveError?: (err: unknown, sourcePath: string) => void;
}): string[] {
  return archiveSessionTranscriptsDetailed(opts).map((entry) => entry.archivedPath);
}

export function archiveSessionTranscriptsDetailed(opts: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
  /**
   * When true, only archive files resolved under the session store directory.
   * This prevents maintenance operations from mutating paths outside the agent sessions dir.
   */
  restrictToStoreDir?: boolean;
  /**
   * Invoked when an individual transcript candidate fails to archive. The
   * caller decides whether to log, warn-deliver, or escalate.
   */
  onArchiveError?: (err: unknown, sourcePath: string) => void;
}): ArchivedSessionTranscript[] {
  const candidatePaths: string[] = [];
  const storeDir =
    opts.restrictToStoreDir && opts.storePath
      ? canonicalizePathForComparison(path.dirname(opts.storePath))
      : null;
  for (const candidate of resolveSessionTranscriptCandidates(
    opts.sessionId,
    opts.storePath,
    opts.sessionFile,
    opts.agentId,
  )) {
    const candidatePath = canonicalizePathForComparison(candidate);
    if (storeDir) {
      const relative = path.relative(storeDir, candidatePath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
    }
    candidatePaths.push(candidatePath);
  }
  return archiveSessionTranscriptPaths({
    paths: candidatePaths,
    reason: opts.reason,
    onArchiveError: opts.onArchiveError,
  });
}

export function resolveStableSessionEndTranscript(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  archivedTranscripts?: ArchivedSessionTranscript[];
}): { sessionFile?: string; transcriptArchived?: boolean } {
  const archivedTranscripts = params.archivedTranscripts ?? [];
  if (archivedTranscripts.length > 0) {
    const preferredPath = params.sessionFile?.trim()
      ? canonicalizePathForComparison(params.sessionFile)
      : undefined;
    const archivedMatch =
      preferredPath == null
        ? undefined
        : archivedTranscripts.find(
            (entry) => canonicalizePathForComparison(entry.sourcePath) === preferredPath,
          );
    const archivedPath = archivedMatch?.archivedPath ?? archivedTranscripts[0]?.archivedPath;
    if (archivedPath) {
      return { sessionFile: archivedPath, transcriptArchived: true };
    }
  }

  for (const candidate of resolveSessionTranscriptCandidates(
    params.sessionId,
    params.storePath,
    params.sessionFile,
    params.agentId,
  )) {
    const candidatePath = canonicalizePathForComparison(candidate);
    if (fs.existsSync(candidatePath)) {
      return { sessionFile: candidatePath, transcriptArchived: false };
    }
  }

  return {};
}

type SessionArchiveCleanupRule = {
  reason: ArchiveFileReason;
  olderThanMs: number;
};

// Store maintenance runs this on every session-store save. All retention rules
// share one directory listing: a listing per reason would multiply READDIR
// load on the per-save hot path, which is expensive on networked filesystems.
export async function cleanupArchivedSessionTranscripts(opts: {
  directories: string[];
  rules: SessionArchiveCleanupRule[];
  nowMs?: number;
}): Promise<{ removed: number; scanned: number }> {
  const rules = opts.rules.filter(
    (rule) => Number.isFinite(rule.olderThanMs) && rule.olderThanMs >= 0,
  );
  if (rules.length === 0) {
    return { removed: 0, scanned: 0 };
  }
  const now = opts.nowMs ?? Date.now();
  const directories = uniqueStrings(opts.directories.map((dir) => path.resolve(dir)));
  let removed = 0;
  let scanned = 0;

  for (const dir of directories) {
    const entries = await fs.promises.readdir(dir).catch(() => []);
    for (const entry of entries) {
      for (const rule of rules) {
        const timestamp = parseSessionArchiveTimestamp(entry, rule.reason);
        if (timestamp == null) {
          continue;
        }
        scanned += 1;
        if (now - timestamp > rule.olderThanMs) {
          const fullPath = path.join(dir, entry);
          const stat = await fs.promises.stat(fullPath).catch(() => null);
          if (stat?.isFile()) {
            await fs.promises.rm(fullPath).catch(() => undefined);
            removed += 1;
          }
        }
        // An archive name carries exactly one `.{reason}.{timestamp}` suffix,
        // so the first matching rule owns the entry.
        break;
      }
    }
  }

  return { removed, scanned };
}
