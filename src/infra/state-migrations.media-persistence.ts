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
import {
  isPersistentOpenClawAgentDatabasePath,
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
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
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const PREVIOUS_MEDIA_SCHEMA_VERSION = OPENCLAW_AGENT_SCHEMA_VERSION - 1;
const ARCHIVE_TEMP_MARKER = ".media-retirement";

type MediaMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "schema_meta" | "session_windows" | "trajectory_runtime_events" | "transcript_events"
>;

type TranscriptRowSnapshot = {
  createdAt: number;
  event: TranscriptEvent;
  eventJson: string;
  seq: number;
  sessionId: string;
};

type SessionRewritePlan = {
  changed: boolean;
  events: TranscriptEvent[];
  rows: TranscriptRowSnapshot[];
  sessionId: string;
  sessionKey: string;
};

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

function planTranscriptRows(database: DatabaseSync, pathname: string): SessionRewritePlan[] {
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
  const sessionRows = executeSqliteQuerySync(
    database,
    db.selectFrom("session_windows").select(["session_id", "session_key"]),
  ).rows;
  const sessionKeys = new Map(sessionRows.map((row) => [row.session_id, row.session_key]));
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select(["session_id", "seq", "event_json", "created_at"])
      .orderBy("session_id", "asc")
      .orderBy("seq", "asc"),
  ).rows;
  const bySession = new Map<string, TranscriptRowSnapshot[]>();
  for (const row of rows) {
    const snapshots = bySession.get(row.session_id) ?? [];
    snapshots.push({
      createdAt: row.created_at,
      event: parseTranscriptEvent(row.event_json, `${pathname}:${row.session_id}:${row.seq}`),
      eventJson: row.event_json,
      seq: row.seq,
      sessionId: row.session_id,
    });
    bySession.set(row.session_id, snapshots);
  }
  return [...bySession].map(([sessionId, snapshots]) => {
    const sessionKey = sessionKeys.get(sessionId);
    if (!sessionKey) {
      throw new Error(`${pathname}:${sessionId} has transcript rows without a session window`);
    }
    let changed = false;
    const events = snapshots.map((row) => {
      const transformed = transformTranscriptEvent(row.event);
      changed ||= transformed.changed;
      return transformed.event;
    });
    assertEventIdentitiesUnchanged(
      snapshots.map((row) => row.event),
      events,
      `${pathname}:${sessionId}`,
    );
    return { changed, events, rows: snapshots, sessionId, sessionKey };
  });
}

function assertTranscriptSourceUnchanged(
  database: DatabaseSync,
  pathname: string,
  planned: readonly SessionRewritePlan[],
): void {
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
  const current = executeSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select(["session_id", "seq", "event_json", "created_at"])
      .orderBy("session_id", "asc")
      .orderBy("seq", "asc"),
  ).rows;
  const expected = planned.flatMap((session) => session.rows);
  if (current.length !== expected.length) {
    throw new Error(`${pathname} transcript source changed before migration commit`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const left = current[index];
    const right = expected[index];
    if (
      !left ||
      !right ||
      left.session_id !== right.sessionId ||
      left.seq !== right.seq ||
      left.event_json !== right.eventJson ||
      left.created_at !== right.createdAt
    ) {
      throw new Error(`${pathname} transcript source changed before migration commit`);
    }
  }
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

function assertTrajectorySourceUnchanged(
  database: DatabaseSync,
  pathname: string,
  planned: readonly TrajectoryRowRewritePlan[],
): void {
  const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
  const current = executeSqliteQuerySync(
    database,
    db
      .selectFrom("trajectory_runtime_events")
      .select(["session_id", "seq", "event_json"])
      .orderBy("session_id", "asc")
      .orderBy("seq", "asc"),
  ).rows;
  if (current.length !== planned.length) {
    throw new Error(`${pathname} trajectory source changed before migration commit`);
  }
  for (let index = 0; index < planned.length; index += 1) {
    const left = current[index];
    const right = planned[index];
    if (
      !left ||
      !right ||
      left.session_id !== right.sessionId ||
      left.seq !== right.seq ||
      left.event_json !== right.eventJson
    ) {
      throw new Error(`${pathname} trajectory source changed before migration commit`);
    }
  }
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

function migrateRegisteredDatabase(params: {
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
    const planned = planTranscriptRows(database, params.pathname);
    const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
    const plannedTrajectoryRows = executeSqliteQuerySync(
      database,
      db
        .selectFrom("trajectory_runtime_events")
        .select(["session_id", "seq", "event_json"])
        .orderBy("session_id", "asc")
        .orderBy("seq", "asc"),
    ).rows.map((row) =>
      planTrajectoryRowRewrite({
        eventJson: row.event_json,
        owner: `${params.pathname}:${row.session_id}:${row.seq}`,
        seq: row.seq,
        sessionId: row.session_id,
      }),
    );
    const changedTrajectoryRows = plannedTrajectoryRows.filter(
      (row) => row.rewrittenEventJson !== row.eventJson,
    );
    const changedSessions = planned.filter((session) => session.changed);
    const versionAdvanced = userVersion === PREVIOUS_MEDIA_SCHEMA_VERSION;
    if (!versionAdvanced && changedSessions.length === 0 && changedTrajectoryRows.length === 0) {
      return { rewrittenSessions: 0, rewrittenTrajectoryRows: 0, versionAdvanced: false };
    }

    params.beforeTransaction?.();
    const owner = createMigrationDatabaseHandle(database, params.agentId, params.pathname);
    runSqliteImmediateTransactionSync(
      database,
      () => {
        assertTranscriptSourceUnchanged(database, params.pathname, planned);
        assertTrajectorySourceUnchanged(database, params.pathname, plannedTrajectoryRows);
        for (const session of changedSessions) {
          const rows = session.events.flatMap((event, index) => {
            const source = session.rows[index];
            if (!source || JSON.stringify(event) === source.eventJson) {
              return [];
            }
            return [{ event, expectedEventJson: source.eventJson, seq: source.seq }];
          });
          rewriteSqliteTranscriptEventRowsInTransaction(
            owner,
            {
              agentId: params.agentId,
              path: params.pathname,
              sessionId: session.sessionId,
              sessionKey: session.sessionKey,
            },
            rows,
          );
        }
        for (const row of changedTrajectoryRows) {
          executeSqliteQuerySync(
            database,
            db
              .updateTable("trajectory_runtime_events")
              .set({ event_json: row.rewrittenEventJson })
              .where("session_id", "=", row.sessionId)
              .where("seq", "=", row.seq),
          );
        }
        if (versionAdvanced) {
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
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: params.pathname,
        operationLabel: "media-persistence-retirement",
      },
    );
    return {
      rewrittenSessions: changedSessions.length,
      rewrittenTrajectoryRows: changedTrajectoryRows.length,
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
  let registered: ReturnType<typeof listOpenClawRegisteredAgentDatabases>;
  try {
    registered = listOpenClawRegisteredAgentDatabases({
      env,
      includeIncompatibleSchemaVersions: true,
    });
  } catch (error) {
    return {
      changes,
      warnings: [
        `Failed enumerating registered agent databases for media migration: ${String(error)}`,
      ],
    };
  }

  const seenPaths = new Set<string>();
  let databaseMigrationFailed = false;
  const archiveDirectories = new Set<string>();
  for (const entry of registered) {
    const pathname = path.resolve(entry.path);
    if (!isPersistentOpenClawAgentDatabasePath(pathname, env)) {
      unregisterOpenClawAgentDatabase({ agentId: entry.agentId, env, path: entry.path });
      changes.push(`Removed archived or transient agent database registry entry ${pathname}.`);
      continue;
    }
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(pathname);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`Could not inspect registered agent database ${pathname}: ${String(error)}`);
        continue;
      }
    }
    if (!stat?.isFile()) {
      unregisterOpenClawAgentDatabase({ agentId: entry.agentId, env, path: entry.path });
      changes.push(`Removed missing agent database registry entry ${pathname}.`);
      warnings.push(`Skipped missing registered agent database ${pathname}.`);
      continue;
    }
    archiveDirectories.add(
      resolveSqliteTranscriptArchiveDirectory({
        agentId: entry.agentId,
        path: pathname,
      }),
    );
    if (seenPaths.has(pathname)) {
      continue;
    }
    seenPaths.add(pathname);
    try {
      const result = migrateRegisteredDatabase({
        agentId: entry.agentId,
        beforeTransaction: params.hooks?.beforeDatabaseTransaction
          ? () => params.hooks?.beforeDatabaseTransaction?.(pathname)
          : undefined,
        pathname,
      });
      if (result.versionAdvanced) {
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
