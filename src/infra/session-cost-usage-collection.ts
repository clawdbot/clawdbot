import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds } from "../agents/agent-scope.js";
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
  resolveStorePath,
} from "../config/sessions/paths.js";
import {
  listSessionTranscriptInstances,
  loadSessionEntry,
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTargetFromSessionStorePath,
  resolveUnsuffixedSqliteTargetFromSessionStorePath,
} from "../config/sessions/session-sqlite-target.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import { selectVisibleTranscriptEvents } from "../config/sessions/transcript-visible-events.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionStoreAgentId } from "../gateway/session-store-key.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";

export const USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY = 32;

/** Config is the only input that decides which session store usage discovery scans. */
type UsageCostDiscoveryScope = { minMtimeMs?: number; config?: OpenClawConfig };

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

// Discovery must enumerate the operator's configured store: a custom store
// filename resolves to a different SQLite database than the default one, so
// rebuilding the default path here hides every session the writer recorded.
function resolveUsageCostSessionStorePath(params: {
  agentId: string;
  config?: OpenClawConfig;
}): string {
  const store = params.config?.session?.store;
  return store
    ? resolveStorePath(store, { agentId: params.agentId })
    : resolveDefaultSessionStorePath(params.agentId);
}

/**
 * A configured store is shared when it expands to the same target for every agent, and
 * artifacts under it that carry no agent of their own -- legacy `<sessionId>.jsonl` files,
 * globally scoped keys -- must then be claimed by exactly one scan, or the all-agent
 * rollup counts them once per agent. `{agentId}` expansion is what makes a store
 * per-agent, and the two halves of discovery key off different parts of it: the SQLite
 * target follows the whole path, while legacy files only follow its directory. A store
 * like `<dir>/{agentId}.json` has per-agent databases but one shared directory.
 */
function resolveSharedStoreConfig(
  config: OpenClawConfig | undefined,
  part: "path" | "directory",
): OpenClawConfig | undefined {
  const store = config?.session?.store;
  if (typeof store !== "string" || !store.trim()) {
    return undefined;
  }
  const scoped = part === "directory" ? path.dirname(store) : store;
  return scoped.includes("{agentId}") ? undefined : config;
}

/**
 * A legacy `<sessionId>.jsonl` name carries no agent, so ownership has to come from the
 * directory holding it. A canonical store path names its owner (`agents/<id>/sessions/...`)
 * and that is authoritative; a shared locator's owner is only the configured default, which
 * names no one in particular. With no derivable owner and more than one agent, these files
 * are unattributable: charging the default agent would report one agent's spend under
 * another, which is worse than the omission it replaces -- they are not discovered at all
 * today. A sole configured agent still claims them, since that directory cannot be ambiguous.
 */
function ownsLegacyStoreDirectory(
  config: OpenClawConfig,
  agentId: string,
  storePath: string,
): boolean {
  // Resolve from the path alone: the agentId-aware form echoes the requesting agent back
  // for a custom store, which would make every agent look like the owner.
  const owner = resolveCanonicalStoreDirectoryOwner(storePath);
  const requested = normalizeAgentId(agentId);
  if (owner) {
    return normalizeAgentId(owner) === requested;
  }
  // The sole-agent case has to check *which* agent is asking. Discovery fans out over
  // the gateway roster, which admits agents this list does not (disk-resident ones), and
  // a per-agent request may name any id at all; answering "yes" on roster size alone
  // hands the same directory to every caller and double counts it.
  const roster = listAgentIds(config).map((id) => normalizeAgentId(id));
  return roster.length === 1 && roster[0] === requested;
}

/**
 * The agent named by a canonical `agents/<id>/sessions/` directory, if any.
 *
 * The store's own basename is not part of that question: `my-store.json` sitting in
 * `agents/main/sessions/` is still main's directory, and its legacy transcripts are still
 * main's. `resolveUnsuffixedSqliteTargetFromSessionStorePath` only derives an owner for the
 * exact `sessions.json` basename, so ask it a second time about the canonical name in the
 * same directory rather than restating its path rule here.
 */
function resolveCanonicalStoreDirectoryOwner(storePath: string): string | undefined {
  const direct = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath).agentId;
  if (direct) {
    return direct;
  }
  return resolveUnsuffixedSqliteTargetFromSessionStorePath(
    path.join(path.dirname(storePath), "sessions.json"),
  ).agentId;
}

async function listUsageCountedTranscriptFileStats(
  agentId: string,
  params?: UsageCostDiscoveryScope,
): Promise<UsageCostTranscriptFile[]> {
  // Legacy JSONL transcripts sit beside the store file; SQLite needs the store itself.
  const storePath = resolveUsageCostSessionStorePath({ agentId, ...params });
  const sharedStoreConfig = resolveSharedStoreConfig(params?.config, "directory");
  if (sharedStoreConfig && !ownsLegacyStoreDirectory(sharedStoreConfig, agentId, storePath)) {
    return [];
  }
  const sessionsDir = path.dirname(storePath);
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
  params?: UsageCostDiscoveryScope,
): UsageCostTranscriptFile[] {
  const storePath = resolveUsageCostSessionStorePath({ agentId, ...params });
  const requestedAgentId = normalizeAgentId(agentId);
  const sqliteTarget = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  // A fixed store can name one agent's own database, e.g. agents/<id>/sessions/sessions.json.
  // Reading it as any other agent is not merely empty: the scope resolver rejects the
  // mismatch, and one throw would abort the whole all-agent usage fan-out.
  if (
    sqliteTarget.shared !== true &&
    sqliteTarget.agentId &&
    normalizeAgentId(sqliteTarget.agentId) !== requestedAgentId
  ) {
    return [];
  }
  // Only an exact .sqlite locator under a fixed store is one database for every agent.
  // Any other store resolves to a per-agent database, where each row is ours by
  // construction and an ownership filter would silently drop transcripts.
  const fixedStoreConfig = resolveSharedStoreConfig(params?.config, "path");
  const sharedStoreConfig =
    fixedStoreConfig && sqliteTarget.shared === true ? fixedStoreConfig : undefined;
  const files: UsageCostTranscriptFile[] = [];
  // This scan reads transcript identity/timestamps only; clone:false avoids
  // cloning every current entry before the history projection and SQL rollups.
  for (const instance of listSessionTranscriptInstances({ agentId, storePath, clone: false })) {
    // The marker below stamps the caller's agent, so in a shared store every agent
    // would claim the same transcript and the all-agent rollup would re-count it.
    // Globally scoped keys have no agent of their own; the store-key owner rule
    // hands them to the default agent so exactly one scan picks them up.
    if (
      sharedStoreConfig &&
      normalizeAgentId(resolveSessionStoreAgentId(sharedStoreConfig, instance.sessionKey)) !==
        requestedAgentId
    ) {
      continue;
    }
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

export async function listUsageCountedTranscriptStats(
  agentId: string,
  params?: UsageCostDiscoveryScope,
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
  const transcriptPath = filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)
    ? materializeSessionArchiveForRead(filePath)
    : filePath;
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
