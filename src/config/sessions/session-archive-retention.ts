import fs from "node:fs";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { hasErrnoCode } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import {
  parseSessionArchiveSourceFileName,
  parseSessionArchiveTimestamp,
  type SessionArchiveReason,
} from "./artifacts.js";
import { emitSessionTranscriptPathUpdates } from "./session-accessor.sqlite-events.js";

const MAX_RESET_ARCHIVE_DISCOVERY_CACHE_ENTRIES = 2048;
const MAX_RESET_ARCHIVE_CANDIDATES_PER_TRANSCRIPT = 128;

export type SessionResetArchiveCandidate = {
  archivePath: string;
  name: string;
  timestamp: number;
};

const resetArchiveDiscoveryCache = new Map<
  string,
  {
    dirMtimeMs: number;
    dirSize: number;
    archives: SessionResetArchiveCandidate[];
  }
>();

export function clearSessionResetArchiveDiscoveryCache(): void {
  resetArchiveDiscoveryCache.clear();
}

export function readCachedSessionResetArchiveCandidates(params: {
  cacheKey: string;
  dirMtimeMs: number;
  dirSize: number;
}): SessionResetArchiveCandidate[] | undefined {
  const cached = resetArchiveDiscoveryCache.get(params.cacheKey);
  if (!cached || cached.dirMtimeMs !== params.dirMtimeMs || cached.dirSize !== params.dirSize) {
    return undefined;
  }
  resetArchiveDiscoveryCache.delete(params.cacheKey);
  resetArchiveDiscoveryCache.set(params.cacheKey, cached);
  return cached.archives;
}

export function cacheSessionResetArchiveCandidates(params: {
  cacheKey: string;
  dirMtimeMs: number;
  dirSize: number;
  archives: SessionResetArchiveCandidate[];
}): SessionResetArchiveCandidate[] {
  const archives = params.archives.slice(0, MAX_RESET_ARCHIVE_CANDIDATES_PER_TRANSCRIPT);
  resetArchiveDiscoveryCache.set(params.cacheKey, {
    dirMtimeMs: params.dirMtimeMs,
    dirSize: params.dirSize,
    archives,
  });
  pruneMapToMaxSize(resetArchiveDiscoveryCache, MAX_RESET_ARCHIVE_DISCOVERY_CACHE_ENTRIES);
  return archives;
}

type SessionArchivedTranscriptFileCleanupParams = {
  directories: string[];
  rules: Array<{
    reason: SessionArchiveReason;
    olderThanMs: number;
  }>;
  nowMs?: number;
  dryRun?: boolean;
  excludeCanonicalPaths?: ReadonlySet<string>;
  onRemoveFile?: (canonicalPath: string) => void;
};

type SessionArchivedTranscriptFileCleanupResult = {
  removed: number;
  scanned: number;
};

function canonicalizePathForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

async function ignoreMissingArchivePath<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return fallback;
    }
    throw error;
  }
}

function emitArchiveRemoval(sessionFile: string, sourceFile?: string): void {
  emitSessionTranscriptPathUpdates(
    sourceFile && sourceFile !== sessionFile ? [sessionFile, sourceFile] : [sessionFile],
  );
}

// Archive-retention sweeps share one directory listing across all rules. A
// listing per reason would multiply READDIR load on networked filesystems.
export async function cleanupSessionArchivedTranscriptFiles(
  params: SessionArchivedTranscriptFileCleanupParams,
): Promise<SessionArchivedTranscriptFileCleanupResult> {
  const rules = params.rules.filter(
    (rule) => Number.isFinite(rule.olderThanMs) && rule.olderThanMs >= 0,
  );
  if (rules.length === 0) {
    return { removed: 0, scanned: 0 };
  }
  const now = params.nowMs ?? Date.now();
  const directories = uniqueStrings(params.directories.map((dir) => path.resolve(dir)));
  let removed = 0;
  let scanned = 0;

  for (const dir of directories) {
    const entries = await ignoreMissingArchivePath(() => fs.promises.readdir(dir), []);
    for (const entry of entries) {
      for (const rule of rules) {
        const timestamp = parseSessionArchiveTimestamp(entry, rule.reason);
        if (timestamp == null) {
          continue;
        }
        const fullPath = path.join(dir, entry);
        const sourceFileName = parseSessionArchiveSourceFileName(entry, rule.reason);
        if (params.excludeCanonicalPaths?.has(canonicalizePathForComparison(fullPath))) {
          break;
        }
        scanned += 1;
        if (now - timestamp > rule.olderThanMs) {
          const stat = await ignoreMissingArchivePath(() => fs.promises.stat(fullPath), null);
          if (stat?.isFile()) {
            if (params.dryRun) {
              params.onRemoveFile?.(canonicalizePathForComparison(fullPath));
              removed += 1;
            } else {
              const removedFile = await ignoreMissingArchivePath(async () => {
                await fs.promises.rm(fullPath);
                return true;
              }, false);
              if (removedFile) {
                clearSessionResetArchiveDiscoveryCache();
                emitArchiveRemoval(
                  fullPath,
                  sourceFileName ? path.join(dir, sourceFileName) : undefined,
                );
                params.onRemoveFile?.(canonicalizePathForComparison(fullPath));
                removed += 1;
              }
            }
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
