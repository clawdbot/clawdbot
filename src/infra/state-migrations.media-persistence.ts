import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  decodeSessionArchiveBytes,
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { isSessionArchiveArtifactName } from "../config/sessions/artifacts.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  canonicalizePersistedUserMessageMedia,
  hasMeaningfulRetiredMediaCarrier,
} from "../media/media-facts.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { assertOpenClawAgentSchemaContains } from "../state/openclaw-agent-db-schema-helpers.js";
import {
  ensureOpenClawAgentDatabaseSchema,
  migrateOpenClawAgentDatabaseToMediaPrerequisiteSchema,
} from "../state/openclaw-agent-db-schema.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { repairGatewayAgentMediaMigrationStartupFailures } from "./gateway-boot-lifecycle.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  clearNodeSqliteKyselyCacheForDatabase,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { replaceFileAtomicSync } from "./replace-file.js";
import { repairCanonicalSqliteIndexes } from "./sqlite-index-schema.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "./sqlite-transaction.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { resolveAgentDatabaseMigrationTargets } from "./state-migrations.media-persistence-targets.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const PREVIOUS_MEDIA_SCHEMA_VERSION = OPENCLAW_AGENT_SCHEMA_VERSION - 1;
const ARCHIVE_TEMP_MARKER = ".media-retirement";
const MEDIA_MIGRATION_ROW_BATCH_SIZE = 64;

type MediaMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "schema_meta" | "session_windows" | "trajectory_runtime_events" | "transcript_events"
>;

type TrajectoryRowRewritePlan = {
  eventJson: string;
  rewrittenEventJson: string;
  seq: number;
  sessionId: string;
};

type ArchiveSourceSnapshot = {
  dev: number;
  ino: number;
  mtimeMs: number;
  sha256: string;
  size: number;
};

function transformTranscriptEvent(event: TranscriptEvent): {
  changed: boolean;
  event: TranscriptEvent;
} {
  if (!isRecord(event) || event.type !== "message" || !isRecord(event.message)) {
    return { changed: false, event };
  }
  const canonical = canonicalizePersistedUserMessageMedia(event.message);
  return canonical.changed
    ? { changed: true, event: { ...event, message: canonical.message } }
    : { changed: false, event };
}

function parseTranscriptEvent(raw: string, owner: string): TranscriptEvent {
  try {
    return JSON.parse(raw) as TranscriptEvent;
  } catch (error) {
    throw new Error(`${owner} contains invalid transcript JSON: ${String(error)}`, {
      cause: error,
    });
  }
}

function eventIdentity(event: TranscriptEvent): string {
  if (!isRecord(event)) {
    return JSON.stringify({ id: null, parentId: null, type: null });
  }
  return JSON.stringify({
    id: typeof event.id === "string" ? event.id : null,
    parentId: typeof event.parentId === "string" ? event.parentId : null,
    type: typeof event.type === "string" ? event.type : null,
  });
}

function assertEventIdentitiesUnchanged(
  before: readonly TranscriptEvent[],
  after: readonly TranscriptEvent[],
  owner: string,
): void {
  if (before.length !== after.length) {
    throw new Error(`${owner} event count changed during media migration`);
  }
  for (let index = 0; index < before.length; index += 1) {
    if (eventIdentity(before[index]) !== eventIdentity(after[index])) {
      throw new Error(`${owner} event identity changed at index ${index}`);
    }
  }
}

function scanTranscriptRows(params: {
  database: DatabaseSync;
  pathname: string;
  writer?: OpenClawAgentDatabase;
}): number {
  const { database, pathname, writer } = params;
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
  const sessionRows = executeSqliteQuerySync(
    database,
    db.selectFrom("session_windows").select(["session_id", "session_key"]),
  ).rows;
  const sessionKeys = new Map(sessionRows.map((row) => [row.session_id, row.session_key]));
  const sessionIds = executeSqliteQuerySync(
    database,
    db.selectFrom("transcript_events").select("session_id").distinct().orderBy("session_id", "asc"),
  ).rows.map((row) => row.session_id);
  let changedSessions = 0;
  for (const sessionId of sessionIds) {
    const sessionKey = sessionKeys.get(sessionId);
    if (!sessionKey) {
      throw new Error(`${pathname}:${sessionId} has transcript rows without a session window`);
    }
    let afterSeq: number | undefined;
    let sessionChanged = false;
    while (true) {
      let query = db
        .selectFrom("transcript_events")
        .select(["seq", "event_json"])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc")
        .limit(MEDIA_MIGRATION_ROW_BATCH_SIZE);
      if (afterSeq !== undefined) {
        query = query.where("seq", ">", afterSeq);
      }
      const rows = executeSqliteQuerySync(database, query).rows;
      if (rows.length === 0) {
        break;
      }
      const rewrites = rows.flatMap((row) => {
        const owner = `${pathname}:${sessionId}:${row.seq}`;
        const event = parseTranscriptEvent(row.event_json, owner);
        const transformed = transformTranscriptEvent(event);
        if (!transformed.changed) {
          return [];
        }
        if (eventIdentity(event) !== eventIdentity(transformed.event)) {
          throw new Error(`${owner} event identity changed during media migration`);
        }
        sessionChanged = true;
        return [{ event: transformed.event, expectedEventJson: row.event_json, seq: row.seq }];
      });
      if (writer && rewrites.length > 0) {
        rewriteSqliteTranscriptEventRowsInTransaction(
          writer,
          { agentId: writer.agentId, path: pathname, sessionId, sessionKey },
          rewrites,
        );
      }
      afterSeq = rows.at(-1)?.seq;
    }
    if (sessionChanged) {
      changedSessions += 1;
    }
  }
  return changedSessions;
}

function planTrajectoryRowRewrite(params: {
  eventJson: string;
  owner: string;
  seq: number;
  sessionId: string;
}): TrajectoryRowRewritePlan {
  let event: unknown;
  try {
    event = JSON.parse(params.eventJson) as unknown;
  } catch (error) {
    throw new Error(`${params.owner} contains invalid trajectory JSON: ${String(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(event) || !isRecord(event.data) || !Array.isArray(event.data.messagesSnapshot)) {
    return {
      eventJson: params.eventJson,
      rewrittenEventJson: params.eventJson,
      seq: params.seq,
      sessionId: params.sessionId,
    };
  }
  let changed = false;
  const messagesSnapshot = event.data.messagesSnapshot.map((message) => {
    if (!isRecord(message) || !hasMeaningfulRetiredMediaCarrier(message)) {
      return message;
    }
    const canonical = canonicalizePersistedUserMessageMedia(message);
    changed ||= canonical.changed;
    return canonical.message;
  });
  return {
    eventJson: params.eventJson,
    rewrittenEventJson: changed
      ? JSON.stringify({
          ...event,
          data: { ...event.data, messagesSnapshot },
        })
      : params.eventJson,
    seq: params.seq,
    sessionId: params.sessionId,
  };
}

function scanTrajectoryRows(params: {
  database: DatabaseSync;
  pathname: string;
  rewrite: boolean;
}): number {
  const { database, pathname, rewrite } = params;
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
  const sessionIds = executeSqliteQuerySync(
    database,
    db
      .selectFrom("trajectory_runtime_events")
      .select("session_id")
      .distinct()
      .orderBy("session_id", "asc"),
  ).rows.map((row) => row.session_id);
  let changedRows = 0;
  for (const sessionId of sessionIds) {
    let afterSeq: number | undefined;
    while (true) {
      let query = db
        .selectFrom("trajectory_runtime_events")
        .select(["seq", "event_json"])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc")
        .limit(MEDIA_MIGRATION_ROW_BATCH_SIZE);
      if (afterSeq !== undefined) {
        query = query.where("seq", ">", afterSeq);
      }
      const rows = executeSqliteQuerySync(database, query).rows;
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        const planned = planTrajectoryRowRewrite({
          eventJson: row.event_json,
          owner: `${pathname}:${sessionId}:${row.seq}`,
          seq: row.seq,
          sessionId,
        });
        if (planned.rewrittenEventJson === planned.eventJson) {
          continue;
        }
        changedRows += 1;
        if (rewrite) {
          executeSqliteQuerySync(
            database,
            db
              .updateTable("trajectory_runtime_events")
              .set({ event_json: planned.rewrittenEventJson })
              .where("session_id", "=", sessionId)
              .where("seq", "=", row.seq),
          );
        }
      }
      afterSeq = rows.at(-1)?.seq;
    }
  }
  return changedRows;
}

type MediaSourceVersion = {
  dataVersion: number;
  trajectoryBytes: number;
  trajectoryRows: number;
  transcriptBytes: number;
  transcriptCreatedAt: number;
  transcriptRows: number;
};

function readMediaSourceVersion(database: DatabaseSync): MediaSourceVersion {
  const dataVersionRow = database.prepare("PRAGMA data_version").get();
  const transcript = database
    .prepare(
      "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(event_json)), 0) AS bytes, " +
        "COALESCE(SUM(created_at), 0) AS created_at FROM transcript_events",
    )
    .get();
  const trajectory = database
    .prepare(
      "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(event_json)), 0) AS bytes " +
        "FROM trajectory_runtime_events",
    )
    .get();
  const number = (value: unknown): number =>
    typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
  return {
    dataVersion: number(isRecord(dataVersionRow) ? dataVersionRow.data_version : undefined),
    trajectoryBytes: number(isRecord(trajectory) ? trajectory.bytes : undefined),
    trajectoryRows: number(isRecord(trajectory) ? trajectory.rows : undefined),
    transcriptBytes: number(isRecord(transcript) ? transcript.bytes : undefined),
    transcriptCreatedAt: number(isRecord(transcript) ? transcript.created_at : undefined),
    transcriptRows: number(isRecord(transcript) ? transcript.rows : undefined),
  };
}

function mediaSourceDriftMessage(
  pathname: string,
  expected: MediaSourceVersion,
  current: MediaSourceVersion,
): string {
  if (
    expected.transcriptRows !== current.transcriptRows ||
    expected.transcriptBytes !== current.transcriptBytes ||
    expected.transcriptCreatedAt !== current.transcriptCreatedAt
  ) {
    return `${pathname} transcript source changed before migration commit`;
  }
  if (
    expected.trajectoryRows !== current.trajectoryRows ||
    expected.trajectoryBytes !== current.trajectoryBytes
  ) {
    return `${pathname} trajectory source changed before migration commit`;
  }
  return `${pathname} source changed before migration transaction`;
}

function createMigrationDatabaseHandle(
  database: DatabaseSync,
  agentId: string,
  pathname: string,
): OpenClawAgentDatabase {
  return {
    agentId,
    db: database,
    path: pathname,
    walMaintenance: { checkpoint: () => false, close: () => false },
  };
}

function migrateAgentDatabase(params: {
  agentId: string;
  beforeTransaction?: () => void;
  pathname: string;
}): { rewrittenSessions: number; rewrittenTrajectoryRows: number; versionAdvanced: boolean } {
  const database = openNodeSqliteDatabase(params.pathname);
  try {
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    let metadata = assertOpenClawAgentDatabaseOwner(database, {
      agentId: params.agentId,
      pathname: params.pathname,
    });
    let userVersion = readSqliteUserVersion(database);
    if (userVersion <= PREVIOUS_MEDIA_SCHEMA_VERSION) {
      migrateOpenClawAgentDatabaseToMediaPrerequisiteSchema(database, {
        agentId: params.agentId,
        path: params.pathname,
      });
      metadata = assertOpenClawAgentDatabaseOwner(database, {
        agentId: params.agentId,
        pathname: params.pathname,
      });
      userVersion = readSqliteUserVersion(database);
    }
    if (
      userVersion !== PREVIOUS_MEDIA_SCHEMA_VERSION &&
      userVersion !== OPENCLAW_AGENT_SCHEMA_VERSION
    ) {
      throw new Error(
        `${params.pathname} uses schema version ${userVersion}; expected ${PREVIOUS_MEDIA_SCHEMA_VERSION} or ${OPENCLAW_AGENT_SCHEMA_VERSION}`,
      );
    }
    if (metadata.schemaVersion !== userVersion) {
      throw new Error(
        `${params.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match ${userVersion}`,
      );
    }
    if (userVersion === OPENCLAW_AGENT_SCHEMA_VERSION) {
      // Doctor can encounter a current-version database before newly additive schema exists.
      // Converge it through the canonical agent-schema owner before media validation.
      ensureOpenClawAgentDatabaseSchema(database, {
        agentId: params.agentId,
        path: params.pathname,
      });
    }
    // Remove after 2026-10-12: drop the v15-to-v16 media cutover once schema 16 is the support floor.
    if (userVersion === PREVIOUS_MEDIA_SCHEMA_VERSION) {
      repairCanonicalSqliteIndexes(database, params.pathname, OPENCLAW_AGENT_SCHEMA_SQL, {
        validateAfterRepair: () =>
          assertOpenClawAgentSchemaContains(database, params.pathname, OPENCLAW_AGENT_SCHEMA_SQL),
      });
    }
    assertOpenClawAgentSchemaContains(database, params.pathname, OPENCLAW_AGENT_SCHEMA_SQL);
    const versionAdvanced = userVersion === PREVIOUS_MEDIA_SCHEMA_VERSION;
    if (!versionAdvanced) {
      const detected = runSqliteDeferredTransactionSync(
        database,
        () => ({
          rewrittenSessions: scanTranscriptRows({ database, pathname: params.pathname }),
          rewrittenTrajectoryRows: scanTrajectoryRows({
            database,
            pathname: params.pathname,
            rewrite: false,
          }),
        }),
        { databaseLabel: params.pathname, operationLabel: "media-persistence-detection" },
      );
      if (detected.rewrittenSessions === 0 && detected.rewrittenTrajectoryRows === 0) {
        return { ...detected, versionAdvanced: false };
      }
    }

    const sourceVersion = readMediaSourceVersion(database);
    params.beforeTransaction?.();
    const owner = createMigrationDatabaseHandle(database, params.agentId, params.pathname);
    const rewritten = runSqliteImmediateTransactionSync(
      database,
      () => {
        const currentSourceVersion = readMediaSourceVersion(database);
        if (currentSourceVersion.dataVersion !== sourceVersion.dataVersion) {
          throw new Error(
            mediaSourceDriftMessage(params.pathname, sourceVersion, currentSourceVersion),
          );
        }
        const rewrittenSessions = scanTranscriptRows({
          database,
          pathname: params.pathname,
          writer: owner,
        });
        const rewrittenTrajectoryRows = scanTrajectoryRows({
          database,
          pathname: params.pathname,
          rewrite: true,
        });
        if (versionAdvanced) {
          const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
          database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
          executeSqliteQuerySync(
            database,
            db
              .updateTable("schema_meta")
              .set({
                app_version: VERSION,
                schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
                updated_at: Date.now(),
              })
              .where("meta_key", "=", "primary"),
          );
        }
        return { rewrittenSessions, rewrittenTrajectoryRows };
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: params.pathname,
        operationLabel: "media-persistence-retirement",
      },
    );
    return {
      ...rewritten,
      versionAdvanced,
    };
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

function readArchiveSourceSnapshot(filePath: string): ArchiveSourceSnapshot {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${filePath} is not a regular archive file`);
  }
  const bytes = fs.readFileSync(filePath);
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: stat.size,
  };
}

function archiveSourceMatches(filePath: string, expected: ArchiveSourceSnapshot): boolean {
  try {
    const current = readArchiveSourceSnapshot(filePath);
    return (
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      current.mtimeMs === expected.mtimeMs &&
      current.sha256 === expected.sha256 &&
      current.size === expected.size
    );
  } catch {
    return false;
  }
}

function parseArchiveContent(content: string, filePath: string): TranscriptEvent[] {
  if (content === "") {
    return [];
  }
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  return lines.map((line, index) => {
    if (!line) {
      throw new Error(`${filePath} contains a blank JSONL record at line ${index + 1}`);
    }
    return parseTranscriptEvent(line, `${filePath}:${index + 1}`);
  });
}

function serializeArchiveEvents(
  events: readonly TranscriptEvent[],
  trailingNewline: boolean,
): string {
  if (events.length === 0) {
    return "";
  }
  return `${events.map((event) => JSON.stringify(event)).join("\n")}${trailingNewline ? "\n" : ""}`;
}

function migrateTranscriptArchive(
  filePath: string,
  options: { beforeReplace?: () => void } = {},
): boolean {
  const source = readArchiveSourceSnapshot(filePath);
  const content = readSessionArchiveContentSync(filePath);
  let nulTailStart = content.length;
  while (nulTailStart > 0 && content.charCodeAt(nulTailStart - 1) === 0) {
    nulTailStart -= 1;
  }
  const hasTerminalNulSuffix = nulTailStart < content.length;
  if (hasTerminalNulSuffix && nulTailStart === 0) {
    throw new Error(`${filePath} contains no JSONL records before its terminal NUL suffix`);
  }
  // Torn writes may leave only preallocated NUL bytes after complete JSONL records.
  // Recovery stays doctor-owned and reaches the same verified atomic replacement as media repair.
  const recoveredContent = hasTerminalNulSuffix ? content.slice(0, nulTailStart) : content;
  const events = parseArchiveContent(recoveredContent, filePath);
  let mediaChanged = false;
  const transformed = events.map((event) => {
    const result = transformTranscriptEvent(event);
    mediaChanged ||= result.changed;
    return result.event;
  });
  if (!hasTerminalNulSuffix && !mediaChanged) {
    return false;
  }
  assertEventIdentitiesUnchanged(events, transformed, filePath);
  const rewritten = mediaChanged
    ? serializeArchiveEvents(transformed, recoveredContent.endsWith("\n"))
    : recoveredContent;
  const compressed = filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX);
  const encoded = compressed
    ? encodeSessionArchiveContent(rewritten)
    : { bytes: Buffer.from(rewritten, "utf8"), suffix: "" as const };
  if (compressed && encoded.suffix !== SESSION_ARCHIVE_ZSTD_SUFFIX) {
    throw new Error(`${filePath} could not be re-encoded with its zstd codec`);
  }
  options.beforeReplace?.();
  replaceFileAtomicSync({
    filePath,
    content: encoded.bytes,
    preserveExistingMode: true,
    syncParentDir: true,
    syncTempFile: true,
    tempPrefix: `${path.basename(filePath)}${ARCHIVE_TEMP_MARKER}`,
    beforeRename: ({ tempPath }) => {
      if (!archiveSourceMatches(filePath, source)) {
        throw new Error(`${filePath} changed before atomic media migration replacement`);
      }
      const staged = decodeSessionArchiveBytes(fs.readFileSync(tempPath), compressed);
      if (staged !== rewritten) {
        throw new Error(`${filePath} failed codec readback before replacement`);
      }
      assertEventIdentitiesUnchanged(events, parseArchiveContent(staged, tempPath), filePath);
    },
  });
  if (readSessionArchiveContentSync(filePath) !== rewritten) {
    throw new Error(`${filePath} failed codec readback after replacement`);
  }
  return true;
}

function listTranscriptArchives(directory: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.includes(".jsonl.") &&
        isSessionArchiveArtifactName(entry.name),
    )
    .map((entry) => path.join(directory, entry.name));
}

/** Doctor-only migration from top-level Media* transcript fields to canonical facts. */
export function migrateLegacyMediaPersistence(
  params: {
    configuredAgentDatabaseTargets?: readonly { agentId: string; path: string }[];
    hooks?: {
      beforeArchiveReplace?: (archivePath: string) => void;
      beforeDatabaseTransaction?: (databasePath: string) => void;
    };
    env?: NodeJS.ProcessEnv;
  } = {},
): MigrationMessages {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  const targets = resolveAgentDatabaseMigrationTargets({
    changes,
    configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets ?? [],
    env,
    warnings,
  });
  const seenPaths = new Set<string>();
  let databaseMigrationFailed = false;
  const archiveDirectories = new Set<string>();
  for (const entry of targets) {
    const pathname = entry.path;
    archiveDirectories.add(
      resolveSqliteTranscriptArchiveDirectory({
        agentId: entry.agentId,
        path: pathname,
      }),
    );
    if (seenPaths.has(entry.realPath)) {
      continue;
    }
    seenPaths.add(entry.realPath);
    try {
      const result = migrateAgentDatabase({
        agentId: entry.agentId,
        beforeTransaction: params.hooks?.beforeDatabaseTransaction
          ? () => params.hooks?.beforeDatabaseTransaction?.(pathname)
          : undefined,
        pathname,
      });
      if (entry.source !== "registry" || result.versionAdvanced) {
        registerOpenClawAgentDatabase({ agentId: entry.agentId, env, path: pathname });
      }
      if (
        result.versionAdvanced ||
        result.rewrittenSessions > 0 ||
        result.rewrittenTrajectoryRows > 0
      ) {
        changes.push(
          `Migrated media persistence in ${pathname}: ${result.rewrittenSessions} transcript session(s), ${result.rewrittenTrajectoryRows} trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
        );
      }
    } catch (error) {
      databaseMigrationFailed = true;
      warnings.push(`Skipped media persistence migration for ${pathname}: ${String(error)}`);
    }
  }

  if (!databaseMigrationFailed && seenPaths.size > 0) {
    const repairedFailures = repairGatewayAgentMediaMigrationStartupFailures({
      databasePaths: [...seenPaths],
      env,
    });
    if (repairedFailures > 0) {
      changes.push(
        `Repaired ${repairedFailures} gateway startup failure ${repairedFailures === 1 ? "record" : "records"} after media migration.`,
      );
    }
  }

  for (const directory of archiveDirectories) {
    let archives: string[];
    try {
      archives = listTranscriptArchives(directory);
    } catch (error) {
      warnings.push(`Could not enumerate transcript archives in ${directory}: ${String(error)}`);
      continue;
    }
    for (const archive of archives) {
      try {
        if (
          migrateTranscriptArchive(archive, {
            beforeReplace: params.hooks?.beforeArchiveReplace
              ? () => params.hooks?.beforeArchiveReplace?.(archive)
              : undefined,
          })
        ) {
          changes.push(`Migrated archived transcript media in ${archive}.`);
        }
      } catch (error) {
        warnings.push(
          `Skipped archived transcript media migration for ${archive}: ${String(error)}`,
        );
      }
    }
  }
  return { changes, warnings };
}
