import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  materializeSessionArchiveForRead,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
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
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import {
  listSessionTranscriptInstances,
  loadSessionEntry,
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { selectVisibleTranscriptEvents } from "../config/sessions/transcript-visible-events.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import {
  createUsageCostResolver,
  parseUsageCostTranscriptEntry,
  type UsageCostResolver,
} from "./session-cost-usage-pricing.js";
import type { ParsedUsageEntry } from "./session-cost-usage.types.js";

export const USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY = 32;

export type UsageCostTranscriptFile = {
  filePath: string;
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
}): string {
  return params.sessionsDir
    ? path.join(params.sessionsDir, "sessions.json")
    : resolveDefaultSessionStorePath(params.agentId);
}

async function listUsageCountedTranscriptFileStats(
  agentId: string,
  params?: { minMtimeMs?: number; sessionsDir?: string },
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
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
      if (params?.minMtimeMs !== undefined && stats.mtimeMs < params.minMtimeMs) {
        return undefined;
      }
      // Compressed archives normalize to their materialized plain-JSONL cache
      // at discovery, so every downstream size, incremental offset, and cache
      // signature measures decompressed bytes; mixing offset spaces would
      // truncate or overcount archived usage.
      if (filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
        try {
          const materialized = materializeSessionArchiveForRead(filePath);
          const materializedStats = await fs.promises.stat(materialized);
          return {
            filePath: materialized,
            kind: "jsonl",
            size: materializedStats.size,
            mtimeMs: stats.mtimeMs,
            device: materializedStats.dev,
            inode: materializedStats.ino,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      }
      return {
        filePath,
        kind: "jsonl",
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        device: stats.dev,
        inode: stats.ino,
      };
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
  params?: { minMtimeMs?: number; sessionsDir?: string },
): UsageCostTranscriptFile[] {
  const storePath = resolveUsageCostSessionStorePath({
    agentId,
    ...(params?.sessionsDir ? { sessionsDir: params.sessionsDir } : {}),
  });
  const files: UsageCostTranscriptFile[] = [];
  for (const instance of listSessionTranscriptInstances({ agentId, storePath })) {
    const marker = { agentId, sessionId: instance.sessionId, storePath };
    const mtimeMs = instance.updatedAtMs;
    if (params?.minMtimeMs !== undefined && mtimeMs < params.minMtimeMs) {
      continue;
    }
    // Usage scans run across every session on hot paths; byte sizes come from
    // a SQL aggregate so no transcript row is materialized (#86718 class).
    const stats = readTranscriptStatsSync({
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      storePath: marker.storePath,
    });
    files.push({
      filePath: formatCanonicalUsageCostSqliteMarker(marker),
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

export async function listUsageCountedTranscriptFiles(
  agentId: string,
  params?: { sessionsDir?: string },
): Promise<UsageCostTranscriptFile[]> {
  return await listUsageCountedTranscriptStats(agentId, params);
}

export async function listUsageCountedTranscriptStats(
  agentId: string,
  params?: { minMtimeMs?: number; sessionsDir?: string },
): Promise<UsageCostTranscriptFile[]> {
  const fileBacked = await listUsageCountedTranscriptFileStats(agentId, params);
  const sqliteBacked = listUsageCountedSqliteTranscriptStats(agentId, params);
  const sqliteSessionIds = new Set(sqliteBacked.map((file) => file.sessionId).filter(Boolean));
  const canonicalFileBacked = fileBacked.filter((file) => {
    const sessionId = parseUsageCountedSessionIdFromFileName(path.basename(file.filePath));
    return !sessionId || !sqliteSessionIds.has(sessionId);
  });
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
    return {
      filePath: formatCanonicalUsageCostSqliteMarker(marker),
      kind: "sqlite",
      mtimeMs: stats.lastMutationAtMs ?? 0,
      sessionId: marker.sessionId,
      size: stats.sizeBytes,
      eventCount: stats.eventCount,
      maxSeq: stats.maxSeq,
    };
  }
  if (sessionFile.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    try {
      const archiveStats = await fs.promises.stat(sessionFile);
      const materialized = materializeSessionArchiveForRead(sessionFile);
      const materializedStats = await fs.promises.stat(materialized);
      return {
        filePath: materialized,
        kind: "jsonl",
        size: materializedStats.size,
        mtimeMs: archiveStats.mtimeMs,
        device: materializedStats.dev,
        inode: materializedStats.ino,
      };
    } catch {
      return undefined;
    }
  }
  const stats = await fs.promises.stat(sessionFile).catch(() => null);
  return stats
    ? {
        filePath: sessionFile,
        kind: "jsonl",
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        device: stats.dev,
        inode: stats.ino,
      }
    : undefined;
}

async function* readJsonlRecords(
  filePath: string,
  startOffset = 0,
  endOffset?: number,
): AsyncGenerator<Record<string, unknown>> {
  if (endOffset !== undefined && endOffset <= startOffset) {
    return;
  }
  const streamOptions: Parameters<typeof fs.createReadStream>[1] = {
    encoding: "utf-8",
    start: Math.max(0, startOffset),
  };
  if (endOffset !== undefined) {
    streamOptions.end = endOffset - 1;
  }
  const fileStream = fs.createReadStream(filePath, streamOptions);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object") {
          continue;
        }
        yield parsed as Record<string, unknown>;
      } catch {
        // Ignore malformed lines
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
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
  ).filter(
    (event): event is Record<string, unknown> =>
      Boolean(event) && typeof event === "object" && !Array.isArray(event),
  );
}

export async function* readTranscriptRecords(
  filePath: string,
  startOffset = 0,
  endOffset?: number,
): AsyncGenerator<Record<string, unknown>> {
  const marker = parseSqliteSessionFileMarker(filePath);
  if (marker) {
    for (const event of loadSqliteUsageTranscriptEvents(marker)) {
      yield event;
    }
    return;
  }
  // Discovery normalizes compressed archives to their materialized cache, so
  // this branch only serves direct callers that pass a raw .zst path; those
  // callers never carry persisted offsets, keeping the range space coherent.
  if (filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    yield* readJsonlRecords(materializeSessionArchiveForRead(filePath), startOffset, endOffset);
    return;
  }
  yield* readJsonlRecords(filePath, startOffset, endOffset);
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

export async function scanUsageFile(params: {
  filePath: string;
  config?: OpenClawConfig;
  resolveCost?: UsageCostResolver;
  startOffset?: number;
  endOffset?: number;
  onEntry: (entry: ParsedUsageEntry) => void;
}): Promise<void> {
  const resolveCost = params.resolveCost ?? createUsageCostResolver({ config: params.config });
  for await (const parsed of readTranscriptRecords(
    params.filePath,
    params.startOffset,
    params.endOffset,
  )) {
    const entry = parseUsageCostTranscriptEntry(parsed, resolveCost);
    if (!entry?.usage) {
      continue;
    }
    params.onEntry({
      usage: entry.usage,
      costTotal: entry.costTotal,
      costBreakdown: entry.costBreakdown,
      provider: entry.provider,
      model: entry.model,
      timestamp: entry.timestamp,
    });
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
    entryMarker && (!sessionId || entryMarker.sessionId === sessionId) ? entryMarker : undefined;
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
      ? resolveSessionFilePath(sessionId, params.sessionEntry, {
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
