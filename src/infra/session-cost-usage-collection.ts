import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import {
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseSessionArchiveTimestamp,
  parseUsageCountedSessionIdFromFileName,
} from "../config/sessions/artifacts.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import {
  resolveSessionFilePathCore,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import {
  listSessionTranscriptArchivesReadOnly,
  listSessionTranscriptInstances,
  loadSessionEntry,
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import { selectVisibleTranscriptEvents } from "../config/sessions/transcript-visible-events.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";

export const USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY = 32;

export type UsageCostTranscriptFile = {
  filePath: string;
  /** Durable identity when filePath is a transient archive materialization. */
  sourcePath: string;
  kind: "jsonl" | "sqlite";
  size: number;
  mtimeMs: number;
  sessionId?: string;
  device?: number;
  inode?: number;
  eventCount?: number;
  maxSeq?: number;
};

function resolveUsageCostSessionStorePath(params: {
  agentId: string;
  sessionsDir?: string;
  storePath?: string;
}): string {
  return (
    params.storePath ??
    (params.sessionsDir
      ? path.join(params.sessionsDir, "sessions.json")
      : resolveSessionStorePathForScope({ agentId: params.agentId }))
  );
}

async function resolveUsageCostJsonlFile(
  sourcePath: string,
  sourceStats: fs.Stats,
): Promise<UsageCostTranscriptFile> {
  // Identity and freshness belong to the source; incremental offsets and
  // byte signatures must describe the decompressed file used by readers.
  const filePath = materializeSessionArchiveForRead(sourcePath);
  const stats = filePath === sourcePath ? sourceStats : await fs.promises.stat(filePath);
  return {
    filePath,
    sourcePath,
    kind: "jsonl",
    sessionId: parseUsageCountedSessionIdFromFileName(path.basename(sourcePath)) ?? undefined,
    size: stats.size,
    mtimeMs: sourceStats.mtimeMs,
    device: stats.dev,
    inode: stats.ino,
  };
}

async function listUsageCountedTranscriptFileStats(
  agentId: string,
  params?: {
    minMtimeMs?: number;
    sessionsDir?: string;
  },
): Promise<UsageCostTranscriptFile[]> {
  const sessionsDir = params?.sessionsDir ?? resolveSessionTranscriptsDirForAgent(agentId);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const tasks = entries
    .filter((entry) => entry.isFile() && isUsageCountedSessionTranscriptFileName(entry.name))
    .map((entry) => async (): Promise<UsageCostTranscriptFile | undefined> => {
      const filePath = path.join(sessionsDir, entry.name);
      try {
        const stats = await fs.promises.stat(filePath);
        if (params?.minMtimeMs !== undefined && stats.mtimeMs < params.minMtimeMs) {
          return undefined;
        }
        return await resolveUsageCostJsonlFile(filePath, stats);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    });
  const { firstError, hasError, results } = await runTasksWithConcurrency({
    tasks,
    limit: USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
  });
  if (hasError) {
    throw firstError;
  }
  return results.filter((file): file is UsageCostTranscriptFile => Boolean(file));
}

function listUsageCountedSqliteTranscriptStats(
  agentId: string,
  params: { minMtimeMs?: number; storePath: string },
): UsageCostTranscriptFile[] {
  const storePath = params.storePath;
  const files: UsageCostTranscriptFile[] = [];
  // Usage needs transcript identity/timestamps, not saved prompt snapshots.
  const instances = listSessionTranscriptInstances({ agentId, storePath, projection: "list" });
  for (const instance of instances) {
    const marker = { agentId, sessionId: instance.sessionId, storePath };
    const mtimeMs = instance.updatedAtMs;
    if (params.minMtimeMs !== undefined && mtimeMs < params.minMtimeMs) {
      continue;
    }
    // Usage scans run across every session on hot paths; byte sizes come from
    // a SQL aggregate so no transcript row is materialized (#86718 class).
    const stats = readTranscriptStatsSync({
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      storePath: marker.storePath,
    });
    const filePath = formatCanonicalUsageCostSqliteMarker(marker);
    files.push({
      filePath,
      sourcePath: filePath,
      kind: "sqlite",
      mtimeMs,
      sessionId: marker.sessionId,
      size: stats.sizeBytes,
      eventCount: stats.eventCount,
      maxSeq: stats.maxSeq,
    });
  }
  return files;
}

function formatCanonicalUsageCostSqliteMarker(marker: SqliteSessionFileMarker): string {
  const storePath =
    resolveSqliteTargetFromSessionStorePath(marker.storePath, { agentId: marker.agentId }).path ??
    resolveOpenClawAgentSqlitePath({ agentId: marker.agentId });
  return formatSqliteSessionFileMarker({ ...marker, storePath });
}

export async function listUsageCountedTranscriptStats(
  agentId: string,
  params?: { minMtimeMs?: number; sessionsDir?: string; storePath?: string },
): Promise<UsageCostTranscriptFile[]> {
  const storePath = resolveUsageCostSessionStorePath({
    agentId,
    ...(params?.sessionsDir ? { sessionsDir: params.sessionsDir } : {}),
    ...(params?.storePath ? { storePath: params.storePath } : {}),
  });
  const sessionsDir = params?.sessionsDir ?? path.dirname(storePath);
  const fileBacked = await listUsageCountedTranscriptFileStats(agentId, {
    ...(params?.minMtimeMs !== undefined ? { minMtimeMs: params.minMtimeMs } : {}),
    sessionsDir,
  });
  const archiveSessionIds = new Map(
    listSessionTranscriptArchivesReadOnly({
      agentId,
      archiveNames: fileBacked.map((file) => path.basename(file.sourcePath)),
      storePath,
    }).map((archive) => [archive.archiveName, archive.sessionId]),
  );
  for (const file of fileBacked) {
    const sessionId = archiveSessionIds.get(path.basename(file.sourcePath));
    if (sessionId) {
      file.sessionId = sessionId;
    }
  }
  const sqliteBacked = listUsageCountedSqliteTranscriptStats(agentId, {
    ...(params?.minMtimeMs !== undefined ? { minMtimeMs: params.minMtimeMs } : {}),
    storePath,
  });
  const sqliteSessionIds = new Set(sqliteBacked.map((file) => file.sessionId).filter(Boolean));
  const canonicalFileBacked = fileBacked.filter(
    (file) => !file.sessionId || !sqliteSessionIds.has(file.sessionId),
  );
  return [...canonicalFileBacked, ...sqliteBacked];
}

export async function resolveUsageCostTranscriptFile(
  sessionFile: string,
): Promise<UsageCostTranscriptFile | undefined> {
  const marker = parseSqliteSessionFileMarker(sessionFile);
  if (marker) {
    const stats = readTranscriptStatsSync({
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      storePath: marker.storePath,
    });
    const filePath = formatCanonicalUsageCostSqliteMarker(marker);
    return {
      filePath,
      sourcePath: filePath,
      kind: "sqlite",
      mtimeMs: stats.lastMutationAtMs ?? 0,
      sessionId: marker.sessionId,
      size: stats.sizeBytes,
      eventCount: stats.eventCount,
      maxSeq: stats.maxSeq,
    };
  }
  try {
    const stats = await fs.promises.stat(sessionFile);
    return await resolveUsageCostJsonlFile(sessionFile, stats);
  } catch {
    return undefined;
  }
}

function loadSqliteUsageTranscriptEvents(
  marker: SqliteSessionFileMarker,
): Record<string, unknown>[] {
  return selectVisibleTranscriptEvents(
    loadTranscriptEventsSync({
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      storePath: marker.storePath,
    }),
  ).filter(isRecord);
}

export async function* readTranscriptRecords(
  filePath: string,
): AsyncGenerator<Record<string, unknown>> {
  const marker = parseSqliteSessionFileMarker(filePath);
  if (marker) {
    for (const event of loadSqliteUsageTranscriptEvents(marker)) {
      yield event;
    }
    return;
  }
  // Durable byte-offset scans own their checkpoint reader. Diagnostic history
  // shares the canonical transcript stream and materializes archive bytes once.
  const transcriptPath = materializeSessionArchiveForRead(filePath);
  for await (const line of streamSessionTranscriptLines(transcriptPath)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) {
        yield parsed;
      }
    } catch {
      // Historical transcripts can contain malformed records.
    }
  }
}

export async function* readTranscriptRecordsBestEffort(
  filePath: string,
): AsyncGenerator<Record<string, unknown>> {
  try {
    yield* readTranscriptRecords(filePath);
  } catch {
    // Diagnostic readers return the records available before a stream failure.
    // Durable cache scans use the strict reader so partial data is never marked fresh.
  }
}

export function resolveExistingUsageSessionFile(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  agentId: string;
  sessionTarget?: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };
}): string | undefined {
  const sessionId = normalizeOptionalString(params.sessionId);
  const target = params.sessionTarget
    ? {
        agentId: normalizeOptionalString(params.sessionTarget.agentId),
        sessionId: normalizeOptionalString(params.sessionTarget.sessionId),
        sessionKey: normalizeOptionalString(params.sessionTarget.sessionKey),
        storePath: normalizeOptionalString(params.sessionTarget.storePath),
      }
    : undefined;
  const completeTarget = Boolean(
    target?.agentId && target.sessionId && target.sessionKey && target.storePath,
  );
  if (target && completeTarget) {
    const targetKeyAgentId = parseAgentSessionKey(target.sessionKey)?.agentId;
    const targetKeyEntry = loadSessionEntry({
      agentId: target.agentId!,
      sessionKey: target.sessionKey!,
      storePath: target.storePath!,
    });
    // Complete targets remain authoritative after metadata cleanup; reject
    // only an existing key row that proves the identity is stale.
    if (
      (sessionId !== undefined && target.sessionId !== sessionId) ||
      target.agentId !== params.agentId ||
      (targetKeyAgentId && targetKeyAgentId !== target.agentId) ||
      (targetKeyEntry && targetKeyEntry.sessionId !== target.sessionId)
    ) {
      return undefined;
    }
    return formatCanonicalUsageCostSqliteMarker({
      agentId: target.agentId!,
      sessionId: target.sessionId!,
      storePath: target.storePath!,
    });
  }
  const legacySessionFile = (params.sessionEntry as { sessionFile?: unknown } | undefined)
    ?.sessionFile;
  const entryMarker = parseSqliteSessionFileMarker(
    typeof legacySessionFile === "string" ? legacySessionFile : undefined,
  );
  const explicitMarker = parseSqliteSessionFileMarker(params.sessionFile);
  const matchingEntryMarker =
    entryMarker &&
    entryMarker.agentId === params.agentId &&
    (!sessionId || entryMarker.sessionId === sessionId)
      ? entryMarker
      : undefined;
  const matchingExplicitMarker =
    explicitMarker &&
    explicitMarker.agentId === params.agentId &&
    (!sessionId || explicitMarker.sessionId === sessionId)
      ? explicitMarker
      : undefined;
  if (!matchingEntryMarker && explicitMarker && !matchingExplicitMarker) {
    return undefined;
  }
  const sqliteMarker = matchingEntryMarker ?? matchingExplicitMarker;
  const targetKeyAgentId = parseAgentSessionKey(target?.sessionKey)?.agentId;
  const targetKeyEntry =
    target?.sessionKey && sqliteMarker && !completeTarget
      ? loadSessionEntry({
          agentId: sqliteMarker.agentId,
          sessionKey: target.sessionKey,
          storePath: sqliteMarker.storePath,
        })
      : undefined;
  if (
    target &&
    !completeTarget &&
    sqliteMarker &&
    ((target.agentId && target.agentId !== sqliteMarker.agentId) ||
      (target.sessionId && target.sessionId !== sqliteMarker.sessionId) ||
      (targetKeyAgentId && targetKeyAgentId !== sqliteMarker.agentId) ||
      (target.sessionKey && targetKeyEntry?.sessionId !== sqliteMarker.sessionId) ||
      (target.storePath && path.resolve(target.storePath) !== path.resolve(sqliteMarker.storePath)))
  ) {
    return undefined;
  }
  if (sqliteMarker) {
    return formatSqliteSessionFileMarker(sqliteMarker);
  }
  // An explicit JSONL artifact remains a supported read boundary, but a stale
  // entry marker alone must not redirect the requested session.
  if (entryMarker && !params.sessionFile) {
    return undefined;
  }

  const candidate =
    params.sessionFile ??
    (sessionId
      ? resolveSessionFilePathCore(sessionId, params.sessionEntry, {
          agentId: params.agentId,
        })
      : undefined);

  if (candidate && fs.existsSync(candidate)) {
    return candidate;
  }
  if (!sessionId) {
    return candidate;
  }

  try {
    const sessionsDir = candidate
      ? path.dirname(candidate)
      : resolveSessionTranscriptsDirForAgent(params.agentId);
    const baseFileName = `${sessionId}.jsonl`;
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => {
      return (
        entry.isFile() &&
        (entry.name === baseFileName ||
          entry.name.startsWith(`${baseFileName}.reset.`) ||
          entry.name.startsWith(`${baseFileName}.deleted.`))
      );
    });

    const primary = entries.find((entry) => entry.name === baseFileName);
    if (primary) {
      return path.join(sessionsDir, primary.name);
    }

    const latestArchive = entries
      .filter((entry) => isSessionArchiveArtifactName(entry.name))
      .map((entry) => entry.name)
      .toSorted((a, b) => {
        const tsA =
          parseSessionArchiveTimestamp(a, "deleted") ??
          parseSessionArchiveTimestamp(a, "reset") ??
          0;
        const tsB =
          parseSessionArchiveTimestamp(b, "deleted") ??
          parseSessionArchiveTimestamp(b, "reset") ??
          0;
        return tsB - tsA || b.localeCompare(a);
      })[0];

    return latestArchive ? path.join(sessionsDir, latestArchive) : candidate;
  } catch {
    return candidate;
  }
}
