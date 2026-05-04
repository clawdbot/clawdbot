import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatSessionArchiveTimestamp,
  parseSessionArchiveTimestamp,
  type SessionArchiveReason,
} from "../config/sessions/artifacts.js";
import {
  resolveSessionFilePath,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
} from "../config/sessions/paths.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";

type ArchiveFileReason = SessionArchiveReason;
export type ArchivedSessionTranscript = {
  sourcePath: string;
  archivedPath: string;
};

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

function extractGeneratedTranscriptSessionId(sessionFile?: string): string | undefined {
  const trimmed = sessionFile?.trim();
  if (!trimmed) {
    return undefined;
  }
  const base = path.basename(trimmed);
  if (!base.endsWith(".jsonl")) {
    return undefined;
  }
  const withoutExt = base.slice(0, -".jsonl".length);
  const topicIndex = withoutExt.indexOf("-topic-");
  if (topicIndex > 0) {
    const topicSessionId = withoutExt.slice(0, topicIndex);
    return looksLikeGeneratedSessionId(topicSessionId) ? topicSessionId : undefined;
  }
  const forkMatch = withoutExt.match(
    /^(\d{4}-\d{2}-\d{2}T[\w-]+(?:Z|[+-]\d{2}(?:-\d{2})?)?)_(.+)$/,
  );
  if (forkMatch?.[2]) {
    return looksLikeGeneratedSessionId(forkMatch[2]) ? forkMatch[2] : undefined;
  }
  return looksLikeGeneratedSessionId(withoutExt) ? withoutExt : undefined;
}

function looksLikeGeneratedSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

  const home = resolveRequiredHomeDir(process.env, os.homedir);
  const legacyDir = path.join(home, ".openclaw", "sessions");
  pushCandidate(() => resolveSessionTranscriptPathInDir(sessionId, legacyDir));

  return Array.from(new Set(candidates));
}

export function archiveFileOnDisk(filePath: string, reason: ArchiveFileReason): string {
  const ts = formatSessionArchiveTimestamp();
  const archived = `${filePath}.${reason}.${ts}`;
  fs.renameSync(filePath, archived);
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
}): ArchivedSessionTranscript[] {
  const archived: ArchivedSessionTranscript[] = [];
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
    if (!fs.existsSync(candidatePath)) {
      continue;
    }
    try {
      archived.push({
        sourcePath: candidatePath,
        archivedPath: archiveFileOnDisk(candidatePath, opts.reason),
      });
    } catch {
      // Best-effort.
    }
  }
  return archived;
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

export async function cleanupArchivedSessionTranscripts(opts: {
  directories: string[];
  olderThanMs: number;
  reason?: ArchiveFileReason;
  nowMs?: number;
}): Promise<{ removed: number; scanned: number }> {
  if (!Number.isFinite(opts.olderThanMs) || opts.olderThanMs < 0) {
    return { removed: 0, scanned: 0 };
  }
  const now = opts.nowMs ?? Date.now();
  const reason: ArchiveFileReason = opts.reason ?? "deleted";
  const directories = Array.from(new Set(opts.directories.map((dir) => path.resolve(dir))));
  let removed = 0;
  let scanned = 0;

  for (const dir of directories) {
    const entries = await fs.promises.readdir(dir).catch(() => []);
    for (const entry of entries) {
      const timestamp = parseSessionArchiveTimestamp(entry, reason);
      if (timestamp == null) {
        continue;
      }
      scanned += 1;
      if (now - timestamp <= opts.olderThanMs) {
        continue;
      }
      const fullPath = path.join(dir, entry);
      const stat = await fs.promises.stat(fullPath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      await fs.promises.rm(fullPath).catch(() => undefined);
      removed += 1;
    }
  }

  return { removed, scanned };
}
