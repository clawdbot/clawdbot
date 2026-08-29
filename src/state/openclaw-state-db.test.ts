// OpenClaw state database tests cover state DB migrations and persistence.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { saveCronStore } from "../cron/store.js";
import { loadedCronStoreFromRows, loadCronRows } from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import {
  countFailedDeliveryQueueEntries,
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntry,
  terminalizePendingDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
} from "../infra/delivery-queue-sqlite.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { listOpenFileDescriptorsForPath } from "../infra/open-file-descriptors.test-support.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { loadTaskRegistryStateFromSqlite } from "../tasks/task-registry.store.sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import {
  readConfigMachineState,
  readConfigMachineStateWithMetadata,
} from "./config-machine-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { listOpenClawRegisteredAgentDatabases } from "./openclaw-agent-db-registry.js";
import {
  FIRST_USE_STATE_TABLES,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import { ensureGitHubPublicationSchema } from "./openclaw-state-db-schema-additive.js";
import {
  findOpenClawStateDatabaseSchemaMigrationRequiredError,
  OpenClawStateDatabaseSchemaMigrationRequiredError,
} from "./openclaw-state-db-schema-migration-required.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseSchemaIfNeeded,
  runWithOpenClawStateBusyTimeout,
  runOpenClawStateWriteTransaction,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-compatibility.js";
import { STATE_SCHEMA_10_TO_9_DOWNGRADE_SQL } from "./openclaw-state-schema-v10-retirement.test-support.js";
import { STATE_SCHEMA_11_TO_10_TABLES_SQL } from "./openclaw-state-schema-v11-retirement.test-support.js";
import { STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL } from "./openclaw-state-schema-v12-foldin.test-support.js";
import { STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL } from "./openclaw-state-schema-v13-widerow.test-support.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import {
  collectSqliteSchemaShape,
  createSqliteSchemaShapeFromSql,
  normalizeSqliteSchemaShapeSql,
  replaceNamedIndexesWithNoncanonicalIndexes,
} from "./sqlite-schema-shape.test-support.js";

const stateDbLogInfo = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "state/db" ? { ...logger, info: stateDbLogInfo } : logger;
    },
  };
});

type StateDbTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "diagnostic_events" | "schema_meta" | "skill_usage"
>;

const stateDbTempDirs: string[] = [];
let canonicalStateDatabaseTemplatePath: string | undefined;

const V2026_7_1_2_STATE_FIXTURE_URL = new URL(
  "../../test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz",
  import.meta.url,
);
const V2026_7_1_2_STATE_FIXTURE_GZIP_SHA256 =
  "c775499d9a46462ae2368090a0c4ec75877784c40694046dd3af63df77b8737c";
const V2026_7_1_2_STATE_FIXTURE_RAW_SHA256 =
  "8511bb91f02d104f818c70b08397a678045d04741c931b0ee7ce6650b5519e85";
const V2026_7_1_2_STATE_FIXTURE_SCHEMA_SHA256 =
  "f2fd6488e283470718547fb45886f04cc940b1de798e52fbf34a3a3408ae25e4";

function createTempStateDir(): string {
  return makeTempDir(stateDbTempDirs, "openclaw-state-db-");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashSqliteSchema(database: DatabaseSync): string {
  const schema = database
    .prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all();
  return sha256(JSON.stringify(schema));
}

function materializeV2026_7_1_2StateDatabase(stateDir: string): {
  compressedSha256: string;
  databasePath: string;
  rawSha256: string;
} {
  const compressed = fs.readFileSync(V2026_7_1_2_STATE_FIXTURE_URL);
  const raw = gunzipSync(compressed);
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.writeFileSync(databasePath, raw);
  return {
    compressedSha256: sha256(compressed),
    databasePath,
    rawSha256: sha256(raw),
  };
}

function markStateDatabaseAsPreviousAppVersion(database: DatabaseSync): void {
  database
    .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
    .run("2026.7.0");
}

function createInitialStateSchemaShape() {
  const shape = createSqliteSchemaShapeFromSql(
    new URL("./openclaw-state-schema.sql", import.meta.url),
  );
  for (const tableName of FIRST_USE_STATE_TABLES) {
    delete shape[tableName];
  }
  return shape;
}

function createOlderV6StateSchemaWithoutWorkerSshFallbackPorts(): string {
  const startMarker = "CREATE TABLE IF NOT EXISTS worker_environment_ssh_fallback_ports (";
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(startMarker);
  const endMarker = "\n) STRICT;";
  const end = start >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) {
    throw new Error("worker SSH fallback port schema block is missing");
  }
  return `${OPENCLAW_STATE_SCHEMA_SQL.slice(0, start)}${OPENCLAW_STATE_SCHEMA_SQL.slice(
    end + endMarker.length,
  )}`;
}

function expectStateSchemaMigrationRequired(
  run: () => unknown,
  expected: {
    kind: OpenClawStateDatabaseSchemaMigrationRequiredError["kind"];
    pathname: string;
  },
): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OpenClawStateDatabaseSchemaMigrationRequiredError);
  expect(findOpenClawStateDatabaseSchemaMigrationRequiredError(caught)).toMatchObject(expected);
}

function replaceManagedImageRecordsWithLegacyTable(
  database: DatabaseSync,
  options: { withRow: boolean },
): void {
  database.exec(`
    DROP TABLE managed_outgoing_image_records;
    CREATE TABLE managed_outgoing_image_records (
      attachment_id TEXT NOT NULL PRIMARY KEY,
      session_key TEXT NOT NULL,
      message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      retention_class TEXT,
      alt TEXT NOT NULL,
      original_media_id TEXT NOT NULL,
      original_media_subdir TEXT NOT NULL,
      original_content_type TEXT NOT NULL,
      original_width INTEGER,
      original_height INTEGER,
      original_size_bytes INTEGER,
      original_filename TEXT,
      record_json TEXT NOT NULL
    );
    CREATE INDEX idx_managed_outgoing_images_session
      ON managed_outgoing_image_records(session_key, created_at DESC, attachment_id);
    CREATE INDEX idx_managed_outgoing_images_message
      ON managed_outgoing_image_records(session_key, message_id, attachment_id)
      WHERE message_id IS NOT NULL;
    PRAGMA user_version = 2;
    UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary';
  `);
  if (!options.withRow) {
    return;
  }
  const record = {
    attachmentId: "legacy-attachment",
    sessionKey: "agent:main:legacy",
    messageId: "legacy-message",
    createdAt: "2026-07-17T00:00:00.000Z",
    alt: "legacy image",
    original: {
      path: "/legacy/media/outgoing/originals/legacy-media",
      contentType: "image/png",
      width: 640,
      height: 480,
      sizeBytes: 1234,
      filename: "legacy.png",
    },
  };
  database
    .prepare(
      `INSERT INTO managed_outgoing_image_records (
        attachment_id,
        session_key,
        message_id,
        created_at,
        alt,
        original_media_id,
        original_media_subdir,
        original_content_type,
        original_width,
        original_height,
        original_size_bytes,
        original_filename,
        record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.attachmentId,
      record.sessionKey,
      record.messageId,
      record.createdAt,
      record.alt,
      "legacy-media",
      "outgoing/originals",
      record.original.contentType,
      record.original.width,
      record.original.height,
      record.original.sizeBytes,
      record.original.filename,
      JSON.stringify(record),
    );
}

const LEGACY_SESSION_WATCH_SCHEMA_VERSION = 3;
const LEGACY_AMBIENT_WATCH_PREFIX = "ambient-group-watch:";

function markStateDatabaseVersion(database: DatabaseSync, version: 5 | 6 | 7): void {
  database.exec(`
    PRAGMA user_version = ${version};
    UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
  `);
}

const RETIRED_COMMITMENT_SCHEMA_OBJECTS = [
  "commitments",
  "idx_commitments_scope_due",
  "idx_commitments_status_due",
  "idx_commitments_scope_dedupe",
  "idx_commitments_agent_due",
  "idx_commitments_agent_sent",
] as const;

const RETIRED_STATE_TABLES_V10 = [
  "agent_model_catalogs",
  "android_notification_recent_packages",
  "command_log_entries",
  "diagnostic_stability_bundles",
  "media_blobs",
  "model_capability_cache",
] as const;

const FOLDED_STATE_TABLES_V12 = [
  "skill_curator_state",
  "update_check_state",
  "clawhub_promotions_feed_state",
  "model_catalog_remote",
  "voicewake_triggers",
  "voicewake_routing_config",
  "voicewake_routing_routes",
  "onboarding_recommendations",
  "cron_store_epochs",
  "tui_last_sessions",
  "sidebar_sections",
  "node_host_config",
  "web_push_vapid_keys",
] as const;

function seedV6CommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT,
      recipient_id TEXT,
      thread_id TEXT,
      sender_id TEXT,
      kind TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      suggested_text TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      confidence REAL NOT NULL,
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      due_timezone TEXT NOT NULL,
      source_message_id TEXT,
      source_run_id TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      last_attempt_at_ms INTEGER,
      sent_at_ms INTEGER,
      dismissed_at_ms INTEGER,
      snoozed_until_ms INTEGER,
      expired_at_ms INTEGER,
      record_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX IF NOT EXISTS idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
    CREATE INDEX IF NOT EXISTS idx_commitments_scope_dedupe
      ON commitments(agent_id, session_key, channel, dedupe_key, status);
    CREATE INDEX IF NOT EXISTS idx_commitments_agent_due
      ON commitments(agent_id, status, due_earliest_ms, due_latest_ms, session_key);
    CREATE INDEX IF NOT EXISTS idx_commitments_agent_sent
      ON commitments(agent_id, status, sent_at_ms, session_key);
    INSERT INTO commitments (
      id, agent_id, session_key, channel, kind, sensitivity, source, status,
      reason, suggested_text, dedupe_key, confidence, due_earliest_ms,
      due_latest_ms, due_timezone, created_at_ms, updated_at_ms, attempts, record_json
    ) VALUES (
      'retired-commitment', 'main', 'agent:main:main', 'telegram', 'followup',
      'normal', 'message', 'pending', 'inert', 'follow up', 'retired-dedupe',
      1.0, 10, 20, 'UTC', 1, 1, 0, '{}'
    );
    INSERT INTO state_leases (
      scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at
    ) VALUES ('test', 'preserved-lease', 'migration-test', 100, 50, '{}', 1, 2);
  `);
  markStateDatabaseVersion(database, 6);
}

function seedAdditiveV6CommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT,
      recipient_id TEXT,
      thread_id TEXT,
      sender_id TEXT,
      kind TEXT NOT NULL DEFAULT 'followup',
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      source TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      suggested_text TEXT NOT NULL DEFAULT '',
      dedupe_key TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0,
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      due_timezone TEXT NOT NULL DEFAULT 'UTC',
      source_message_id TEXT,
      source_run_id TEXT,
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at_ms INTEGER,
      sent_at_ms INTEGER,
      dismissed_at_ms INTEGER,
      snoozed_until_ms INTEGER,
      expired_at_ms INTEGER,
      record_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
    CREATE INDEX idx_commitments_scope_dedupe
      ON commitments(agent_id, session_key, channel, dedupe_key, status);
    CREATE INDEX idx_commitments_agent_due
      ON commitments(agent_id, status, due_earliest_ms, due_latest_ms, session_key);
    CREATE INDEX idx_commitments_agent_sent
      ON commitments(agent_id, status, sent_at_ms, session_key);
  `);
  markStateDatabaseVersion(database, 6);
}

function seedPartiallyAdditiveV6CommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT,
      kind TEXT NOT NULL DEFAULT 'followup',
      status TEXT NOT NULL,
      dedupe_key TEXT NOT NULL DEFAULT '',
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      last_attempt_at_ms INTEGER,
      record_json TEXT NOT NULL
    );
    CREATE INDEX idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
  `);
  markStateDatabaseVersion(database, 6);
}

function seedEarlyCommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
  `);
}

function seedLegacySessionWatchCursorSchema(stateDir: string): {
  ambientTarget: string;
  bomTarget: string;
  bomWatcherSessionKey: string;
  corruptTarget: string;
  databasePath: string;
  explicitTarget: string;
  replacementWatcherSessionKey: string;
  watcherSessionKey: string;
} {
  const databasePath = materializeCurrentStateDatabase(stateDir);

  const watcherSessionKey = "agent:main:main";
  const ambientTarget = "agent:main:telegram:group:ambient";
  const bomTarget = "agent:main:telegram:group:bom";
  const bomWatcherSessionKey = "﻿agent:main:bom-watcher";
  const corruptTarget = "agent:main:telegram:group:corrupt";
  const explicitTarget = "agent:main:subagent:explicit";
  const replacementWatcherSessionKey = "�";
  const markerKey = `${LEGACY_AMBIENT_WATCH_PREFIX}${Buffer.from(watcherSessionKey, "utf8").toString("hex")}`;
  const bomMarkerKey = `${LEGACY_AMBIENT_WATCH_PREFIX}${Buffer.from(bomWatcherSessionKey, "utf8").toString("hex")}`;
  const orphanMarkerKey = `${LEGACY_AMBIENT_WATCH_PREFIX}${Buffer.from("agent:main:orphan", "utf8").toString("hex")}`;
  const { DatabaseSync } = requireNodeSqlite();
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      DROP INDEX idx_session_watch_cursors_target;
      ALTER TABLE session_watch_cursors RENAME TO session_watch_cursors_v4;
      CREATE TABLE session_watch_cursors (
        watcher_session_key TEXT NOT NULL,
        target_session_key TEXT NOT NULL,
        last_seen_sequence INTEGER NOT NULL DEFAULT 0,
        notified_sequence INTEGER NOT NULL DEFAULT 0,
        material_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (watcher_session_key, target_session_key)
      ) STRICT;
      DROP TABLE session_watch_cursors_v4;
      CREATE INDEX idx_session_watch_cursors_target
        ON session_watch_cursors(target_session_key);
      PRAGMA user_version = ${LEGACY_SESSION_WATCH_SCHEMA_VERSION};
      UPDATE schema_meta
      SET schema_version = ${LEGACY_SESSION_WATCH_SCHEMA_VERSION}
      WHERE meta_key = 'primary';
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    const insert = legacy.prepare(`
      INSERT INTO session_watch_cursors (
        watcher_session_key, target_session_key, last_seen_sequence,
        notified_sequence, material_sequence, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(watcherSessionKey, ambientTarget, 7, 8, 9, 200);
    insert.run(watcherSessionKey, explicitTarget, 3, 4, 5, 300);
    insert.run(bomWatcherSessionKey, bomTarget, 10, 11, 12, 500);
    insert.run(replacementWatcherSessionKey, corruptTarget, 13, 14, 15, 600);
    insert.run(markerKey, ambientTarget, 7, 7, 7, 400);
    insert.run(bomMarkerKey, bomTarget, 10, 10, 10, 800);
    insert.run(`${LEGACY_AMBIENT_WATCH_PREFIX}ff`, corruptTarget, 13, 13, 13, 900);
    insert.run(orphanMarkerKey, "agent:main:telegram:group:orphan", 1, 1, 1, 100);
    insert.run(`${LEGACY_AMBIENT_WATCH_PREFIX}not-hex`, ambientTarget, 1, 1, 1, 100);
  } finally {
    legacy.close();
  }
  return {
    ambientTarget,
    bomTarget,
    bomWatcherSessionKey,
    corruptTarget,
    databasePath,
    explicitTarget,
    replacementWatcherSessionKey,
    watcherSessionKey,
  };
}

type PlacementConstraintProbe = {
  sessionId: string;
  state: string;
  environmentId: string | null;
  activeOwnerEpoch: number | null;
  workerBundleHash: string | null;
  recoveryError: string | null;
  workspaceBaseManifestRef?: string;
  remoteWorkspaceDir?: string;
  lastTranscriptAckCursor?: number;
  lastLiveEventAckCursor?: number;
  turnClaimOwner?: "local" | "worker";
  turnClaimOwnerEpoch?: number;
};

function insertPlacementConstraintProbe(
  database: DatabaseSync,
  input: PlacementConstraintProbe,
): void {
  const hasClaim = input.turnClaimOwner !== undefined;
  database
    .prepare(
      `INSERT INTO worker_session_placements (
        session_id,
        agent_id,
        session_key,
        state,
        environment_id,
        active_owner_epoch,
        workspace_base_manifest_ref,
        remote_workspace_dir,
        worker_bundle_hash,
        last_transcript_ack_cursor,
        last_live_event_ack_cursor,
        recovery_error,
        turn_claim_owner,
        turn_claim_id,
        turn_claim_run_id,
        turn_claim_generation,
        turn_claim_owner_epoch,
        created_at_ms,
        updated_at_ms,
        state_changed_at_ms
      ) VALUES (?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
    )
    .run(
      input.sessionId,
      `agent:main:${input.sessionId}`,
      input.state,
      input.environmentId,
      input.activeOwnerEpoch,
      input.workspaceBaseManifestRef ?? null,
      input.remoteWorkspaceDir ?? null,
      input.workerBundleHash,
      input.lastTranscriptAckCursor ?? null,
      input.lastLiveEventAckCursor ?? null,
      input.recoveryError,
      input.turnClaimOwner ?? null,
      hasClaim ? `${input.sessionId}-claim` : null,
      hasClaim ? `${input.sessionId}-run` : null,
      hasClaim ? 0 : null,
      input.turnClaimOwnerEpoch ?? null,
    );
}

function statfsFixture(type: number): ReturnType<typeof fs.statfsSync> {
  return {
    type,
    bsize: 1024,
    blocks: 1,
    bfree: 1,
    bavail: 1,
    files: 0,
    frsize: 1024,
    ffree: 0,
  };
}

function createLegacyAuditStateDatabase(stateDir: string): string {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta (
        meta_key,
        role,
        schema_version,
        created_at,
        updated_at
      ) VALUES ('primary', 'global', 1, 10, 10);
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE,
        source_sequence INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        session_id TEXT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT
      );
      CREATE INDEX idx_audit_events_time
        ON audit_events(occurred_at DESC, sequence DESC);
      CREATE INDEX idx_audit_events_agent_sequence
        ON audit_events(agent_id, sequence DESC);
      CREATE INDEX idx_audit_events_session_sequence
        ON audit_events(session_key, sequence DESC);
      CREATE INDEX idx_audit_events_run_sequence
        ON audit_events(run_id, sequence DESC);
      CREATE INDEX idx_audit_events_kind_sequence
        ON audit_events(kind, sequence DESC);
      CREATE INDEX idx_audit_events_status_sequence
        ON audit_events(status, sequence DESC);
      INSERT INTO audit_events (
        sequence,
        event_id,
        source_id,
        source_sequence,
        occurred_at,
        kind,
        action,
        status,
        actor_type,
        actor_id,
        agent_id,
        run_id
      ) VALUES (
        7,
        'event-legacy',
        'run-legacy:1:100:agent.run.started',
        1,
        100,
        'agent_run',
        'agent.run.started',
        'started',
        'agent',
        'main',
        'main',
        'run-legacy'
      );
      UPDATE sqlite_sequence SET seq = 40 WHERE name = 'audit_events';
    `);
  } finally {
    db.close();
  }
  return databasePath;
}

function materializeCurrentStateDatabase(stateDir: string): string {
  if (!canonicalStateDatabaseTemplatePath) {
    throw new Error("canonical state database template was not initialized");
  }
  // These cases own post-initialization schema or row behavior. Fresh creation stays real below.
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.copyFileSync(canonicalStateDatabaseTemplatePath, databasePath);
  return databasePath;
}

function downgradeWorkerPlacementsToV7(db: DatabaseSync): void {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'worker_session_placements'",
    )
    .get() as { sql?: unknown } | undefined;
  if (typeof row?.sql !== "string") {
    throw new Error("missing worker_session_placements table SQL");
  }
  const v8LocalClaim = `(turn_claim_owner IS 'local' AND (\n      state IN ('local', 'requested', 'failed')\n      OR (state IN ('active', 'draining') AND execution_mode IS 'remote-exec')\n    ))`;
  const v7Create = row.sql
    .replace("CREATE TABLE worker_session_placements", "CREATE TABLE worker_session_placements_v7")
    .replace(
      "\n  execution_mode TEXT CHECK (execution_mode IN ('worker-turn', 'remote-exec')),",
      "",
    )
    .replace(
      v8LocalClaim,
      `(turn_claim_owner IS 'local' AND state IN ('local', 'requested', 'failed'))`,
    )
    .replace("\n      AND (execution_mode IS NULL OR execution_mode IS 'worker-turn')", "");
  if (v7Create.includes("execution_mode")) {
    throw new Error("failed to derive v7 worker placement schema");
  }
  const columns = (
    db.prepare("PRAGMA table_xinfo(worker_session_placements)").all() as Array<{
      hidden: number;
      name: string;
    }>
  )
    .filter((column) => column.hidden === 0 && column.name !== "execution_mode")
    .map((column) => `"${column.name}"`)
    .join(", ");
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      ${v7Create};
      INSERT INTO worker_session_placements_v7 (${columns})
        SELECT ${columns} FROM worker_session_placements;
      DROP TABLE worker_session_placements;
      ALTER TABLE worker_session_placements_v7 RENAME TO worker_session_placements;
      CREATE INDEX idx_worker_session_placements_session_key
        ON worker_session_placements(agent_id, session_key);
      CREATE INDEX idx_worker_session_placements_reconcile
        ON worker_session_placements(updated_at_ms, session_id);
      PRAGMA user_version = 7;
      UPDATE schema_meta SET schema_version = 7 WHERE meta_key = 'primary';
      COMMIT;
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

function openMaterializedCurrentStateDatabase(): DatabaseSync {
  const databasePath = materializeCurrentStateDatabase(createTempStateDir());
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(databasePath);
}

function rebuildAuditEventsTable(
  db: DatabaseSync,
  transformCreateSql: (sql: string) => string,
): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
    .get() as { sql?: unknown } | undefined;
  if (typeof table?.sql !== "string") {
    throw new Error("missing audit_events table SQL");
  }
  const indexes = db
    .prepare(
      `SELECT sql
         FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'audit_events'
          AND sql IS NOT NULL
        ORDER BY name`,
    )
    .all() as Array<{ sql?: unknown }>;
  const transformedCreateSql = transformCreateSql(table.sql);
  if (transformedCreateSql === table.sql) {
    throw new Error("audit_events test schema transform did not change the table");
  }
  db.exec("DROP TABLE audit_events");
  db.exec(transformedCreateSql);
  for (const index of indexes) {
    if (typeof index.sql !== "string") {
      throw new Error("missing audit_events index SQL");
    }
    db.exec(index.sql);
  }
}

function insertAuditMarker(
  db: DatabaseSync,
  eventId: string,
  sourceId: string,
  sequence = 7,
): void {
  db.prepare(
    `INSERT INTO audit_events (
       sequence, event_id, source_id, source_sequence, occurred_at, kind, action, status,
       actor_type, actor_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sequence,
    eventId,
    sourceId,
    sequence,
    100,
    "message",
    "message.inbound.processed",
    "succeeded",
    "system",
    "gateway",
  );
}

function createUnsafeIndexDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value);
      INSERT INTO unsafe_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function createTaskRunStatusIndexPhysicalDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    insertTaskRunProbe(database, "task-index-repair");
    database.exec(`
      DROP INDEX idx_task_runs_status;
      CREATE INDEX idx_task_runs_status ON task_runs(task_id);
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX idx_task_runs_status ON task_runs(status)' WHERE name = 'idx_task_runs_status'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
    expect(database.prepare("PRAGMA integrity_check('task_runs')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrity_check: expect.stringMatching(/idx_task_runs_status/),
        }),
      ]),
    );
  } finally {
    database.close();
  }
}

function insertTaskRunProbe(database: DatabaseSync, taskId: string): void {
  database
    .prepare(
      `INSERT INTO task_runs (
         task_id, runtime, owner_key, scope_kind, task, status,
         delivery_status, notify_policy, created_at
       ) VALUES (?, 'subagent', 'owner', 'session', 'sqlite read probe',
                 'running', 'pending', 'summary', 1)`,
    )
    .run(taskId);
}

function createUnsafeSchemaMetaIndexDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE INDEX unsafe_schema_meta_role ON schema_meta(role);");
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_schema_meta_role ON schema_meta(app_version)' WHERE name = 'unsafe_schema_meta_role'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function runHotRollbackJournalRecoveryProbe(params: { moduleUrl: string; rootDir: string }): {
  committedRowsAfterRecovery: number;
  immutableDirtyRowsBeforeKill: number;
  integrity: string;
  journalBytesBeforeReadOnly: number;
  journalExistsAfterReadOnly: boolean;
  journalExistsAfterRecovery: boolean;
  journalShaAfterReadOnly: string;
  journalShaBeforeReadOnly: string;
  readOnly: {
    error: string | null;
    opened: boolean;
    uncommittedRows: number | null;
  };
} {
  const probeSource = `
    import { spawn } from "node:child_process";
    import { createHash } from "node:crypto";
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    import { pathToFileURL } from "node:url";

    const moduleUrl = ${JSON.stringify(params.moduleUrl)};
    const databasePath = path.join(${JSON.stringify(params.rootDir)}, "hot-journal.sqlite");
    const readyPath = path.join(${JSON.stringify(params.rootDir)}, "writer-ready");
    const rowCount = 256;
    const {
      closeOpenClawStateDatabaseForTest,
      openExistingOpenClawStateDatabaseReadOnly,
      openOpenClawStateDatabase,
    } = await import(moduleUrl);

    const initial = openOpenClawStateDatabase({ path: databasePath });
    initial.db.exec(\`
      CREATE TABLE hot_journal_probe (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL,
        payload BLOB NOT NULL
      );
      WITH RECURSIVE rows(id) AS (
        SELECT 1
        UNION ALL
        SELECT id + 1 FROM rows WHERE id < \${rowCount}
      )
      INSERT INTO hot_journal_probe (id, value, payload)
      SELECT id, 'committed', zeroblob(8192) FROM rows;
    \`);
    closeOpenClawStateDatabaseForTest();

    const rollbackMode = new DatabaseSync(databasePath);
    rollbackMode.exec("PRAGMA journal_mode = DELETE;");
    rollbackMode.close();

    const writerSource = \`
      import fs from "node:fs";
      import { DatabaseSync } from "node:sqlite";

      const database = new DatabaseSync(process.env.OPENCLAW_HOT_JOURNAL_DATABASE_PATH);
      database.exec(
        "PRAGMA journal_mode = DELETE; " +
        "PRAGMA synchronous = FULL; " +
        "PRAGMA cache_size = 2; " +
        "PRAGMA cache_spill = ON; " +
        "BEGIN IMMEDIATE; " +
        "UPDATE hot_journal_probe SET value = 'uncommitted';",
      );
      fs.writeFileSync(process.env.OPENCLAW_HOT_JOURNAL_READY_PATH, "ready");
      setInterval(() => {}, 1_000);
    \`;
    const writer = spawn(
      process.execPath,
      ["--input-type=module", "-e", writerSource],
      {
        env: {
          ...process.env,
          OPENCLAW_HOT_JOURNAL_DATABASE_PATH: databasePath,
          OPENCLAW_HOT_JOURNAL_READY_PATH: readyPath,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let writerStderr = "";
    writer.stderr.on("data", (chunk) => {
      writerStderr += chunk;
    });
    const writerClosed = new Promise((resolve, reject) => {
      writer.once("error", reject);
      writer.once("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(readyPath)) {
        if (writer.exitCode !== null || writer.signalCode !== null) {
          throw new Error(\`writer exited before creating a hot journal: \${writerStderr}\`);
        }
        if (Date.now() >= deadline) {
          throw new Error("timed out waiting for hot rollback journal writer");
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const journalPath = \`\${databasePath}-journal\`;
      if (!fs.existsSync(journalPath) || fs.statSync(journalPath).size === 0) {
        throw new Error("writer did not leave a rollback journal");
      }
      const immutable = new DatabaseSync(
        \`\${pathToFileURL(databasePath).href}?mode=ro&immutable=1\`,
        { readOnly: true },
      );
      const immutableDirty = immutable
        .prepare("SELECT COUNT(*) AS count FROM hot_journal_probe WHERE value = 'uncommitted'")
        .get();
      immutable.close();
      const immutableDirtyRowsBeforeKill = Number(immutableDirty?.count ?? 0);
      if (immutableDirtyRowsBeforeKill === 0) {
        throw new Error("writer did not spill uncommitted pages into the main database");
      }
      writer.kill("SIGKILL");
      const outcome = await writerClosed;
      if (outcome.signal !== "SIGKILL") {
        throw new Error(\`writer was not killed: \${JSON.stringify(outcome)} \${writerStderr}\`);
      }

      const hashJournal = () =>
        createHash("sha256").update(fs.readFileSync(journalPath)).digest("hex");
      const journalBytesBeforeReadOnly = fs.statSync(journalPath).size;
      const journalShaBeforeReadOnly = hashJournal();
      let readOnly;
      try {
        const database = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
        const readOnlyRow = database?.db
          .prepare("SELECT COUNT(*) AS count FROM hot_journal_probe WHERE value = 'uncommitted'")
          .get();
        database?.walMaintenance.close();
        readOnly = {
          error: null,
          opened: true,
          uncommittedRows: Number(readOnlyRow?.count ?? 0),
        };
      } catch (error) {
        readOnly = {
          error: error instanceof Error ? error.message : String(error),
          opened: false,
          uncommittedRows: null,
        };
      }
      const journalExistsAfterReadOnly = fs.existsSync(journalPath);
      const journalShaAfterReadOnly = hashJournal();
      const reopened = openOpenClawStateDatabase({ path: databasePath });
      const row = reopened.db
        .prepare("SELECT COUNT(*) AS count FROM hot_journal_probe WHERE value = 'committed'")
        .get();
      const integrity = reopened.db.prepare("PRAGMA integrity_check").get();
      closeOpenClawStateDatabaseForTest();
      console.log(JSON.stringify({
        committedRowsAfterRecovery: Number(row?.count ?? 0),
        immutableDirtyRowsBeforeKill,
        integrity: integrity?.integrity_check,
        journalBytesBeforeReadOnly,
        journalExistsAfterReadOnly,
        journalExistsAfterRecovery: fs.existsSync(journalPath),
        journalShaAfterReadOnly,
        journalShaBeforeReadOnly,
        readOnly,
      }));
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill("SIGKILL");
        await writerClosed;
      }
      closeOpenClawStateDatabaseForTest();
    }
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", probeSource],
    { encoding: "utf8", timeout: 30_000 },
  );
  const resultLine = output.trim().split("\n").at(-1);
  if (!resultLine) {
    throw new Error("hot rollback journal recovery probe produced no result");
  }
  return JSON.parse(resultLine) as {
    committedRowsAfterRecovery: number;
    immutableDirtyRowsBeforeKill: number;
    integrity: string;
    journalBytesBeforeReadOnly: number;
    journalExistsAfterReadOnly: boolean;
    journalExistsAfterRecovery: boolean;
    journalShaAfterReadOnly: string;
    journalShaBeforeReadOnly: string;
    readOnly: {
      error: string | null;
      opened: boolean;
      uncommittedRows: number | null;
    };
  };
}

function expectNoncanonicalAuditSchemaRejected(
  stateDir: string,
  databasePath: string,
  doctorWarning = "cannot be repaired automatically",
): void {
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
    { kind: "audit-events-v2", path: databasePath },
  ]);
  expect(() => openOpenClawStateDatabase(options)).toThrow(/noncanonical audit event schema/);
  expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
    changes: [],
    warnings: [expect.stringContaining(doctorWarning)],
  });
}

function runConcurrentSchemaProbe(params: {
  mode: "fresh" | "upgrade";
  moduleUrl: string;
  rootDir: string;
}): string[] {
  const workerSource = `
    import fs from "node:fs";

    const {
      closeOpenClawStateDatabaseForTest,
      openOpenClawStateDatabase,
    } = await import(process.env.OPENCLAW_SCHEMA_TEST_MODULE_URL);
    const databasePath = process.env.OPENCLAW_SCHEMA_TEST_DATABASE_PATH;
    const enteringPath = process.env.OPENCLAW_SCHEMA_TEST_ENTERING_PATH;
    const readyPath = process.env.OPENCLAW_SCHEMA_TEST_READY_PATH;
    const startPath = process.env.OPENCLAW_SCHEMA_TEST_START_PATH;
    const workerIndex = process.env.OPENCLAW_SCHEMA_TEST_WORKER_INDEX;
    fs.writeFileSync(readyPath, "ready");
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(startPath)) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for concurrent schema upgrade start");
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    fs.writeFileSync(enteringPath, \`entering-\${workerIndex}\`);
    try {
      const database = openOpenClawStateDatabase({ path: databasePath });
      const integrity = database.db.prepare("PRAGMA integrity_check").get();
      if (integrity?.integrity_check !== "ok") {
        throw new Error("state database integrity check failed");
      }
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  `;
  const orchestratorSource = `
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";

    const moduleUrl = ${JSON.stringify(params.moduleUrl)};
    const rootDir = ${JSON.stringify(params.rootDir)};
    const mode = ${JSON.stringify(params.mode)};
    const workerSource = ${JSON.stringify(workerSource)};
    const workerCount = 2;
    const roundCount = 1;
    const databasePaths = [];
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const coordinatorContracts =
      mode === "fresh"
        ? await Promise.all([
            import(new URL("../infra/boundary-path.ts", moduleUrl).href),
            import(new URL("../infra/crypto-digest.ts", moduleUrl).href),
            import(new URL("../infra/sqlite-coordinator.ts", moduleUrl).href),
            import(new URL("./openclaw-state-db-contract.ts", moduleUrl).href),
          ])
        : undefined;

    function waitForChild(child) {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
          if (!settled) {
            settled = true;
            resolve({ ...result, stderr, stdout });
          }
        };
        child.once("error", (error) => finish({ code: null, error: String(error), signal: null }));
        child.once("close", (code, signal) => finish({ code, signal }));
      });
    }

    async function waitForMarkers(workers, markerPaths, label, round) {
      const deadline = Date.now() + 15_000;
      while (!markerPaths.every((markerPath) => fs.existsSync(markerPath))) {
        const exitedIndex = workers.findIndex(
          (worker) => worker.exitCode !== null || worker.signalCode !== null,
        );
        if (exitedIndex >= 0) {
          throw new Error(\`round \${round} worker \${exitedIndex} exited before \${label}\`);
        }
        if (Date.now() >= deadline) {
          throw new Error(\`round \${round} timed out waiting for \${label}\`);
        }
        await sleep(2);
      }
    }

    async function waitForOutcomes(outcomes, round) {
      let timeout;
      try {
        return await Promise.race([
          Promise.all(outcomes),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(\`round \${round} timed out waiting for workers to exit\`)),
              15_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }

    function openFreshInitializationCoordinator(databasePath) {
      if (!coordinatorContracts) {
        throw new Error("fresh initialization coordinator contracts are unavailable");
      }
      const [
        { resolvePathViaExistingAncestorSync },
        { sha256HexPrefixCore },
        { ensurePrivateSqliteCoordinatorDirectory },
        { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS },
      ] = coordinatorContracts;
      const canonicalDatabasePath = resolvePathViaExistingAncestorSync(databasePath);
      const canonicalRuntimeDirectory = resolvePathViaExistingAncestorSync("/tmp");
      const suffix = typeof process.getuid === "function"
        ? \`openclaw-state-locks-\${process.getuid()}\`
        : "openclaw-state-locks";
      const coordinatorPath = path.join(
        canonicalRuntimeDirectory,
        suffix,
        \`state-lifecycle.\${sha256HexPrefixCore(canonicalDatabasePath, 8)}.lock.sqlite\`,
      );
      ensurePrivateSqliteCoordinatorDirectory(
        path.dirname(coordinatorPath),
        "state ownership coordinator test",
      );
      const coordinator = new DatabaseSync(coordinatorPath);
      try {
        coordinator.exec(
          \`PRAGMA busy_timeout = \${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}; BEGIN EXCLUSIVE;\`,
        );
      } catch (error) {
        coordinator.close();
        throw error;
      }
      return coordinator;
    }

    function releaseCoordinator(coordinator) {
      if (!coordinator) {
        return;
      }
      const errors = [];
      try {
        coordinator.exec("ROLLBACK");
      } catch (error) {
        errors.push(error);
      }
      try {
        coordinator.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "coordinator rollback and close failed");
      }
    }

    for (let round = 0; round < roundCount; round += 1) {
      const databasePath = path.join(rootDir, \`concurrent-\${mode}-\${round}.sqlite\`);
      const barrierDir = path.join(rootDir, \`barrier-\${round}\`);
      fs.mkdirSync(barrierDir, { recursive: true });

      if (mode === "upgrade") {
        const {
          closeOpenClawStateDatabaseForTest,
          openOpenClawStateDatabase,
        } = await import(moduleUrl);
        openOpenClawStateDatabase({ path: databasePath });
        closeOpenClawStateDatabaseForTest();

        const legacy = new DatabaseSync(databasePath);
        legacy
          .prepare(
            \`INSERT INTO task_runs (
               task_id, runtime, requester_session_key, owner_key, scope_kind,
               child_session_key, agent_id, task, status, delivery_status,
               notify_policy, created_at, last_event_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
          )
          .run(
            \`legacy-concurrent-\${round}\`,
            "subagent",
            "agent:main:main",
            "agent:main:main",
            "session",
            \`agent:worker:subagent:concurrent-\${round}\`,
            "main",
            "Verify concurrent schema upgrade",
            "running",
            "pending",
            "done_only",
            100,
            100,
          );
        legacy.exec(\`
          DROP TABLE worker_environment_credentials;
          ALTER TABLE gateway_boot_lifecycle DROP COLUMN startup_reason;
          ALTER TABLE task_runs DROP COLUMN requester_agent_id;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_mode;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_key_id;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_signature_count;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_threshold;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_verified_at;
          ALTER TABLE worker_environments DROP COLUMN bootstrap_bundle_hash;
          ALTER TABLE worker_environments DROP COLUMN bootstrap_openclaw_version;
          ALTER TABLE worker_environments DROP COLUMN bootstrap_protocol_features_json;
          ALTER TABLE worker_environments DROP COLUMN bootstrap_install_kind;
          ALTER TABLE worker_environments DROP COLUMN owner_epoch;
          ALTER TABLE worker_environments DROP COLUMN teardown_terminal_state;
          ALTER TABLE worker_environments DROP COLUMN ssh_host_key;
          PRAGMA user_version = 1;
          UPDATE schema_meta
             SET schema_version = 1,
                 updated_at = 1
           WHERE meta_key = 'primary';
        \`);
        legacy.close();
      }

      const startPath = path.join(barrierDir, "start");
      const enteringPaths = Array.from({ length: workerCount }, (_, index) =>
        path.join(barrierDir, \`entering-\${index}\`),
      );
      const readyPaths = Array.from({ length: workerCount }, (_, index) =>
        path.join(barrierDir, \`ready-\${index}\`),
      );
      const workers = Array.from({ length: workerCount }, (_, index) => {
        return spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", workerSource],
          {
            env: {
              ...process.env,
              OPENCLAW_SCHEMA_TEST_DATABASE_PATH: databasePath,
              OPENCLAW_SCHEMA_TEST_ENTERING_PATH: enteringPaths[index],
              OPENCLAW_SCHEMA_TEST_MODULE_URL: moduleUrl,
              OPENCLAW_SCHEMA_TEST_READY_PATH: readyPaths[index],
              OPENCLAW_SCHEMA_TEST_START_PATH: startPath,
              OPENCLAW_SCHEMA_TEST_WORKER_INDEX: String(index),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      });
      const outcomes = workers.map(waitForChild);
      let coordinator;
      let roundError;
      try {
        await waitForMarkers(workers, readyPaths, "ready markers", round);
        if (mode === "fresh") {
          coordinator = openFreshInitializationCoordinator(databasePath);
        }
        fs.writeFileSync(startPath, "start");

        if (mode === "fresh") {
          await waitForMarkers(workers, enteringPaths, "entering markers", round);
          // Both children have reached the synchronous open behind the exact production
          // coordinator; target absence while it is held proves contention, not scheduling.
          await sleep(250);
          assert.equal(
            fs.existsSync(databasePath),
            false,
            \`round \${round} database was created while the ownership coordinator was held\`,
          );
          for (const [index, worker] of workers.entries()) {
            assert.equal(worker.exitCode, null, \`round \${round} worker \${index} exited early\`);
            assert.equal(worker.signalCode, null, \`round \${round} worker \${index} signaled early\`);
          }
        }
      } catch (error) {
        roundError = error;
      } finally {
        try {
          releaseCoordinator(coordinator);
        } catch (error) {
          roundError = roundError
            ? new AggregateError(
                [roundError, error],
                \`round \${round} probe and coordinator release failed\`,
              )
            : error;
        }
        if (roundError) {
          for (const worker of workers) {
            if (worker.exitCode === null && worker.signalCode === null) {
              worker.kill();
            }
          }
        }
      }
      let results;
      try {
        results = await waitForOutcomes(outcomes, round);
      } catch (error) {
        roundError = roundError
          ? new AggregateError([roundError, error], \`round \${round} probe and worker wait failed\`)
          : error;
        for (const worker of workers) {
          if (worker.exitCode === null && worker.signalCode === null) {
            worker.kill();
          }
        }
        results = await Promise.all(outcomes);
      }
      if (roundError) {
        throw new Error(
          \`round \${round} probe failed: \${String(roundError)}; workers: \${JSON.stringify(results)}\`,
          { cause: roundError },
        );
      }
      const failures = results.filter((result) => result.error || result.code !== 0);
      if (failures.length > 0) {
        throw new Error(\`round \${round} worker failures: \${JSON.stringify(failures)}\`);
      }
      databasePaths.push(databasePath);
    }

    console.log(JSON.stringify(databasePaths));
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", orchestratorSource],
    { encoding: "utf8", timeout: 60_000 },
  );
  const resultLine = output.trim().split("\n").at(-1);
  if (!resultLine) {
    throw new Error(`concurrent schema ${params.mode} probe produced no result`);
  }
  return JSON.parse(resultLine) as string[];
}

beforeAll(() => {
  const stateDir = createTempStateDir();
  canonicalStateDatabaseTemplatePath = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: stateDir },
  }).path;
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => {
  cleanupTempDirs(stateDbTempDirs);
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  stateDbLogInfo.mockClear();
  vi.restoreAllMocks();
});

describe("openclaw state database", () => {
  it.runIf(process.platform === "linux")(
    "evicts a detached WAL family before reopening the shared state database",
    () => {
      vi.useFakeTimers();
      try {
        const stateDir = createTempStateDir();
        const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
        const opened = openOpenClawStateDatabase(options);
        expect(opened.walMaintenance.checkpoint()).toBe(true);
        fs.unlinkSync(`${opened.path}-wal`);
        fs.unlinkSync(`${opened.path}-shm`);

        vi.advanceTimersByTime(30 * 60 * 1000);

        expect(opened.db.isOpen).toBe(false);
        expect(() => opened.db.prepare("PRAGMA schema_version").get()).toThrow();
        const reopened = openOpenClawStateDatabase(options);
        expect(reopened).not.toBe(opened);
        expect(reopened.db.isOpen).toBe(true);
        expect(() =>
          reopened.db
            .prepare(
              "UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
            )
            .run(),
        ).not.toThrow();
      } finally {
        closeOpenClawStateDatabaseForTest();
        vi.useRealTimers();
      }
    },
  );

  it("resolves under the shared state database directory", () => {
    const stateDir = createTempStateDir();

    expect(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir })).toBe(
      path.join(stateDir, "state", "openclaw.sqlite"),
    );
  });

  it.each([
    { NODE_ENV: "production" },
    { NODE_ENV: "test" },
    { VITEST: "true", VITEST_WORKER_ID: "7" },
  ])("resolves default SQLite state through HOME with %j", (runtimeEnv) => {
    const home = createTempStateDir();
    expect(resolveOpenClawStateSqlitePath({ ...runtimeEnv, HOME: home })).toBe(
      path.join(home, ".openclaw", "state", "openclaw.sqlite"),
    );
  });

  it("creates the shared state schema from the committed SQL shape", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(collectSqliteSchemaShape(database.db)).toEqual(createInitialStateSchemaShape());
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("commitments"),
    ).toBeUndefined();
    expect(database.path).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
    expect(
      database.db
        .prepare(
          `SELECT name FROM pragma_table_list
           WHERE schema = 'main'
             AND type = 'table'
             AND name NOT LIKE 'sqlite_%'
             AND strict <> 1`,
        )
        .all(),
    ).toEqual([]);
    expect(
      database.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'apns_registration_tombstones'")
        .get(),
    ).toEqual({ strict: 1 });
    expect(() =>
      database.db
        .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
        .run("not-an-integer"),
    ).toThrow();
  });

  it.each(["runtime open", "doctor repair"] as const)(
    "migrates v7 worker placement claims through %s without losing rows",
    (migrationPath) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      legacy
        .prepare(
          `INSERT INTO worker_session_placements (
             session_id, agent_id, session_key, state, transition_generation,
             created_at_ms, updated_at_ms, state_changed_at_ms
           ) VALUES (?, ?, ?, 'local', 3, 1, 2, 2)`,
        )
        .run("legacy-session", "main", "agent:main:legacy");
      downgradeWorkerPlacementsToV7(legacy);
      legacy.close();

      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
        kind: "worker-placement-execution-mode-v8",
        path: databasePath,
      });
      if (migrationPath === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
          changes: [
            "Migrated cloud worker placements to execution modes",
            "Qualified historical cron creator attribution as unknown (v14)",
          ],
          warnings: [],
        });
      }
      const migrated = openOpenClawStateDatabase(options);
      expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(
        migrated.db
          .prepare(
            "SELECT session_id, transition_generation, execution_mode FROM worker_session_placements",
          )
          .get(),
      ).toEqual({ session_id: "legacy-session", transition_generation: 3, execution_mode: null });
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).not.toContainEqual({
        kind: "worker-placement-execution-mode-v8",
        path: databasePath,
      });
    },
  );

  it.each([17, OPENCLAW_AGENT_SCHEMA_VERSION])(
    "migrates v8 agent database registrations to state-relative paths (agent schema %s)",
    (agentSchemaVersion) => {
      const stateDir = createTempStateDir();
      const foreignStateDir = createTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const inRootPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      const dualInRootPath = path.join(
        stateDir,
        "agents",
        "dual",
        "agent",
        "openclaw-agent.sqlite",
      );
      const dualForeignPath = path.join(
        foreignStateDir,
        "agents",
        "dual",
        "agent",
        "openclaw-agent.sqlite",
      );
      const copiedForeignPath = path.join(
        foreignStateDir,
        "agents",
        "copied",
        "agent",
        "openclaw-agent.sqlite",
      );
      const copiedInRootPath = path.join(
        stateDir,
        "agents",
        "copied",
        "agent",
        "openclaw-agent.sqlite",
      );
      const preservedDefaultPath = path.join(
        foreignStateDir,
        "agents",
        "preserved",
        "agent",
        "openclaw-agent.sqlite",
      );
      const externalPath = path.join(foreignStateDir, "explicit", "external.sqlite");
      fs.mkdirSync(path.dirname(dualInRootPath), { recursive: true });
      fs.writeFileSync(dualInRootPath, "");
      fs.mkdirSync(path.dirname(copiedInRootPath), { recursive: true });
      fs.writeFileSync(copiedInRootPath, "");
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      const insert = legacy.prepare(
        `INSERT INTO agent_databases (
         agent_id, path, schema_version, last_seen_at, size_bytes
       ) VALUES (?, ?, ?, 1, NULL)`,
      );
      insert.run("main", inRootPath, agentSchemaVersion);
      insert.run("dual", dualInRootPath, agentSchemaVersion);
      insert.run("dual", dualForeignPath, agentSchemaVersion);
      insert.run("copied", copiedForeignPath, agentSchemaVersion);
      insert.run("preserved", preservedDefaultPath, agentSchemaVersion);
      insert.run("external", externalPath, agentSchemaVersion);
      legacy.exec(`
      PRAGMA user_version = 8;
      UPDATE schema_meta SET schema_version = 8 WHERE meta_key = 'primary';
    `);
      legacy.close();

      expect(detectOpenClawStateDatabaseSchemaMigrations({ env })).toContainEqual({
        kind: "agent-databases-relative-paths-v9",
        path: databasePath,
      });
      expect(repairOpenClawStateDatabaseSchema({ env })).toEqual({
        changes: [
          "Migrated agent database registry paths to state-relative storage (2 relativized, 1 re-anchored, 1 removed)",
          `Re-anchored agent database registry path ${copiedForeignPath} to the current state directory`,
          `Removed duplicate agent database registry path ${dualForeignPath}`,
          "Qualified historical cron creator attribution as unknown (v14)",
        ],
        warnings: [],
      });
      const migrated = openOpenClawStateDatabase({ env });
      expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(
        migrated.db.prepare("SELECT agent_id, path FROM agent_databases ORDER BY agent_id").all(),
      ).toEqual([
        {
          agent_id: "copied",
          path: path.join("agents", "copied", "agent", "openclaw-agent.sqlite"),
        },
        {
          agent_id: "dual",
          path: path.join("agents", "dual", "agent", "openclaw-agent.sqlite"),
        },
        { agent_id: "external", path: externalPath },
        {
          agent_id: "main",
          path: path.join("agents", "main", "agent", "openclaw-agent.sqlite"),
        },
        { agent_id: "preserved", path: preservedDefaultPath },
      ]);
      const expected = [
        expect.objectContaining({ agentId: "copied", path: copiedInRootPath }),
        expect.objectContaining({ agentId: "dual", path: dualInRootPath }),
        expect.objectContaining({ agentId: "external", path: externalPath }),
        expect.objectContaining({ agentId: "main", path: inRootPath }),
        expect.objectContaining({ agentId: "preserved", path: preservedDefaultPath }),
      ];
      expect(
        migrated.db.prepare("SELECT DISTINCT schema_version FROM agent_databases").all(),
      ).toEqual([{ schema_version: agentSchemaVersion }]);
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual(
        agentSchemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION ? expected : [],
      );
      expect(
        listOpenClawRegisteredAgentDatabases({ env, includeIncompatibleSchemaVersions: true }),
      ).toEqual(expected);
    },
  );

  it.each(["runtime open", "doctor repair"] as const)(
    "retires six dead v9 shared-state tables through %s",
    (migrationPath) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(STATE_SCHEMA_10_TO_9_DOWNGRADE_SQL);
      legacy.exec(`
        INSERT INTO agent_model_catalogs (catalog_key, agent_dir, raw_json, updated_at)
        VALUES ('main', '/agents/main', '{"models":[]}', 1);
      `);
      legacy.close();

      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
        kind: "state-table-retirement-v10",
        path: databasePath,
      });
      if (migrationPath === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
          changes: [
            "Retired six dead shared-state tables (v10)",
            "Qualified historical cron creator attribution as unknown (v14)",
          ],
          warnings: [],
        });
      }

      const migrated = openOpenClawStateDatabase(options);
      expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(
        migrated.db
          .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      for (const tableName of RETIRED_STATE_TABLES_V10) {
        expect(
          migrated.db
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .get(tableName),
        ).toBeUndefined();
      }
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).not.toContainEqual({
        kind: "state-table-retirement-v10",
        path: databasePath,
      });
    },
  );

  it.each(["runtime open", "doctor repair"] as const)(
    "retires v10 skill curator projections through %s while preserving live skill usage and proposal provenance",
    (migrationPath) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL);
      legacy.exec(STATE_SCHEMA_11_TO_10_TABLES_SQL);
      legacy.exec(`
        INSERT INTO skill_workshop_proposals (
          proposal_id, record_json, workspace_dir, kind, status, created_at, updated_at, draft_hash
        ) VALUES (
          'proposal-retired', '{"originRunIds":["run-retired"]}', '/workspace',
          'create', 'applied', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'hash'
        );
        INSERT INTO skill_workshop_proposal_origin_runs (
          proposal_id, run_id, position, mutation_count
        ) VALUES ('proposal-retired', 'run-retired', 0, 1);
        INSERT INTO skill_lifecycle (
          skill_file, skill_key, skill_name, state, state_changed_at_ms, created_at_ms,
          archived_reason
        ) VALUES (
          '/skills/archived/SKILL.md', 'archived', 'Archived', 'archived', 20, 10, 'unused'
        );
        INSERT INTO skill_usage (
          skill_file, skill_key, skill_name, skill_source, first_used_at_ms,
          last_used_at_ms, use_count, last_agent_id
        ) VALUES (
          '/skills/archived/SKILL.md', 'archived', 'Archived', 'workspace', 10, 30, 4, 'main'
        );
        INSERT INTO skill_curator_state (
          id, last_attempt_at_ms, last_success_at_ms, last_error, last_result_json
        ) VALUES (1, 40, 40, NULL, '{}');
        PRAGMA user_version = 10;
        UPDATE schema_meta SET schema_version = 10 WHERE meta_key = 'primary';
      `);
      legacy.close();

      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
        kind: "state-table-retirement-v11",
        path: databasePath,
      });
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
        kind: "singleton-state-foldin-v12",
        path: databasePath,
      });
      if (migrationPath === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
          changes: [
            "Retired legacy skill curator lifecycle and proposal origin-run tables",
            "Folded singleton state tables into config_machine_state (v12)",
            "Qualified historical cron creator attribution as unknown (v14)",
          ],
          warnings: [],
        });
      }
      const migrated = openOpenClawStateDatabase(options);
      expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(
        migrated.db
          .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      for (const name of [
        "skill_lifecycle",
        "idx_skill_lifecycle_key",
        "idx_skill_lifecycle_state",
        "skill_workshop_proposal_origin_runs",
        "skill_curator_state",
      ]) {
        expect(migrated.db.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(name)).toBe(
          undefined,
        );
      }
      expect(migrated.db.prepare("SELECT skill_file, use_count FROM skill_usage").get()).toEqual({
        skill_file: "/skills/archived/SKILL.md",
        use_count: 4,
      });
      expect(readConfigMachineState("skills.curatorState", options)).toBeUndefined();
      expect(
        migrated.db
          .prepare("SELECT record_json FROM skill_workshop_proposals WHERE proposal_id = ?")
          .get("proposal-retired"),
      ).toEqual({ record_json: '{"originRunIds":["run-retired"]}' });
    },
  );

  it.each(["runtime open", "doctor repair"] as const)(
    "folds v11 singleton state into machine-state keys through %s",
    (migrationPath) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL);
      legacy.exec(`
        INSERT INTO update_check_state (
          state_key, last_checked_at, last_notified_version, last_notified_tag,
          last_available_version, last_available_tag, auto_install_id,
          auto_first_seen_version, auto_first_seen_tag, auto_first_seen_at,
          auto_last_attempt_version, auto_last_attempt_at, auto_last_success_version,
          auto_last_success_at, updated_at_ms
        ) VALUES (
          'default', '2026-08-20T00:00:00.000Z', '2026.8.19', 'stable',
          '2026.8.20', 'beta', 'installation-42',
          '2026.8.18', 'stable', '2026-08-18T00:00:00.000Z',
          '2026.8.19', '2026-08-19T00:00:00.000Z', '2026.8.17',
          '2026-08-17T00:00:00.000Z', 200
        );
        INSERT INTO voicewake_triggers (config_key, position, trigger, updated_at_ms) VALUES
          ('default', 1, 'second wake word', 101),
          ('default', 0, 'first wake word', 100);
        INSERT INTO voicewake_routing_config (
          config_key, version, default_target_mode, default_target_agent_id,
          default_target_session_key, updated_at_ms
        ) VALUES ('default', 1, 'agent', 'assistant', NULL, 300);
        INSERT INTO voicewake_routing_routes (
          config_key, position, trigger, target_mode, target_agent_id,
          target_session_key, updated_at_ms
        ) VALUES ('default', 0, 'route wake word', 'session', NULL, 'agent:main:voice', 300);
        INSERT INTO onboarding_recommendations (
          config_key, inventory_hash, matches_json, offered_at_ms, accepted_at_ms, updated_at_ms
        ) VALUES
          ('workspace-a', 'inventory-a', '[{"candidateId":"first"}]', 400, 401, 402),
          ('workspace-b', 'inventory-b', '[{"candidateId":"second"}]', 500, NULL, 501),
          ('workspace-existing', 'old-inventory', '[]', 600, NULL, 601);
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
          VALUES ('onboarding.recommendations.workspace-existing', '{"newer":true}', 999);
        INSERT INTO skill_curator_state (
          id, last_attempt_at_ms, last_success_at_ms, last_error, last_result_json
        ) VALUES (1, 10, 20, NULL, '{"cached":true}');
        INSERT INTO clawhub_promotions_feed_state (
          state_key, payload_json, updated_at_ms
        ) VALUES ('default', '{"cached":true}', 30);
        INSERT INTO model_catalog_remote (
          id, bundle_json, generated_at, source_url, checked_at
        ) VALUES (1, '{"cached":true}', 40, 'https://example.invalid/catalog', 50);
        INSERT INTO cron_store_epochs (store_key, store_epoch) VALUES ('default', 60);
        INSERT INTO sidebar_sections (section_id, position) VALUES
          ('category:projects', 1),
          ('ungrouped', 0);
        INSERT INTO node_host_config (
          config_key, version, node_id, token, display_name, gateway_host,
          gateway_port, gateway_tls, gateway_tls_fingerprint, gateway_context_path,
          gateway_cloudflare_access_json, installed_apps_sharing, updated_at_ms
        ) VALUES (
          'current', 1, 'node-42', 'retired-token', 'Build Node', 'gateway.example',
          443, 1, 'fingerprint-42', '/openclaw-gw',
          '{"clientId":"access-id","clientSecret":"access-secret"}', 1, 700
        );
        INSERT INTO web_push_vapid_keys (
          key_id, public_key, private_key, subject, updated_at_ms
        ) VALUES ('default', 'public-vapid-key', 'private-vapid-key', 'https://openclaw.ai', 800);
        INSERT INTO tui_last_sessions (scope_key, session_key, updated_at)
          VALUES ('cached-scope', 'agent:main:cached', 900);
      `);
      legacy.close();

      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
        kind: "singleton-state-foldin-v12",
        path: databasePath,
      });
      if (migrationPath === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
          changes: [
            "Folded singleton state tables into config_machine_state (v12)",
            "Qualified historical cron creator attribution as unknown (v14)",
          ],
          warnings: [],
        });
      }

      const migrated = openOpenClawStateDatabase(options);
      expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(
        migrated.db
          .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      for (const tableName of FOLDED_STATE_TABLES_V12) {
        expect(
          migrated.db
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .get(tableName),
        ).toBeUndefined();
      }
      expect(readConfigMachineState("update.checkState", options)).toEqual({
        lastCheckedAt: "2026-08-20T00:00:00.000Z",
        lastNotifiedVersion: "2026.8.19",
        lastNotifiedTag: "stable",
        lastAvailableVersion: "2026.8.20",
        lastAvailableTag: "beta",
        autoInstallId: "installation-42",
        autoFirstSeenVersion: "2026.8.18",
        autoFirstSeenTag: "stable",
        autoFirstSeenAt: "2026-08-18T00:00:00.000Z",
        autoLastAttemptVersion: "2026.8.19",
        autoLastAttemptAt: "2026-08-19T00:00:00.000Z",
        autoLastSuccessVersion: "2026.8.17",
        autoLastSuccessAt: "2026-08-17T00:00:00.000Z",
      });
      expect(readConfigMachineState("voicewake.triggers", options)).toEqual([
        "first wake word",
        "second wake word",
      ]);
      expect(readConfigMachineState("voicewake.routing", options)).toEqual({
        version: 1,
        defaultTarget: { agentId: "assistant" },
        routes: [{ trigger: "route wake word", target: { sessionKey: "agent:main:voice" } }],
        updatedAtMs: 300,
      });
      expect(readConfigMachineState("onboarding.recommendations.workspace-a", options)).toEqual({
        inventoryHash: "inventory-a",
        matches: [{ candidateId: "first" }],
        offeredAt: 400,
        acceptedAt: 401,
        updatedAt: 402,
      });
      expect(readConfigMachineState("onboarding.recommendations.workspace-b", options)).toEqual({
        inventoryHash: "inventory-b",
        matches: [{ candidateId: "second" }],
        offeredAt: 500,
        acceptedAt: null,
        updatedAt: 501,
      });
      expect(
        readConfigMachineState("onboarding.recommendations.workspace-existing", options),
      ).toEqual({ newer: true });
      expect(readConfigMachineState("sidebar.sectionOrder", options)).toEqual([
        "ungrouped",
        "category:projects",
      ]);
      expect(readConfigMachineStateWithMetadata("nodeHost.config", options)).toEqual({
        value: {
          version: 1,
          nodeId: "node-42",
          displayName: "Build Node",
          gateway: {
            host: "gateway.example",
            port: 443,
            tls: true,
            tlsFingerprint: "fingerprint-42",
            contextPath: "/openclaw-gw",
            cloudflareAccess: { clientId: "access-id", clientSecret: "access-secret" },
          },
          installedAppsSharing: true,
        },
        updatedAtMs: 700,
      });
      expect(readConfigMachineStateWithMetadata("webPush.vapidKeys", options)).toEqual({
        value: {
          publicKey: "public-vapid-key",
          privateKey: "private-vapid-key",
          subject: "https://openclaw.ai",
        },
        updatedAtMs: 800,
      });
      expect(readConfigMachineState("tui.lastSession.cached-scope", options)).toBeUndefined();
      expect(readConfigMachineState("skills.curatorState", options)).toBeUndefined();
      expect(readConfigMachineState("clawhub.promotionsFeed", options)).toBeUndefined();
      expect(readConfigMachineState("modelCatalog.remote", options)).toBeUndefined();
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).not.toContainEqual({
        kind: "singleton-state-foldin-v12",
        path: databasePath,
      });
    },
  );

  it.each(["runtime open", "doctor repair"] as const)(
    "migrates v12 wide rows to canonical JSON through %s without changing hydrated jobs",
    (migrationPath) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
      legacy.exec("DROP TABLE gateway_origin_device_tokens;");

      const job = {
        id: "legacy-wide-job",
        name: "Legacy wide job",
        description: "preserved cron configuration",
        enabled: true,
        declarationKey: "legacy-declaration",
        owner: { agentId: "legacy-owner" },
        createdAtMs: 100,
        updatedAtMs: 250,
        agentId: "legacy-agent",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "hello" },
        delivery: {
          mode: "announce",
          channel: "telegram",
          failureDestination: { channel: "slack", to: null },
        },
      };
      const storeKey = path.join(stateDir, "cron", "jobs.json");
      legacy
        .prepare(
          `INSERT INTO cron_jobs (
             store_key, job_id, declaration_key, owner_agent_id, name, description,
             enabled, created_at_ms, agent_id, payload_kind, job_json, state_json,
             runtime_updated_at_ms, schedule_identity, sort_order, updated_at,
             schedule_kind, every_ms, session_target, wake_mode, payload_message,
             delivery_mode, delivery_channel, failure_delivery_mode,
             failure_delivery_channel, failure_delivery_to, failure_delivery_account_id,
             last_run_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          storeKey,
          job.id,
          "legacy-declaration",
          "legacy-owner",
          job.name,
          job.description,
          1,
          job.createdAtMs,
          job.agentId,
          job.payload.kind,
          JSON.stringify(job),
          JSON.stringify({ lastStatus: "error" }),
          job.updatedAtMs,
          "every:60000",
          4,
          job.updatedAtMs,
          job.schedule.kind,
          job.schedule.everyMs,
          job.sessionTarget,
          job.wakeMode,
          job.payload.message,
          job.delivery.mode,
          job.delivery.channel,
          "announce",
          "discord",
          "https://example.invalid/failure",
          "",
          "ok",
        );
      const authoritySchemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
        "CREATE TABLE IF NOT EXISTS cron_job_runtime_authorities (",
      );
      const authoritySchemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
        "\n) STRICT;",
        authoritySchemaStart,
      );
      legacy.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(authoritySchemaStart, authoritySchemaEnd + 10));
      legacy
        .prepare(
          `INSERT INTO cron_job_runtime_authorities (
             store_key, job_id, authority_json, authority_input_fingerprint, recovery_required
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(storeKey, job.id, '{"owner":"preserved"}', "preserved-fingerprint", 0);
      const runPayload = {
        runId: "legacy-run",
        childSessionKey: "agent:child:legacy",
        requesterSessionKey: "agent:main:legacy",
        task: "preserved subagent task",
      };
      legacy
        .prepare(
          `INSERT INTO subagent_runs (
             run_id, child_session_key, controller_session_key, requester_session_key,
             created_at, payload_json, task, requester_display_key, cleanup
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runPayload.runId,
          runPayload.childSessionKey,
          "agent:controller:legacy",
          runPayload.requesterSessionKey,
          200,
          JSON.stringify(runPayload),
          runPayload.task,
          "legacy-requester",
          "keep",
        );
      legacy
        .prepare(
          `INSERT INTO workspace_setup_state (
             workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at,
             updated_at
           ) VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(
          "wk-setup",
          "/tmp/wk-setup",
          "2026-07-15T10:00:00.000Z",
          "2026-07-15T10:01:00.000Z",
          500,
        );
      const insertLegacyAttestation = legacy.prepare(
        "INSERT INTO workspace_attestations (workspace_key, attested_at_ms, updated_at_ms) VALUES (?, ?, ?)",
      );
      insertLegacyAttestation.run("wk-setup", 1_000, 1_100);
      insertLegacyAttestation.run("wk-alias", 2_000, 2_100);
      insertLegacyAttestation.run("wk-orphan", 3_000, 3_100);
      legacy
        .prepare(
          `INSERT INTO workspace_path_aliases (
             alias_key, alias_path, workspace_key, workspace_path, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run("wk-alias-link", "/tmp/wk-alias-link", "wk-alias", "/tmp/wk-alias", 2_200);
      const insertLegacyHash = legacy.prepare(
        "INSERT INTO workspace_generated_bootstrap_hashes (workspace_key, filename, sha256) VALUES (?, ?, ?)",
      );
      insertLegacyHash.run("wk-setup", "AGENTS.md", "a".repeat(64));
      insertLegacyHash.run("wk-alias", "TOOLS.md", "b".repeat(64));
      insertLegacyHash.run("wk-orphan", "USER.md", "c".repeat(64));
      const sharedStoreJson = JSON.stringify({
        version: 1,
        profiles: { "openai:default": { type: "api_key", provider: "openai", key: "sk-shared" } },
      });
      const sharedStateJson = JSON.stringify({
        version: 1,
        order: { openai: ["openai:default"] },
      });
      const insertLegacyAuthStore = legacy.prepare(
        "INSERT INTO auth_profile_stores (store_key, store_json, updated_at) VALUES (?, ?, ?)",
      );
      insertLegacyAuthStore.run("shared", sharedStoreJson, 91);
      insertLegacyAuthStore.run("stray", '{"version":1,"profiles":{}}', 93);
      legacy
        .prepare(
          "INSERT INTO auth_profile_state (store_key, state_json, updated_at) VALUES (?, ?, ?)",
        )
        .run("shared", sharedStateJson, 92);
      legacy.close();

      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
        kind: "state-consolidation-v13",
        path: databasePath,
      });
      if (migrationPath === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
          changes: [
            "Consolidated shared state tables (v13)",
            "Qualified historical cron creator attribution as unknown (v14)",
          ],
          warnings: [],
        });
      }

      const migrated = openOpenClawStateDatabase(options);
      expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(collectSqliteSchemaShape(migrated.db).gateway_origin_device_tokens).toEqual(
        createInitialStateSchemaShape().gateway_origin_device_tokens,
      );
      const cronColumns = migrated.db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{
        name: string;
      }>;
      expect(cronColumns.map((column) => column.name)).toEqual([
        "store_key",
        "job_id",
        "declaration_key",
        "owner_agent_id",
        "name",
        "description",
        "enabled",
        "agent_id",
        "payload_kind",
        "job_json",
        "state_json",
        "runtime_updated_at_ms",
        "schedule_identity",
        "sort_order",
        "updated_at",
      ]);
      expect(
        migrated.db
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'index'
                AND name IN (
                  'idx_cron_jobs_store_updated',
                  'idx_cron_jobs_enabled_next_run',
                  'idx_cron_jobs_store_order'
                )
              ORDER BY name`,
          )
          .all(),
      ).toEqual([{ name: "idx_cron_jobs_store_order" }]);
      const runColumns = migrated.db.prepare("PRAGMA table_info(subagent_runs)").all() as Array<{
        name: string;
      }>;
      expect(runColumns.map((column) => column.name)).toEqual([
        "run_id",
        "child_session_key",
        "controller_session_key",
        "requester_session_key",
        "created_at",
        "payload_json",
      ]);
      const row = migrated.db
        .prepare(
          `SELECT declaration_key, owner_agent_id, agent_id, payload_kind,
                  runtime_updated_at_ms, schedule_identity, sort_order, job_json, state_json
             FROM cron_jobs WHERE job_id = ?`,
        )
        .get(job.id) as {
        declaration_key: string;
        owner_agent_id: string;
        agent_id: string;
        payload_kind: string;
        runtime_updated_at_ms: number;
        schedule_identity: string;
        sort_order: number;
        job_json: string;
        state_json: string;
      };
      expect(row).toMatchObject({
        declaration_key: "legacy-declaration",
        owner_agent_id: "legacy-owner",
        agent_id: "legacy-agent",
        payload_kind: "agentTurn",
        runtime_updated_at_ms: 250,
        schedule_identity: "every:60000",
        sort_order: 4,
      });
      expect(JSON.parse(row.job_json).delivery.failureDestination).toEqual({
        mode: "announce",
        channel: "slack",
        to: null,
        accountId: null,
      });
      expect(JSON.parse(row.state_json)).toEqual({
        lastStatus: "error",
        lastRunStatus: "error",
      });
      expect(loadedCronStoreFromRows(loadCronRows(migrated.db, storeKey)).store.jobs).toEqual([
        {
          ...job,
          declarationKey: "legacy-declaration",
          owner: { agentId: "legacy-owner" },
          delivery: {
            ...job.delivery,
            failureDestination: {
              mode: "announce",
              channel: "slack",
              to: undefined,
              accountId: undefined,
            },
          },
          state: { lastStatus: "error", lastRunStatus: "error" },
        },
      ]);
      expect(
        migrated.db
          .prepare(
            `SELECT store_key, job_id, authority_json, authority_input_fingerprint,
                    recovery_required
               FROM cron_job_runtime_authorities WHERE job_id = ?`,
          )
          .get(job.id),
      ).toEqual({
        store_key: storeKey,
        job_id: job.id,
        authority_json: '{"owner":"preserved"}',
        authority_input_fingerprint: "preserved-fingerprint",
        recovery_required: 0,
      });
      expect(
        migrated.db.prepare("SELECT * FROM subagent_runs WHERE run_id = ?").get(runPayload.runId),
      ).toEqual({
        run_id: runPayload.runId,
        child_session_key: runPayload.childSessionKey,
        controller_session_key: "agent:controller:legacy",
        requester_session_key: runPayload.requesterSessionKey,
        created_at: 200,
        payload_json: JSON.stringify(runPayload),
      });
      expect(
        migrated.db
          .prepare(
            `SELECT workspace_key, workspace_path, version, bootstrap_seeded_at,
                    setup_completed_at, updated_at, attested_at_ms, attestation_updated_at_ms
               FROM workspace_setup_state ORDER BY workspace_key`,
          )
          .all(),
      ).toEqual([
        {
          workspace_key: "wk-alias",
          workspace_path: "/tmp/wk-alias",
          version: null,
          bootstrap_seeded_at: null,
          setup_completed_at: null,
          updated_at: null,
          attested_at_ms: 2_000,
          attestation_updated_at_ms: 2_100,
        },
        {
          workspace_key: "wk-orphan",
          workspace_path: null,
          version: null,
          bootstrap_seeded_at: null,
          setup_completed_at: null,
          updated_at: null,
          attested_at_ms: 3_000,
          attestation_updated_at_ms: 3_100,
        },
        {
          workspace_key: "wk-setup",
          workspace_path: "/tmp/wk-setup",
          version: 1,
          bootstrap_seeded_at: "2026-07-15T10:00:00.000Z",
          setup_completed_at: "2026-07-15T10:01:00.000Z",
          updated_at: 500,
          attested_at_ms: 1_000,
          attestation_updated_at_ms: 1_100,
        },
      ]);
      expect(
        migrated.db
          .prepare(
            `SELECT workspace_key, filename, sha256 FROM workspace_generated_bootstrap_hashes
              ORDER BY workspace_key`,
          )
          .all(),
      ).toEqual([
        { workspace_key: "wk-alias", filename: "TOOLS.md", sha256: "b".repeat(64) },
        { workspace_key: "wk-orphan", filename: "USER.md", sha256: "c".repeat(64) },
        { workspace_key: "wk-setup", filename: "AGENTS.md", sha256: "a".repeat(64) },
      ]);
      expect(
        migrated.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_attestations'",
          )
          .all(),
      ).toEqual([]);
      expect(
        migrated.db
          .prepare(
            `SELECT value_json, updated_at_ms FROM config_machine_state
              WHERE state_key = 'authProfiles.store'`,
          )
          .get(),
      ).toEqual({ value_json: sharedStoreJson, updated_at_ms: 91 });
      expect(
        migrated.db
          .prepare(
            `SELECT value_json, updated_at_ms FROM config_machine_state
              WHERE state_key = 'authProfiles.state'`,
          )
          .get(),
      ).toEqual({ value_json: sharedStateJson, updated_at_ms: 92 });
      expect(
        migrated.db
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name IN ('auth_profile_stores', 'auth_profile_state')`,
          )
          .all(),
      ).toEqual([]);
      expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
    },
  );

  it.each(["runtime open", "doctor repair"] as const)(
    "preserves malformed cron JSON for quarantine through the v13 %s",
    (migrationPath) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
      const insert = legacy.prepare(
        `INSERT INTO cron_jobs (
           store_key, job_id, name, enabled, created_at_ms, schedule_kind, schedule_expr,
           session_target, wake_mode, payload_kind, payload_message, job_json, state_json,
           sort_order, updated_at
         ) VALUES (?, ?, ?, 1, 1, 'cron', '0 6 * * *', 'main', 'now',
                   'systemEvent', 'tick', ?, ?, ?, 1)`,
      );
      const storeKey = path.join(stateDir, "cron", "jobs.json");
      insert.run(storeKey, "malformed-job", "Malformed job", "{", "{}", 0);
      insert.run(
        storeKey,
        "malformed-state",
        "Malformed state",
        '{"id":"malformed-state"}',
        "[]",
        1,
      );
      legacy.close();

      if (migrationPath === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options).changes).toContain(
          "Consolidated shared state tables (v13)",
        );
      }
      const migrated = openOpenClawStateDatabase(options);
      expect(
        migrated.db
          .prepare("SELECT job_id, job_json, state_json FROM cron_jobs ORDER BY sort_order, job_id")
          .all(),
      ).toEqual([
        { job_id: "malformed-job", job_json: "{", state_json: "{}" },
        { job_id: "malformed-state", job_json: '{"id":"malformed-state"}', state_json: "[]" },
      ]);
      expect(migrated.db.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      closeOpenClawStateDatabaseForTest();
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare("SELECT COUNT(*) AS count FROM cron_jobs")
          .get(),
      ).toEqual({ count: 2 });
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
    },
  );

  it.each(
    (["runtime open", "doctor repair"] as const).flatMap((migrationPath) => [
      [migrationPath, "install_records_json", "[]"],
      [migrationPath, "plugins_json", "{}"],
      [migrationPath, "diagnostics_json", "{"],
    ]) as Array<
      readonly [
        "runtime open" | "doctor repair",
        "install_records_json" | "plugins_json" | "diagnostics_json",
        string,
      ]
    >,
  )(
    "drops an invalid plugin-index cache during v13 %s when %s is invalid",
    (migrationPath, column, value) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
      const values = {
        install_records_json: "{}",
        plugins_json: "[]",
        diagnostics_json: "[]",
        [column]: value,
      };
      legacy
        .prepare(
          `INSERT INTO installed_plugin_index (
           index_key, version, host_contract_version, compat_registry_version,
           migration_version, policy_hash, generated_at_ms, install_records_json,
           plugins_json, diagnostics_json, updated_at_ms
         ) VALUES ('installed-plugin-index', 1, 'host', 'compat', 1, 'policy', 10, ?, ?, ?, 11)`,
        )
        .run(values.install_records_json, values.plugins_json, values.diagnostics_json);
      legacy.close();

      if (migrationPath === "doctor repair") {
        repairOpenClawStateDatabaseSchema(options);
      }
      const migrated = openOpenClawStateDatabase(options);
      expect(
        migrated.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'installed_plugin_index'")
          .get(),
      ).toBeUndefined();
      expect(
        migrated.db
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.installedIndex'",
          )
          .get(),
      ).toBeUndefined();
      expect(migrated.db.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      closeOpenClawStateDatabaseForTest();
      expect(readSqliteNumberPragma(openOpenClawStateDatabase(options).db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
    },
  );

  it("reprojects canonical cron JSON into the complete v12 downgrade contract", async () => {
    await withOpenClawTestState(
      { layout: "state-only", applyEnv: true, prefix: "openclaw-v13-downgrade-" },
      async ({ stateDir }) => {
        materializeCurrentStateDatabase(stateDir);
        const storePath = path.join(stateDir, "cron", "jobs.json");
        const base = {
          enabled: true,
          createdAtMs: 100,
          updatedAtMs: 200,
          sessionTarget: "main" as const,
          wakeMode: "now" as const,
          state: {},
        };
        const jobs = [
          {
            ...base,
            id: "at-system-event",
            name: "At system event",
            deleteAfterRun: false,
            schedule: { kind: "at", at: "2026-08-27T12:00:00.000Z" },
            payload: { kind: "systemEvent", text: "tick", toolsAllow: [] },
            failureAlert: false,
          },
          {
            ...base,
            id: "every-agent-turn",
            name: "Every agent turn",
            displayName: "Every display",
            owner: { agentId: "owner-agent", sessionKey: "agent:owner:main" },
            agentId: "worker",
            sessionKey: "agent:worker:cron",
            schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
            sessionTarget: "isolated",
            payload: {
              kind: "agentTurn",
              message: "hello",
              model: "openai/gpt-5.6-luna",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
              thinking: "medium",
              timeoutSeconds: 30,
              allowUnsafeExternalContent: false,
              externalContentSource: "webhook",
              lightContext: false,
              toolsAllow: ["read"],
              toolsAllowIsDefault: false,
            },
            delivery: {
              mode: "announce",
              channel: "telegram",
              to: "chat",
              threadId: 42,
              accountId: "account",
              bestEffort: false,
              completionDestination: { mode: "webhook", to: "https://example.invalid/done" },
              failureDestination: {
                mode: undefined,
                channel: "discord",
                to: undefined,
                accountId: "ops",
              },
            },
            failureAlert: {},
            state: {
              nextRunAtMs: 300,
              runningAtMs: 301,
              lastRunAtMs: 302,
              lastRunStatus: "ok",
              lastError: "old error",
              lastDurationMs: 303,
              consecutiveErrors: 0,
              consecutiveSkipped: 2,
              scheduleErrorCount: 1,
              lastDeliveryStatus: "delivered",
              lastDeliveryError: "old delivery error",
              lastDelivered: false,
              lastFailureAlertAtMs: 304,
            },
          },
          {
            ...base,
            id: "cron-command",
            name: "Cron command",
            schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC", staggerMs: 500 },
            trigger: { script: "return true", once: false },
            payload: {
              kind: "command",
              argv: ["echo", "hello"],
              cwd: "/tmp",
              env: { LANG: "C" },
              input: "stdin",
              timeoutSeconds: 10,
              noOutputTimeoutSeconds: 5,
              outputMaxBytes: 1024,
            },
          },
          {
            ...base,
            id: "exit-script",
            name: "Exit script",
            schedule: { kind: "on-exit", command: "sleep 1", cwd: "/tmp" },
            payload: { kind: "script", script: "return 1", timeoutSeconds: 11, toolBudget: 3 },
          },
          {
            ...base,
            id: "stream-heartbeat",
            name: "Stream heartbeat",
            schedule: { kind: "stream", command: ["tail", "-f", "events.log"] },
            payload: { kind: "heartbeat" },
          },
        ] satisfies CronStoredJob[];
        await saveCronStore(storePath, { version: 1, jobs });
        closeOpenClawStateDatabaseForTest();

        const { DatabaseSync } = requireNodeSqlite();
        const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
        const db = new DatabaseSync(databasePath);
        const canonicalRows = db
          .prepare("SELECT job_id, job_json, state_json FROM cron_jobs ORDER BY sort_order")
          .all();
        const authoritySchemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
          "CREATE TABLE IF NOT EXISTS cron_job_runtime_authorities (",
        );
        const authoritySchemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
          "\n) STRICT;",
          authoritySchemaStart,
        );
        db.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(authoritySchemaStart, authoritySchemaEnd + 10));
        db.prepare(
          `INSERT INTO cron_job_runtime_authorities (
             store_key, job_id, authority_json, authority_input_fingerprint, recovery_required
           ) VALUES (?, ?, '{}', 'fingerprint', 0)`,
        ).run(path.resolve(storePath), "every-agent-turn");
        db.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);

        expect(
          db
            .prepare(
              `SELECT schedule_kind, schedule_expr, schedule_tz, every_ms, anchor_ms, at,
                    stagger_ms, payload_kind, payload_message, failure_alert_disabled
               FROM cron_jobs ORDER BY sort_order`,
            )
            .all(),
        ).toMatchObject([
          {
            schedule_kind: "at",
            at: "2026-08-27T12:00:00.000Z",
            payload_kind: "systemEvent",
            payload_message: "tick",
            failure_alert_disabled: 1,
          },
          {
            schedule_kind: "every",
            every_ms: 60_000,
            anchor_ms: 1_000,
            payload_kind: "agentTurn",
            payload_message: "hello",
            failure_alert_disabled: 0,
          },
          {
            schedule_kind: "cron",
            schedule_expr: "0 6 * * *",
            schedule_tz: "UTC",
            stagger_ms: 500,
            payload_kind: "command",
          },
          {
            schedule_kind: "on-exit",
            schedule_expr: "sleep 1",
            schedule_tz: "/tmp",
            payload_kind: "script",
          },
          { schedule_kind: "stream", payload_kind: "heartbeat" },
        ]);
        const every = db.prepare("SELECT * FROM cron_jobs WHERE job_id = 'every-agent-turn'").get();
        expect(every).toMatchObject({
          display_name: "Every display",
          owner_agent_id: "owner-agent",
          owner_session_key: "agent:owner:main",
          agent_id: "worker",
          session_key: "agent:worker:cron",
          payload_model: "openai/gpt-5.6-luna",
          payload_fallbacks_json: '["anthropic/claude-sonnet-4-6"]',
          payload_timeout_seconds: 30,
          payload_allow_unsafe_external_content: 0,
          payload_external_content_source_json: '"webhook"',
          payload_light_context: 0,
          payload_tools_allow_json: '["read"]',
          payload_tools_allow_is_default: 0,
          delivery_thread_id: "42",
          delivery_thread_id_type: "number",
          delivery_best_effort: 0,
          failure_delivery_mode: "",
          failure_delivery_channel: "discord",
          failure_delivery_to: "",
          failure_delivery_account_id: "ops",
          next_run_at_ms: 300,
          running_at_ms: 301,
          last_run_at_ms: 302,
          last_run_status: "ok",
          last_delivered: 0,
        });
        expect(
          JSON.parse(
            (
              db
                .prepare("SELECT payload_message FROM cron_jobs WHERE job_id = 'cron-command'")
                .get() as { payload_message: string }
            ).payload_message,
          ),
        ).toEqual({
          argv: ["echo", "hello"],
          cwd: "/tmp",
          env: { LANG: "C" },
          input: "stdin",
          noOutputTimeoutSeconds: 5,
          outputMaxBytes: 1024,
        });
        expect(
          db
            .prepare("SELECT job_id, job_json, state_json FROM cron_jobs ORDER BY sort_order")
            .all(),
        ).toEqual(canonicalRows);
        expect(
          db
            .prepare(
              `SELECT name FROM sqlite_schema
              WHERE type = 'index' AND name LIKE 'idx_cron_jobs_%' ORDER BY name`,
            )
            .all(),
        ).toEqual([
          { name: "idx_cron_jobs_agent_session" },
          { name: "idx_cron_jobs_enabled_next_run" },
          { name: "idx_cron_jobs_store_order" },
          { name: "idx_cron_jobs_store_updated" },
        ]);
        expect(
          db
            .prepare(
              "SELECT authority_input_fingerprint FROM cron_job_runtime_authorities WHERE job_id = 'every-agent-turn'",
            )
            .get(),
        ).toEqual({ authority_input_fingerprint: "fingerprint" });
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        db.close();

        const migrated = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: stateDir },
        });
        expect(
          loadedCronStoreFromRows(
            loadCronRows(migrated.db, path.resolve(storePath)),
          ).store.jobs.map((job) => job.id),
        ).toEqual(jobs.map((job) => job.id));
        closeOpenClawStateDatabaseForTest();
        expect(
          readSqliteNumberPragma(
            openOpenClawStateDatabase({
              env: { OPENCLAW_STATE_DIR: stateDir },
            }).db,
            "user_version",
          ),
        ).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      },
    );
  });

  it("refuses to downgrade malformed canonical cron JSON", async () => {
    await withOpenClawTestState(
      { layout: "state-only", applyEnv: true, prefix: "openclaw-v13-downgrade-invalid-" },
      async ({ stateDir }) => {
        materializeCurrentStateDatabase(stateDir);
        const storePath = path.join(stateDir, "cron", "jobs.json");
        await saveCronStore(storePath, {
          version: 1,
          jobs: [
            {
              id: "malformed-downgrade",
              name: "Malformed downgrade",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: { kind: "cron", expr: "0 6 * * *" },
              sessionTarget: "main",
              wakeMode: "now",
              payload: { kind: "systemEvent", text: "tick" },
              state: {},
            },
          ],
        });
        closeOpenClawStateDatabaseForTest();
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(
          resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
        );
        db.prepare("UPDATE cron_jobs SET state_json = '[]'").run();
        expect(() => db.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL)).toThrow(/CHECK constraint/);
        db.exec("ROLLBACK");
        expect(readSqliteNumberPragma(db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
        expect(db.prepare("SELECT state_json FROM cron_jobs").get()).toEqual({ state_json: "[]" });
        db.close();
      },
    );
  });

  it("keeps a pre-existing authProfiles.store KV value over the v13 auth import", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
    legacy
      .prepare(
        "INSERT INTO auth_profile_stores (store_key, store_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("shared", '{"imported":true}', 10);
    legacy
      .prepare(
        `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
         VALUES ('authProfiles.store', ?, 20)`,
      )
      .run('{"kept":true}');
    legacy.close();

    const migrated = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare(
          "SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key = 'authProfiles.store'",
        )
        .get(),
    ).toEqual({ value_json: '{"kept":true}', updated_at_ms: 20 });
    expect(
      migrated.db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'auth_profile_stores'")
        .all(),
    ).toEqual([]);
  });

  it.each(["runtime open", "doctor repair"] as const)(
    "retires v6 commitments through %s while preserving shared leases",
    (migrationPath) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      seedV6CommitmentSchema(legacy);
      legacy.close();

      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
        kind: "commitments-retirement-v7",
        path: databasePath,
      });

      if (migrationPath === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
          changes: [
            "Discarded retired shared-state commitments rows, table, and indexes",
            "Migrated cloud worker placements to execution modes",
            "Qualified historical cron creator attribution as unknown (v14)",
          ],
          warnings: [],
        });
        const repaired = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(readSqliteNumberPragma(repaired, "user_version")).toBe(
            OPENCLAW_STATE_SCHEMA_VERSION,
          );
          expect(
            repaired
              .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
              .get(),
          ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
        } finally {
          repaired.close();
        }
      }
      const migrated = openOpenClawStateDatabase(options);
      if (migrationPath === "runtime open") {
        expect(stateDbLogInfo).toHaveBeenCalledWith(
          "Discarded retired shared-state commitments rows, table, and indexes",
        );
      }

      expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(
        migrated.db
          .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      for (const name of RETIRED_COMMITMENT_SCHEMA_OBJECTS) {
        expect(
          migrated.db.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(name),
        ).toBeUndefined();
      }
      expect(
        migrated.db
          .prepare(
            `SELECT scope, lease_key, owner, expires_at, heartbeat_at, payload_json,
                    created_at, updated_at
               FROM state_leases
              WHERE scope = 'test' AND lease_key = 'preserved-lease'`,
          )
          .get(),
      ).toEqual({
        scope: "test",
        lease_key: "preserved-lease",
        owner: "migration-test",
        expires_at: 100,
        heartbeat_at: 50,
        payload_json: "{}",
        created_at: 1,
        updated_at: 2,
      });
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).not.toContainEqual({
        kind: "commitments-retirement-v7",
        path: databasePath,
      });
    },
  );

  it("logs a destructive retirement only after the schema transaction commits", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    seedV6CommitmentSchema(legacy);
    legacy.exec(`
      CREATE TRIGGER fail_schema_meta_update
      BEFORE UPDATE ON schema_meta
      BEGIN
        SELECT RAISE(ABORT, 'forced migration rollback');
      END;
    `);
    legacy.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow(/forced migration rollback/);
    expect(stateDbLogInfo).not.toHaveBeenCalledWith(
      "Discarded retired shared-state commitments rows, table, and indexes",
    );
    const rolledBack = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        rolledBack.prepare("SELECT name FROM sqlite_schema WHERE name = 'commitments'").get(),
      ).toEqual({ name: "commitments" });
    } finally {
      rolledBack.close();
    }
  });

  // The canonical v6 case above proves both runtime and Doctor orchestration,
  // reporting, and markers; these variants isolate historical layout recognition.
  it.each([
    {
      label: "v6 commitments with missing canonical indexes",
      seed: (database: DatabaseSync) => {
        seedV6CommitmentSchema(database);
        database.exec(`
          DROP INDEX idx_commitments_scope_dedupe;
          DROP INDEX idx_commitments_agent_sent;
        `);
      },
    },
    {
      label: "supported additive v6 commitments layout",
      seed: seedAdditiveV6CommitmentSchema,
    },
    {
      label: "partially additive v6 commitments layout",
      seed: seedPartiallyAdditiveV6CommitmentSchema,
    },
  ])("retires the $label through runtime open", ({ seed }) => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    seed(legacy);
    legacy.close();

    const migrated = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      migrated.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'commitments'").get(),
    ).toBeUndefined();
  });

  it("does not advertise the schema-7 retirement after its execution boundary", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    seedV6CommitmentSchema(database);
    markStateDatabaseVersion(database, 7);
    database.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).not.toContainEqual({
      kind: "commitments-retirement-v7",
      path: databasePath,
    });
  });

  it.each(["runtime open", "doctor repair"] as const)(
    "retires the supported early commitments layout through %s",
    (migrationPath) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const early = new DatabaseSync(databasePath);
      seedEarlyCommitmentSchema(early);
      early.close();

      if (migrationPath === "doctor repair") {
        const result = repairOpenClawStateDatabaseSchema(options);
        expect(result.warnings).toEqual([]);
        expect(result.changes).toContain(
          "Discarded retired shared-state commitments rows, table, and indexes",
        );
      }
      const migrated = openOpenClawStateDatabase(options);
      expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(
        migrated.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'commitments'").get(),
      ).toBeUndefined();
    },
  );

  it("migrates the exact v2026.7.1-2 shared state database through Doctor", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const fixture = materializeV2026_7_1_2StateDatabase(stateDir);
    expect(fixture.compressedSha256).toBe(V2026_7_1_2_STATE_FIXTURE_GZIP_SHA256);
    expect(fixture.rawSha256).toBe(V2026_7_1_2_STATE_FIXTURE_RAW_SHA256);

    const { DatabaseSync } = requireNodeSqlite();
    const released = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(readSqliteNumberPragma(released, "user_version")).toBe(1);
      expect(
        released
          .prepare("SELECT schema_version, app_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: 1, app_version: "2026.7.1" });
      expect(released.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(released.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        released
          .prepare(
            `SELECT
               (SELECT count(*) FROM sqlite_schema
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%') AS tables,
               (SELECT count(*) FROM sqlite_schema
                 WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%') AS indexes,
               (SELECT count(*) FROM pragma_table_list
                 WHERE schema = 'main' AND type = 'table'
                   AND name NOT LIKE 'sqlite_%' AND strict = 1) AS strict_tables`,
          )
          .get(),
      ).toEqual({ tables: 73, indexes: 103, strict_tables: 0 });
      expect(hashSqliteSchema(released)).toBe(V2026_7_1_2_STATE_FIXTURE_SCHEMA_SHA256);
      expect(
        released
          .prepare(
            `SELECT id, agent_id, session_key, channel, status, reason, suggested_text,
                    dedupe_key, due_earliest_ms, due_latest_ms, record_json
               FROM commitments`,
          )
          .all(),
      ).toEqual([
        {
          id: "fixture-commitment",
          agent_id: "fixture-agent",
          session_key: "agent:fixture-agent:main",
          channel: "telegram",
          status: "pending",
          reason: "fixture retirement proof",
          suggested_text: "follow up",
          dedupe_key: "fixture-dedupe",
          due_earliest_ms: 2000,
          due_latest_ms: 3000,
          record_json: '{"fixture":true}',
        },
      ]);
      expect(
        released
          .prepare(
            `SELECT name
               FROM sqlite_schema
              WHERE type = 'index'
                AND name IN (
                  'idx_commitments_scope_due',
                  'idx_commitments_status_due',
                  'idx_commitments_scope_dedupe'
                )
              ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: "idx_commitments_scope_dedupe" },
        { name: "idx_commitments_scope_due" },
        { name: "idx_commitments_status_due" },
      ]);
      expect(
        released
          .prepare(
            `SELECT name
               FROM sqlite_schema
              WHERE name IN (
                'commitments',
                'cron_run_logs',
                'node_pairing_pending',
                'node_pairing_paired',
                'idx_diagnostic_events_scope_created'
              )
              ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: "commitments" },
        { name: "cron_run_logs" },
        { name: "idx_diagnostic_events_scope_created" },
        { name: "node_pairing_paired" },
        { name: "node_pairing_pending" },
      ]);
      expect(
        released
          .prepare("SELECT 1 FROM pragma_table_info('diagnostic_events') WHERE name = 'sequence'")
          .get(),
      ).toBeUndefined();
      for (const tableName of RETIRED_STATE_TABLES_V10) {
        expect(
          released
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .get(tableName),
        ).toEqual({ name: tableName });
      }
    } finally {
      released.close();
    }

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "commitments-retirement-v7", path: fixture.databasePath },
      { kind: "state-table-retirement-v10", path: fixture.databasePath },
      { kind: "state-table-retirement-v11", path: fixture.databasePath },
      { kind: "singleton-state-foldin-v12", path: fixture.databasePath },
      { kind: "state-consolidation-v13", path: fixture.databasePath },
      { kind: "creator-namespace-v14", path: fixture.databasePath },
      { kind: "conversation-binding-targets-v15", path: fixture.databasePath },
      { kind: "audit-events-v2", path: fixture.databasePath },
      { kind: "strict-tables-v3", path: fixture.databasePath },
    ]);
    expectStateSchemaMigrationRequired(() => openOpenClawStateDatabase(options), {
      kind: "audit-events-v2",
      pathname: fixture.databasePath,
    });

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        "Discarded retired shared-state commitments rows, table, and indexes",
        "Retired six dead shared-state tables (v10)",
        "Retired legacy skill curator lifecycle and proposal origin-run tables",
        "Folded singleton state tables into config_machine_state (v12)",
        "Migrated shared state audit event ledger → versioned message lifecycle schema",
        "Consolidated shared state tables (v13)",
        "Qualified historical cron creator attribution as unknown (v14)",
        "Removed redundant conversation binding target projections (v15)",
        "Migrated shared state tables to SQLite STRICT typing (48)",
      ],
      warnings: [],
    });
    const migrated = openOpenClawStateDatabase(options);

    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
    expect(migrated.db.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // The shipped v2026.7.1-2 database really carried these curator projections.
    for (const tableName of ["skill_lifecycle", "skill_workshop_proposal_origin_runs"]) {
      expect(
        migrated.db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(tableName),
      ).toBeUndefined();
    }
    expect(normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(migrated.db))).toEqual(
      normalizeSqliteSchemaShapeSql(createInitialStateSchemaShape()),
    );
    // The fixture's auth_profile_stores row is keyed 'fixture-store', not the
    // production 'shared' key, so the v13 fold drops the table without
    // importing it into the KV.
    expect(
      migrated.db
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      migrated.db
        .prepare(
          "SELECT sequence, event_id, source_id, schema_version, agent_id, run_id FROM audit_events WHERE event_id = ?",
        )
        .get("fixture-audit-event"),
    ).toEqual({
      sequence: 7,
      event_id: "fixture-audit-event",
      source_id: "fixture-source",
      schema_version: 1,
      agent_id: "fixture-agent",
      run_id: "fixture-run",
    });
    expect(
      migrated.db
        .prepare(
          `INSERT INTO audit_events (
             event_id, source_id, source_sequence, occurred_at, kind, action, status,
             actor_type, actor_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "fixture-audit-next",
          "fixture-source-next",
          2,
          1600,
          "message",
          "message.received",
          "succeeded",
          "channel_sender",
          "fixture-sender",
        ).lastInsertRowid,
    ).toBe(41);
    expect(
      migrated.db
        .prepare(
          `SELECT scope, event_key, sequence
             FROM diagnostic_events
            ORDER BY scope, sequence`,
        )
        .all(),
    ).toEqual([
      { scope: "fixture-scope", event_key: "event-a", sequence: 1 },
      { scope: "fixture-scope", event_key: "event-b", sequence: 2 },
      { scope: "other-scope", event_key: "event-c", sequence: 1 },
    ]);
    expect(
      migrated.db
        .prepare(
          `SELECT task_id, runtime, source_id, status, ended_at
             FROM task_runs
            WHERE runtime = 'cron' AND source_id = 'fixture-cron'`,
        )
        .get(),
    ).toEqual({
      task_id: "cron-runlog-import:fixture-cron:1500:1",
      runtime: "cron",
      source_id: "fixture-cron",
      status: "succeeded",
      ended_at: 1500,
    });
    expect(
      migrated.db
        .prepare(
          `SELECT task_runs.task_id, task_runs.status, task_delivery_state.last_notified_event_at
             FROM task_runs
             JOIN task_delivery_state USING (task_id)
            WHERE task_runs.task_id = 'fixture-task'`,
        )
        .get(),
    ).toEqual({
      task_id: "fixture-task",
      status: "completed",
      last_notified_event_at: 1320,
    });
    for (const name of [
      ...RETIRED_COMMITMENT_SCHEMA_OBJECTS,
      ...RETIRED_STATE_TABLES_V10,
      "cron_run_logs",
      "node_pairing_pending",
      "node_pairing_paired",
      "idx_diagnostic_events_scope_created",
    ]) {
      expect(
        migrated.db.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(name),
      ).toBeUndefined();
    }
    expect(
      migrated.db
        .prepare(
          `SELECT type, name
             FROM sqlite_schema
            WHERE lower(name) LIKE '%commitment%'
            ORDER BY type, name`,
        )
        .all(),
    ).toEqual([]);
    expect(
      migrated.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'idx_diagnostic_events_scope_sequence'",
        )
        .get(),
    ).toEqual({ name: "idx_diagnostic_events_scope_sequence" });

    closeOpenClawStateDatabaseForTest();
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({ changes: [], warnings: [] });
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
    const reopened = openOpenClawStateDatabase(options);
    expect(reopened.db.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
    expect(reopened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["runtime open", "doctor repair"] as const)(
    "refuses retirement and leaves a foreign commitments table and colliding index unchanged through %s",
    (migrationPath) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const foreign = new DatabaseSync(databasePath);
      foreign.exec(`
        CREATE TABLE commitments (
          id TEXT NOT NULL PRIMARY KEY,
          agent_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          channel TEXT NOT NULL,
          status TEXT NOT NULL,
          due_earliest_ms INTEGER NOT NULL,
          due_latest_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          record_json TEXT NOT NULL
        );
        CREATE INDEX foreign_commitments_status ON commitments(status);
        CREATE TABLE foreign_commitment_index_owner (marker TEXT NOT NULL) STRICT;
        CREATE INDEX idx_commitments_scope_due
          ON foreign_commitment_index_owner(marker);
      `);
      markStateDatabaseVersion(foreign, 6);
      foreign.close();

      if (migrationPath === "doctor repair") {
        const result = repairOpenClawStateDatabaseSchema(options);
        expect(result.changes).toEqual([]);
        expect(result.warnings.join("\n")).toMatch(/commitments/u);
      } else {
        expect(() => openOpenClawStateDatabase(options)).toThrow(/commitments/u);
      }

      const preserved = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(readSqliteNumberPragma(preserved, "user_version")).toBe(6);
        expect(
          preserved
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get(),
        ).toEqual({ schema_version: 6 });
        expect(
          preserved.prepare("SELECT name FROM sqlite_schema WHERE name = 'commitments'").get(),
        ).toEqual({ name: "commitments" });
        expect(
          preserved
            .prepare("SELECT tbl_name FROM sqlite_schema WHERE name = 'foreign_commitments_status'")
            .get(),
        ).toEqual({ tbl_name: "commitments" });
        expect(
          preserved
            .prepare("SELECT tbl_name FROM sqlite_schema WHERE name = 'idx_commitments_scope_due'")
            .get(),
        ).toEqual({ tbl_name: "foreign_commitment_index_owner" });
      } finally {
        preserved.close();
      }
    },
  );

  it.each([
    {
      label: "extra index",
      name: "foreign_commitments_status",
      sql: "CREATE INDEX foreign_commitments_status ON commitments(status);",
      type: "index",
    },
    {
      label: "attached trigger",
      name: "foreign_commitments_delete",
      sql: `CREATE TRIGGER foreign_commitments_delete
              AFTER DELETE ON commitments BEGIN SELECT 1; END;`,
      type: "trigger",
    },
    {
      label: "drifted optional agent-due index",
      name: "idx_commitments_agent_due",
      sql: `DROP INDEX idx_commitments_agent_due;
            CREATE INDEX idx_commitments_agent_due
              ON commitments(agent_id, status, session_key);`,
      type: "index",
    },
  ])(
    "refuses retirement and leaves an $label unchanged on the final v6 commitments layout",
    ({ name, sql, type }) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const customized = new DatabaseSync(databasePath);
      seedV6CommitmentSchema(customized);
      customized.exec(sql);
      customized.close();

      expect(() => openOpenClawStateDatabase(options)).toThrow(/commitments/u);

      const preserved = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(readSqliteNumberPragma(preserved, "user_version")).toBe(6);
        expect(
          preserved.prepare("SELECT name FROM sqlite_schema WHERE name = 'commitments'").get(),
        ).toEqual({ name: "commitments" });
        expect(
          preserved.prepare("SELECT type, tbl_name FROM sqlite_schema WHERE name = ?").get(name),
        ).toEqual({ type, tbl_name: "commitments" });
      } finally {
        preserved.close();
      }
    },
  );

  it.each(["runtime open", "doctor repair"] as const)(
    "refuses retirement and leaves an inbound foreign-key dependency unchanged through %s",
    (migrationPath) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const dependent = new DatabaseSync(databasePath);
      seedV6CommitmentSchema(dependent);
      dependent.exec(`
        CREATE TABLE sqliteX_dependents (
          id TEXT NOT NULL PRIMARY KEY,
          commitment_id TEXT NOT NULL REFERENCES commitments(id) ON DELETE CASCADE
        ) STRICT;
        INSERT INTO sqliteX_dependents (id, commitment_id)
        VALUES ('dependent-row', 'retired-commitment');
      `);
      dependent.close();

      if (migrationPath === "doctor repair") {
        const result = repairOpenClawStateDatabaseSchema(options);
        expect(result.changes).toEqual([]);
        expect(result.warnings.join("\n")).toMatch(/referenced by table sqliteX_dependents/iu);
      } else {
        expect(() => openOpenClawStateDatabase(options)).toThrow(
          /referenced by table sqliteX_dependents/iu,
        );
      }

      const preserved = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(readSqliteNumberPragma(preserved, "user_version")).toBe(6);
        expect(preserved.prepare("SELECT id FROM commitments").all()).toEqual([
          { id: "retired-commitment" },
        ]);
        expect(preserved.prepare("SELECT id, commitment_id FROM sqliteX_dependents").all()).toEqual(
          [{ id: "dependent-row", commitment_id: "retired-commitment" }],
        );
      } finally {
        preserved.close();
      }
    },
  );

  it.each([
    {
      name: "commitment_projection",
      sql: "CREATE VIEW commitment_projection AS SELECT id FROM 'commitments';",
      type: "view",
    },
    {
      name: "lease_commitment_cleanup",
      sql: `CREATE TRIGGER lease_commitment_cleanup
              AFTER DELETE ON state_leases
              BEGIN DELETE FROM [commitments] WHERE id = OLD.lease_key; END;`,
      type: "trigger",
    },
    {
      name: "lease_commitment_update",
      sql: `CREATE TRIGGER lease_commitment_update
              UPDATE OF owner ON state_leases
              BEGIN DELETE FROM commitments WHERE id = OLD.lease_key; END;`,
      type: "trigger",
    },
    {
      name: "rowid_commitment_update",
      sql: `CREATE TABLE rowid_dependency_owner (value TEXT) STRICT;
            CREATE TRIGGER rowid_commitment_update
              AFTER UPDATE OF rowid ON rowid_dependency_owner
              BEGIN DELETE FROM commitments WHERE id = 'retired-commitment'; END;`,
      type: "trigger",
    },
  ])(
    "refuses retirement and leaves a cross-object $type dependency on commitments unchanged",
    ({ name, sql, type }) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);
      const { DatabaseSync } = requireNodeSqlite();
      const dependent = new DatabaseSync(databasePath);
      seedV6CommitmentSchema(dependent);
      dependent.exec(sql);
      dependent.close();

      expect(() => openOpenClawStateDatabase(options)).toThrow(
        new RegExp(`referenced by ${type} ${name}`, "iu"),
      );

      const preserved = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(readSqliteNumberPragma(preserved, "user_version")).toBe(6);
        expect(
          preserved.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(name),
        ).toEqual({
          name,
        });
        expect(preserved.prepare("SELECT id FROM commitments").all()).toEqual([
          { id: "retired-commitment" },
        ]);
      } finally {
        preserved.close();
      }
    },
  );

  it("refuses retirement and leaves an external-content virtual table dependency unchanged", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const dependent = new DatabaseSync(databasePath);
    seedV6CommitmentSchema(dependent);
    dependent.exec(`
      create virtual table commitment_search USING fts5(
        suggested_text,
        content='commitments',
        content_rowid='rowid'
      );
    `);
    dependent.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /SQLite virtual table commitment_search is unusable/iu,
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readSqliteNumberPragma(preserved, "user_version")).toBe(6);
      expect(
        preserved.prepare("SELECT name FROM sqlite_schema WHERE name = 'commitment_search'").get(),
      ).toEqual({ name: "commitment_search" });
      expect(preserved.prepare("SELECT id FROM commitments").all()).toEqual([
        { id: "retired-commitment" },
      ]);
    } finally {
      preserved.close();
    }
  });

  it("keeps unrelated schema identifiers named commitments usable", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const unrelated = new DatabaseSync(databasePath);
    seedV6CommitmentSchema(unrelated);
    unrelated.exec("CREATE VIEW commitment_metrics AS SELECT 1 AS commitments;");
    unrelated.close();

    const migrated = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(migrated.db.prepare("SELECT commitments FROM commitment_metrics").get()).toEqual({
      commitments: 1,
    });
  });

  it("refuses retirement when a broken retained view makes dependency resolution ambiguous", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    seedV6CommitmentSchema(legacy);
    legacy.exec("CREATE VIEW unrelated_broken_view AS SELECT id FROM missing_unrelated_table;");
    legacy.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /Could not prove retained SQLite views and triggers independent of commitments/iu,
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readSqliteNumberPragma(preserved, "user_version")).toBe(6);
      expect(
        preserved
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated_broken_view'")
          .get(),
      ).toEqual({ name: "unrelated_broken_view" });
      expect(preserved.prepare("SELECT id FROM commitments").all()).toEqual([
        { id: "retired-commitment" },
      ]);
    } finally {
      preserved.close();
    }
  });

  it("keeps the additive worker SSH fallback table compatible with older v6 containment", () => {
    const database = openMaterializedCurrentStateDatabase();
    try {
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("worker_environment_ssh_fallback_ports"),
      ).toEqual({ name: "worker_environment_ssh_fallback_ports" });
      expect(() =>
        assertSqliteSchemaContains(
          database,
          "older v6 state database",
          createOlderV6StateSchemaWithoutWorkerSshFallbackPorts(),
          { allowedMissingTables: FIRST_USE_STATE_TABLES },
        ),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("skips exclusive repair when the automatic schema gate is already current", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const before = new DatabaseSync(databasePath);
    before.prepare("UPDATE schema_meta SET updated_at = 123 WHERE meta_key = 'primary'").run();
    before.close();

    expect(repairOpenClawStateDatabaseSchemaIfNeeded(options)).toEqual({
      changes: [],
      warnings: [],
    });

    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        after.prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ updated_at: 123 });
    } finally {
      after.close();
    }
  });

  it("drops unreleased transient verification history on open", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const transientHistoryTable = ["database", "verifications"].join("_");
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE ${transientHistoryTable} (path TEXT PRIMARY KEY) STRICT;`);
    markStateDatabaseAsPreviousAppVersion(legacy);
    legacy.close();

    const reopened = openOpenClawStateDatabase(options);
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(transientHistoryTable),
    ).toBeUndefined();
  });

  it("adopts a canonical device identity seed database without losing the identity", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const seed = new DatabaseSync(databasePath);
    seed.exec(`
CREATE TABLE device_identities (
  identity_key TEXT NOT NULL PRIMARY KEY,
  device_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  private_key_pem TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_device_identities_device
  ON device_identities(device_id, updated_at_ms DESC);
INSERT INTO device_identities VALUES (
  'primary', 'device-1', 'public-key', 'private-key', 10, 20
);
`);
    seed.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(
      database.db.prepare("SELECT * FROM device_identities WHERE identity_key = 'primary'").get(),
    ).toEqual({
      identity_key: "primary",
      device_id: "device-1",
      public_key_pem: "public-key",
      private_key_pem: "private-key",
      created_at_ms: 10,
      updated_at_ms: 20,
    });
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(collectSqliteSchemaShape(database.db)).toEqual(createInitialStateSchemaShape());
  });

  it("adopts a canonical native PortGuardian seed without losing records", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const seed = new DatabaseSync(databasePath);
    seed.exec(`
CREATE TABLE macos_port_guardian_records (
  pid INTEGER NOT NULL PRIMARY KEY,
  port INTEGER NOT NULL,
  command TEXT NOT NULL,
  mode TEXT NOT NULL,
  timestamp REAL NOT NULL
) STRICT;
CREATE INDEX idx_macos_port_guardian_records_port
  ON macos_port_guardian_records(port, timestamp DESC);
INSERT INTO macos_port_guardian_records VALUES (4242, 18789, '/usr/bin/ssh', 'remote', 42.5);
`);
    seed.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(
      database.db.prepare("SELECT * FROM macos_port_guardian_records WHERE pid = 4242").get(),
    ).toEqual({
      pid: 4242,
      port: 18789,
      command: "/usr/bin/ssh",
      mode: "remote",
      timestamp: 42.5,
    });
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(collectSqliteSchemaShape(database.db)).toEqual(createInitialStateSchemaShape());
  });

  it("doctor migrates existing APNs tombstone tables to STRICT without losing rows", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      ALTER TABLE apns_registration_tombstones RENAME TO apns_registration_tombstones_strict;
      CREATE TABLE apns_registration_tombstones (
        node_id TEXT NOT NULL PRIMARY KEY,
        deleted_at_ms INTEGER NOT NULL
      );
      INSERT INTO apns_registration_tombstones VALUES ('ios-node-1', 42);
      DROP TABLE apns_registration_tombstones_strict;
    `);
    legacyDb.close();

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: ["Migrated shared state tables to SQLite STRICT typing (1)"],
      warnings: [],
    });
    const migrated = openOpenClawStateDatabase(options);
    expect(
      migrated.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'apns_registration_tombstones'")
        .get(),
    ).toEqual({ strict: 1 });
    expect(migrated.db.prepare("SELECT * FROM apns_registration_tombstones").get()).toEqual({
      node_id: "ios-node-1",
      deleted_at_ms: 42,
    });
  });

  it("doctor migrates version 2 tables to STRICT without losing rows", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy
      .prepare(
        `INSERT INTO workspace_path_aliases (
           alias_key, alias_path, workspace_key, workspace_path, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("legacy-alias", "/tmp/legacy-alias", "legacy-workspace", "/tmp/legacy-workspace", 20);
    legacy.exec(`
      ALTER TABLE workspace_path_aliases RENAME TO workspace_path_aliases_strict;
      CREATE TABLE workspace_path_aliases (
        alias_key TEXT NOT NULL PRIMARY KEY,
        alias_path TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      INSERT INTO workspace_path_aliases SELECT * FROM workspace_path_aliases_strict;
      DROP TABLE workspace_path_aliases_strict;
      PRAGMA user_version = 2;
      UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary';
    `);
    legacy.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "creator-namespace-v14", path: databasePath },
      { kind: "strict-tables-v3", path: databasePath },
      { kind: "session-watch-cursor-provenance-v4", path: databasePath },
    ]);
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        "Migrated cloud worker placements to execution modes",
        "Migrated shared state session watch cursors → provenance column (0 ambient, 0 sentinels removed)",
        "Qualified historical cron creator attribution as unknown (v14)",
        "Migrated shared state tables to SQLite STRICT typing (1)",
      ],
      warnings: [],
    });
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);

    const migrated = openOpenClawStateDatabase(options);
    expect(
      migrated.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'workspace_path_aliases'")
        .get(),
    ).toEqual({ strict: 1 });
    expect(migrated.db.prepare("SELECT * FROM workspace_path_aliases").get()).toEqual({
      alias_key: "legacy-alias",
      alias_path: "/tmp/legacy-alias",
      workspace_key: "legacy-workspace",
      workspace_path: "/tmp/legacy-workspace",
      updated_at_ms: 20,
    });
  });

  it("doctor migrates version 3 ambient watch sentinels into cursor provenance", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const seeded = seedLegacySessionWatchCursorSchema(stateDir);

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "creator-namespace-v14", path: seeded.databasePath },
      { kind: "session-watch-cursor-provenance-v4", path: seeded.databasePath },
    ]);
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        "Migrated cloud worker placements to execution modes",
        "Migrated shared state session watch cursors → provenance column (2 ambient, 5 sentinels removed)",
        "Qualified historical cron creator attribution as unknown (v14)",
      ],
      warnings: [],
    });

    const migrated = openOpenClawStateDatabase(options);
    expect(
      migrated.db
        .prepare(
          `SELECT watcher_session_key, target_session_key, last_seen_sequence,
                  notified_sequence, material_sequence, provenance, updated_at
           FROM session_watch_cursors
           ORDER BY target_session_key`,
        )
        .all(),
    ).toEqual([
      {
        watcher_session_key: seeded.watcherSessionKey,
        target_session_key: seeded.explicitTarget,
        last_seen_sequence: 3,
        notified_sequence: 4,
        material_sequence: 5,
        provenance: "explicit",
        updated_at: 300,
      },
      {
        watcher_session_key: seeded.watcherSessionKey,
        target_session_key: seeded.ambientTarget,
        last_seen_sequence: 7,
        notified_sequence: 8,
        material_sequence: 9,
        provenance: "ambient-group",
        updated_at: 400,
      },
      {
        watcher_session_key: seeded.bomWatcherSessionKey,
        target_session_key: seeded.bomTarget,
        last_seen_sequence: 10,
        notified_sequence: 11,
        material_sequence: 12,
        provenance: "ambient-group",
        updated_at: 800,
      },
      {
        watcher_session_key: seeded.replacementWatcherSessionKey,
        target_session_key: seeded.corruptTarget,
        last_seen_sequence: 13,
        notified_sequence: 14,
        material_sequence: 15,
        provenance: "explicit",
        updated_at: 600,
      },
    ]);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
    closeOpenClawStateDatabaseForTest();
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({ changes: [], warnings: [] });
  });

  it("automatically migrates version 3 ambient watch sentinels on database open", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const seeded = seedLegacySessionWatchCursorSchema(stateDir);

    const migrated = openOpenClawStateDatabase(options);
    expect(
      migrated.db
        .prepare(
          `SELECT target_session_key, provenance
           FROM session_watch_cursors
           ORDER BY target_session_key`,
        )
        .all(),
    ).toEqual([
      { target_session_key: seeded.explicitTarget, provenance: "explicit" },
      { target_session_key: seeded.ambientTarget, provenance: "ambient-group" },
      { target_session_key: seeded.bomTarget, provenance: "ambient-group" },
      { target_session_key: seeded.corruptTarget, provenance: "explicit" },
    ]);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
  });

  it("detects schema migrations committed in an uncheckpointed WAL", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const opened = openOpenClawStateDatabase(options);
    const databasePath = opened.path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        PRAGMA user_version = 2;
        UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary';
      `);

      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
        kind: "strict-tables-v3",
        path: databasePath,
      });
    } finally {
      writer.close();
    }
  });

  it("rejects a placement turn claim tuple without an owner", () => {
    const database = openMaterializedCurrentStateDatabase();
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO worker_session_placements (
              session_id,
              agent_id,
              session_key,
              state,
              turn_claim_id,
              turn_claim_run_id,
              turn_claim_generation,
              created_at_ms,
              updated_at_ms,
              state_changed_at_ms
            ) VALUES (?, 'main', 'agent:main:placement-claim', 'local', ?, ?, 0, 1, 1, 1)`,
          )
          .run("session-placement-claim", "claim-without-owner", "run-without-owner"),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  const validPlacementShapes = [
    {
      name: "local placement",
      sessionId: "session-local-valid",
      state: "local",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
    {
      name: "requested placement",
      sessionId: "session-requested-valid",
      state: "requested",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
    {
      name: "provisioning placement before environment allocation",
      sessionId: "session-provisioning-pending-valid",
      state: "provisioning",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
    {
      name: "provisioning placement after environment allocation",
      sessionId: "session-provisioning-allocated-valid",
      state: "provisioning",
      environmentId: "environment-provisioning",
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
    {
      name: "syncing placement",
      sessionId: "session-syncing-valid",
      state: "syncing",
      environmentId: "environment-syncing",
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-syncing",
      recoveryError: null,
    },
    {
      name: "starting placement",
      sessionId: "session-starting-valid",
      state: "starting",
      environmentId: "environment-starting",
      activeOwnerEpoch: null,
      workspaceBaseManifestRef: "manifest-starting",
      remoteWorkspaceDir: "/workspace/starting",
      workerBundleHash: "bundle-starting",
      recoveryError: null,
    },
    {
      name: "active placement",
      sessionId: "session-active-valid",
      state: "active",
      environmentId: "environment-active",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-active",
      remoteWorkspaceDir: "/workspace/active",
      workerBundleHash: "bundle-active",
      lastTranscriptAckCursor: 3,
      lastLiveEventAckCursor: 4,
      recoveryError: null,
    },
    {
      name: "draining placement",
      sessionId: "session-draining-valid",
      state: "draining",
      environmentId: "environment-draining",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-draining",
      remoteWorkspaceDir: "/workspace/draining",
      workerBundleHash: "bundle-draining",
      recoveryError: null,
    },
    {
      name: "reconciling placement",
      sessionId: "session-reconciling-valid",
      state: "reconciling",
      environmentId: "environment-reconciling",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-reconciling",
      remoteWorkspaceDir: "/workspace/reconciling",
      workerBundleHash: "bundle-reconciling",
      recoveryError: null,
    },
    {
      name: "reclaimed placement with full provenance",
      sessionId: "session-reclaimed-valid",
      state: "reclaimed",
      environmentId: "environment-reclaimed",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-reclaimed",
      remoteWorkspaceDir: "/workspace/reclaimed",
      workerBundleHash: "bundle-reclaimed",
      recoveryError: null,
    },
    {
      name: "failed placement with recovery detail",
      sessionId: "session-failed-valid",
      state: "failed",
      environmentId: "environment-failed",
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: "worker placement failed",
    },
  ] satisfies Array<PlacementConstraintProbe & { name: string }>;

  it.each(validPlacementShapes)("allows a valid $name", (input) => {
    const database = openMaterializedCurrentStateDatabase();
    try {
      expect(() => insertPlacementConstraintProbe(database, input)).not.toThrow();
    } finally {
      database.close();
    }
  });

  const invalidPlacementShapes = [
    {
      name: "local environment",
      sessionId: "session-local-environment",
      state: "local",
      environmentId: "environment-local",
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
    {
      name: "syncing without environment",
      sessionId: "session-syncing-environment",
      state: "syncing",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "syncing workspace metadata",
      sessionId: "session-syncing-workspace",
      state: "syncing",
      environmentId: "environment-syncing",
      activeOwnerEpoch: null,
      workspaceBaseManifestRef: "manifest-syncing",
      remoteWorkspaceDir: "/workspace/syncing",
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "active without owner epoch",
      sessionId: "session-active-epoch",
      state: "active",
      environmentId: "environment-active",
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
      workspaceBaseManifestRef: "manifest-active",
      remoteWorkspaceDir: "/workspace/active",
    },
    {
      name: "active without worker bundle",
      sessionId: "session-active-bundle",
      state: "active",
      environmentId: "environment-active",
      activeOwnerEpoch: 7,
      workerBundleHash: null,
      recoveryError: null,
      workspaceBaseManifestRef: "manifest-active",
      remoteWorkspaceDir: "/workspace/active",
    },
    {
      name: "starting without manifest",
      sessionId: "session-starting-manifest",
      state: "starting",
      environmentId: "environment-starting",
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
      remoteWorkspaceDir: "/workspace/starting",
    },
    {
      name: "starting owner epoch",
      sessionId: "session-starting-epoch",
      state: "starting",
      environmentId: "environment-starting",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-starting",
      remoteWorkspaceDir: "/workspace/starting",
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "requested worker metadata",
      sessionId: "session-requested-metadata",
      state: "requested",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "provisioning worker bundle",
      sessionId: "session-provisioning-bundle",
      state: "provisioning",
      environmentId: "environment-provisioning",
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "active recovery error",
      sessionId: "session-active-recovery",
      state: "active",
      environmentId: "environment-active",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-active",
      remoteWorkspaceDir: "/workspace/active",
      workerBundleHash: "bundle-hash",
      recoveryError: "unexpected active recovery detail",
    },
    {
      name: "reclaimed placement without full provenance",
      sessionId: "session-reclaimed-provenance",
      state: "reclaimed",
      environmentId: "environment-reclaimed",
      activeOwnerEpoch: null,
      workerBundleHash: "bundle-hash",
      recoveryError: null,
    },
    {
      name: "reclaimed recovery error",
      sessionId: "session-reclaimed-recovery",
      state: "reclaimed",
      environmentId: "environment-reclaimed",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-reclaimed",
      remoteWorkspaceDir: "/workspace/reclaimed",
      workerBundleHash: "bundle-hash",
      recoveryError: "unexpected reclaimed recovery detail",
    },
    {
      name: "failed without recovery error",
      sessionId: "session-failed-recovery",
      state: "failed",
      environmentId: null,
      activeOwnerEpoch: null,
      workerBundleHash: null,
      recoveryError: null,
    },
  ] satisfies Array<PlacementConstraintProbe & { name: string }>;

  it.each(invalidPlacementShapes)("rejects a placement with $name", (input) => {
    const database = openMaterializedCurrentStateDatabase();
    try {
      expect(() => insertPlacementConstraintProbe(database, input)).toThrow();
    } finally {
      database.close();
    }
  });

  const invalidPlacementClaimOwners = [
    {
      name: "local claim on active placement",
      state: "active",
      activeOwnerEpoch: 7,
      turnClaimOwner: "local",
      turnClaimOwnerEpoch: undefined,
    },
    {
      name: "worker claim on reconciling placement",
      state: "reconciling",
      activeOwnerEpoch: 7,
      turnClaimOwner: "worker",
      turnClaimOwnerEpoch: 7,
    },
    {
      name: "stale worker owner epoch",
      state: "active",
      activeOwnerEpoch: 7,
      turnClaimOwner: "worker",
      turnClaimOwnerEpoch: 8,
    },
    {
      name: "worker claim on reclaimed placement",
      state: "reclaimed",
      activeOwnerEpoch: 7,
      turnClaimOwner: "worker",
      turnClaimOwnerEpoch: 7,
    },
  ] satisfies Array<{
    name: string;
    state: string;
    activeOwnerEpoch: number;
    turnClaimOwner: "local" | "worker";
    turnClaimOwnerEpoch: number | undefined;
  }>;

  it.each(invalidPlacementClaimOwners)("rejects a placement with $name", (input) => {
    const database = openMaterializedCurrentStateDatabase();
    try {
      expect(() =>
        insertPlacementConstraintProbe(database, {
          sessionId: `session-${input.state}-${input.turnClaimOwner}`,
          state: input.state,
          environmentId: `environment-${input.state}`,
          activeOwnerEpoch: input.activeOwnerEpoch,
          workspaceBaseManifestRef: `manifest-${input.state}`,
          remoteWorkspaceDir: `/workspace/${input.state}`,
          workerBundleHash: "bundle-hash",
          recoveryError: null,
          turnClaimOwner: input.turnClaimOwner,
          ...(input.turnClaimOwnerEpoch === undefined
            ? {}
            : { turnClaimOwnerEpoch: input.turnClaimOwnerEpoch }),
        }),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("allows an exact worker claim while placement drains", () => {
    const database = openMaterializedCurrentStateDatabase();
    try {
      expect(() =>
        insertPlacementConstraintProbe(database, {
          sessionId: "session-draining-worker",
          state: "draining",
          environmentId: "environment-draining",
          activeOwnerEpoch: 7,
          workspaceBaseManifestRef: "manifest-draining",
          remoteWorkspaceDir: "/workspace/draining",
          workerBundleHash: "bundle-hash",
          recoveryError: null,
          turnClaimOwner: "worker",
          turnClaimOwnerEpoch: 7,
        }),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("repairs every canonical shared-state named index", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const canonicalShape = normalizeSqliteSchemaShapeSql(createInitialStateSchemaShape());

    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(databasePath);
    try {
      expect(replaceNamedIndexesWithNoncanonicalIndexes(drifted).length).toBeGreaterThan(100);
      expect(drifted.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      drifted.close();
    }

    const reopened = openOpenClawStateDatabase({ env });
    expect(normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(reopened.db))).toEqual(
      canonicalShape,
    );
  });

  it("repairs same-version Claw bootstrap columns before runtime schema validation", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const shippedSchema = new DatabaseSync(databasePath);
    try {
      shippedSchema.exec(`
        ALTER TABLE claw_installs DROP COLUMN bootstrap_source_path;
        ALTER TABLE claw_installs DROP COLUMN bootstrap_content_digest;
      `);
      expect(readSqliteNumberPragma(shippedSchema, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
    } finally {
      shippedSchema.close();
    }

    const reopened = openOpenClawStateDatabase({ env });
    const columns = reopened.db.prepare("PRAGMA table_info(claw_installs)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["bootstrap_source_path", "bootstrap_content_digest"]),
    );
    expect(normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(reopened.db))).toEqual(
      normalizeSqliteSchemaShapeSql(createInitialStateSchemaShape()),
    );
  });

  it("repairs same-version Claw bootstrap columns with physical index drift", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const shippedSchema = new DatabaseSync(databasePath);
    try {
      shippedSchema.exec(`
        ALTER TABLE claw_installs DROP COLUMN bootstrap_source_path;
        ALTER TABLE claw_installs DROP COLUMN bootstrap_content_digest;
      `);
    } finally {
      shippedSchema.close();
    }
    createTaskRunStatusIndexPhysicalDrift(databasePath);

    const reopened = openOpenClawStateDatabase({ env });
    const columns = reopened.db.prepare("PRAGMA table_info(claw_installs)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["bootstrap_source_path", "bootstrap_content_digest"]),
    );
    expect(reopened.db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(
      reopened.db
        .prepare(
          "SELECT task_id FROM task_runs INDEXED BY idx_task_runs_status WHERE status = 'running'",
        )
        .all(),
    ).toEqual([{ task_id: "task-index-repair" }]);
  });

  it.each([
    { columnName: "run_end_cleanup_json", tableName: "worktrees" },
    { columnName: "desktop_json", tableName: "worker_environments" },
    { columnName: "shared_host", tableName: "worker_environments" },
  ])(
    "appends same-version $columnName to $tableName before schema validation",
    ({ columnName, tableName }) => {
      const stateDir = createTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath = materializeCurrentStateDatabase(stateDir);

      const { DatabaseSync } = requireNodeSqlite();
      const shippedSchema = new DatabaseSync(databasePath);
      try {
        shippedSchema.exec(`ALTER TABLE ${tableName} DROP COLUMN ${columnName};`);
        expect(readSqliteNumberPragma(shippedSchema, "user_version")).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
      } finally {
        shippedSchema.close();
      }
      createTaskRunStatusIndexPhysicalDrift(databasePath);

      const reopened = openOpenClawStateDatabase({ env });
      const columns = reopened.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toContain(columnName);
      expect(() =>
        assertOpenClawStateDatabaseForMaintenance(reopened.db, { pathname: reopened.path }),
      ).not.toThrow();
      expect(reopened.db.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(
        reopened.db
          .prepare(
            "SELECT task_id FROM task_runs INDEXED BY idx_task_runs_status WHERE status = 'running'",
          )
          .all(),
      ).toEqual([{ task_id: "task-index-repair" }]);
    },
  );

  it("installs same-version worker session tool tables before runtime schema validation", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const shippedSchema = new DatabaseSync(databasePath);
    try {
      shippedSchema.exec(`
        DROP TABLE worker_session_tool_operations;
        DROP TABLE worker_turn_tool_authorities;
      `);
      expect(readSqliteNumberPragma(shippedSchema, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
    } finally {
      shippedSchema.close();
    }

    const reopened = openOpenClawStateDatabase({ env });
    const tables = reopened.db
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name IN (?, ?)
         ORDER BY name`,
      )
      .all("worker_session_tool_operations", "worker_turn_tool_authorities");
    expect(tables).toEqual([
      { name: "worker_session_tool_operations" },
      { name: "worker_turn_tool_authorities" },
    ]);
    expect(() =>
      assertOpenClawStateDatabaseForMaintenance(reopened.db, { pathname: reopened.path }),
    ).not.toThrow();
  });

  it("keeps GitHub publication lazy across current-schema open, first use, and reopen", async () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const previousV9 = new DatabaseSync(databasePath);
    previousV9.exec(`
      DROP INDEX idx_github_publication_requests_pending;
      DROP TABLE github_publication_requests;
    `);
    expect(readSqliteNumberPragma(previousV9, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    previousV9.close();

    const beforeFirstUse = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
    expect(
      beforeFirstUse?.db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'github_publication_requests'")
        .get(),
    ).toBeUndefined();
    beforeFirstUse?.walMaintenance.close();

    const currentSchema = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(currentSchema.db, "user_version")).toBe(
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
    ensureGitHubPublicationSchema(currentSchema.db);
    expect(
      currentSchema.db
        .prepare(
          "SELECT type, name FROM sqlite_schema WHERE name IN ('github_publication_requests', 'idx_github_publication_requests_pending') ORDER BY type DESC",
        )
        .all(),
    ).toEqual([
      { type: "table", name: "github_publication_requests" },
      { type: "index", name: "idx_github_publication_requests_pending" },
    ]);
    expect(() =>
      assertSqliteSchemaContains(
        currentSchema.db,
        "previous v9 reader",
        getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
      ),
    ).not.toThrow();
    closeOpenClawStateDatabaseForTest();

    const reopened = openOpenClawStateDatabase(options);
    expect(() =>
      assertOpenClawStateDatabaseForMaintenance(reopened.db, { pathname: reopened.path }),
    ).not.toThrow();
    closeOpenClawStateDatabaseForTest();
    const readOnly = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
    expect(readOnly?.db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    readOnly?.walMaintenance.close();
  });

  it("does not add Claw bootstrap columns before rejecting unrelated index corruption", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const shippedSchema = new DatabaseSync(databasePath);
    try {
      shippedSchema.exec(`
        ALTER TABLE claw_installs DROP COLUMN bootstrap_source_path;
        ALTER TABLE claw_installs DROP COLUMN bootstrap_content_digest;
      `);
    } finally {
      shippedSchema.close();
    }
    createUnsafeIndexDrift(databasePath);

    expect(() => openOpenClawStateDatabase({ env })).toThrow(
      /integrity_check failed.*missing from index unsafe_index_records_value/iu,
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = preserved.prepare("PRAGMA table_info(claw_installs)").all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).not.toEqual(
        expect.arrayContaining(["bootstrap_source_path", "bootstrap_content_digest"]),
      );
    } finally {
      preserved.close();
    }
  });

  it("repairs physical ordinary-index drift before cold-open reads", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = materializeCurrentStateDatabase(stateDir);
    createTaskRunStatusIndexPhysicalDrift(databasePath);

    const reopened = openOpenClawStateDatabase({ env });
    expect(reopened.db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(
      reopened.db
        .prepare(
          "SELECT task_id FROM task_runs INDEXED BY idx_task_runs_status WHERE status = 'running'",
        )
        .all(),
    ).toEqual([{ task_id: "task-index-repair" }]);
  });

  it("rejects a missing current-schema table instead of recreating it empty", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(databasePath);
    drifted.exec("DROP TABLE apns_registration_tombstones;");
    drifted.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /missing table apns_registration_tombstones/iu,
    );
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [expect.stringContaining("missing table apns_registration_tombstones")],
    });

    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        after
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'apns_registration_tombstones'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      after.close();
    }
  });

  it.each(
    ([5, 6] as const).flatMap((version) =>
      (["runtime open", "doctor repair"] as const).map((migrationPath) => ({
        migrationPath,
        version,
      })),
    ),
  )(
    "rejects a missing stable v$version table before the v7 migration through $migrationPath",
    ({ migrationPath, version }) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);

      const { DatabaseSync } = requireNodeSqlite();
      const damaged = new DatabaseSync(databasePath);
      damaged.exec("DROP TABLE apns_registration_tombstones;");
      markStateDatabaseVersion(damaged, version);
      damaged.close();

      if (migrationPath === "runtime open") {
        expect(() => openOpenClawStateDatabase(options)).toThrow(
          /missing table apns_registration_tombstones/iu,
        );
      } else {
        expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
          changes: [],
          warnings: [expect.stringContaining("missing table apns_registration_tombstones")],
        });
      }

      const after = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          after
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'apns_registration_tombstones'",
            )
            .get(),
        ).toBeUndefined();
        expect(readSqliteNumberPragma(after, "user_version")).toBe(version);
      } finally {
        after.close();
      }
    },
  );

  it("upgrades v5 databases that predate startup worker tool tables", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE worker_session_tool_operations;
      DROP TABLE worker_turn_tool_authorities;
    `);
    markStateDatabaseVersion(legacy, 5);
    legacy.close();

    const migrated = openOpenClawStateDatabase(options);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    const tables = migrated.db
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name IN (?, ?)
         ORDER BY name`,
      )
      .all("worker_session_tool_operations", "worker_turn_tool_authorities");
    expect(tables).toEqual([
      { name: "worker_session_tool_operations" },
      { name: "worker_turn_tool_authorities" },
    ]);
  });

  it("rejects an inline unique constraint hidden behind a SQLite autoindex", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(databasePath);
    drifted.exec(`
      DROP TABLE diagnostic_events;
      CREATE TABLE diagnostic_events (
        scope TEXT NOT NULL UNIQUE,
        event_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, event_key)
      ) STRICT;
      CREATE INDEX idx_diagnostic_events_scope_sequence
        ON diagnostic_events(event_key);
    `);
    drifted.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /unexpected unique index on diagnostic_events/iu,
    );
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [expect.stringContaining("unexpected unique index on diagnostic_events")],
    });
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        after
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_diagnostic_events_scope_sequence'",
          )
          .get(),
      ).toEqual({
        sql: "CREATE INDEX idx_diagnostic_events_scope_sequence\n        ON diagnostic_events(event_key)",
      });
    } finally {
      after.close();
    }
  });

  it("rejects primary-key collation drift in a current-schema table", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(databasePath);
    drifted.exec(`
      DROP TABLE apns_registration_tombstones;
      CREATE TABLE apns_registration_tombstones (
        node_id TEXT COLLATE NOCASE NOT NULL PRIMARY KEY,
        deleted_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    drifted.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /column definitions differ for apns_registration_tombstones/iu,
    );
  });

  it("classifies the released agent registry primary key as Doctor-repairable", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      ALTER TABLE agent_databases RENAME TO agent_databases_current;
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        size_bytes INTEGER
      );
      INSERT INTO agent_databases (
        agent_id,
        path,
        schema_version,
        last_seen_at,
        size_bytes
      )
      SELECT
        agent_id,
        path,
        schema_version,
        last_seen_at,
        size_bytes
      FROM agent_databases_current;
      DROP TABLE agent_databases_current;
    `);
    legacy.close();

    expectStateSchemaMigrationRequired(() => openOpenClawStateDatabase(options), {
      kind: "agent-databases-composite-primary-key",
      pathname: databasePath,
    });
  });

  it("keeps an unrecognized agent registry schema fail-closed and nonrepairable", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const malformed = new DatabaseSync(databasePath);
    malformed.exec(`
      DROP TABLE agent_databases;
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);
    malformed.close();

    let caught: unknown;
    try {
      openOpenClawStateDatabase(options);
    } catch (error) {
      caught = error;
    }
    expect(findOpenClawStateDatabaseSchemaMigrationRequiredError(caught)).toBeUndefined();
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      "noncanonical agent database registry schema that cannot be repaired automatically",
    );
  });

  it("migrates the released audit ledger to message-compatible attribution exactly once", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "audit-events-v2", path: databasePath },
      { kind: "strict-tables-v3", path: databasePath },
    ]);
    expectStateSchemaMigrationRequired(() => openOpenClawStateDatabase(options), {
      kind: "audit-events-v2",
      pathname: databasePath,
    });

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        "Migrated shared state audit event ledger → versioned message lifecycle schema",
        "Migrated shared state tables to SQLite STRICT typing (3)",
      ],
      warnings: [],
    });
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({ changes: [], warnings: [] });
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);

    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    try {
      const columns = db.prepare("PRAGMA table_info(audit_events)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const nullability = new Map(columns.map((column) => [column.name, column.notnull === 0]));
      expect(nullability.get("schema_version")).toBe(false);
      expect(nullability.get("source_sequence")).toBe(false);
      expect(nullability.get("actor_id")).toBe(false);
      expect(nullability.get("agent_id")).toBe(true);
      expect(nullability.get("run_id")).toBe(true);
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "direction",
          "channel",
          "conversation_kind",
          "message_outcome",
          "reason_code",
          "delivery_kind",
          "failure_stage",
          "duration_ms",
          "result_count",
          "account_ref",
          "conversation_ref",
          "message_ref",
          "target_ref",
        ]),
      );
      expect(db.prepare("SELECT * FROM audit_events").get()).toMatchObject({
        sequence: 7,
        event_id: "event-legacy",
        source_id: "run-legacy:1:100:agent.run.started",
        schema_version: 1,
        source_sequence: 1,
        agent_id: "main",
        run_id: "run-legacy",
        channel: null,
        direction: null,
      });

      db.prepare(
        `INSERT INTO audit_events (
           event_id,
           source_id,
           source_sequence,
           occurred_at,
           kind,
           action,
           status,
           actor_type,
           actor_id,
           direction,
           channel,
           conversation_kind,
           account_ref
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "event-message",
        "message-source",
        2,
        200,
        "message",
        "message.received",
        "succeeded",
        "channel_sender",
        "hmac-sha256:v1:sender",
        "inbound",
        "telegram",
        "direct",
        "hmac-sha256:v1:account",
      );
      expect(
        db
          .prepare(
            "SELECT sequence, schema_version, source_sequence, actor_id, agent_id, run_id FROM audit_events WHERE event_id = ?",
          )
          .get("event-message"),
      ).toEqual({
        sequence: 41,
        schema_version: 1,
        source_sequence: 2,
        actor_id: "hmac-sha256:v1:sender",
        agent_id: null,
        run_id: null,
      });
      const indexNames = (
        db.prepare("PRAGMA index_list(audit_events)").all() as Array<{ name: string }>
      ).map((index) => index.name);
      expect(indexNames).toEqual(
        expect.arrayContaining([
          "idx_audit_events_time",
          "idx_audit_events_agent_sequence",
          "idx_audit_events_session_sequence",
          "idx_audit_events_run_sequence",
          "idx_audit_events_kind_sequence",
          "idx_audit_events_status_sequence",
          "idx_audit_events_channel_sequence",
          "idx_audit_events_direction_sequence",
        ]),
      );
      expect(readSqliteNumberPragma(db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      expect(
        db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      expect(() =>
        db
          .prepare(
            "INSERT INTO audit_identity_keys (id, key_id, key, created_at) VALUES (1, ?, ?, ?)",
          )
          .run("key-v1", new Uint8Array([1, 2, 3]), 100),
      ).not.toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO audit_identity_keys (id, key_id, key, created_at) VALUES (2, ?, ?, ?)",
          )
          .run("key-v2", new Uint8Array([4, 5, 6]), 200),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("preserves an empty audit ledger's sequence high-water mark", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(
      "DELETE FROM audit_events; UPDATE sqlite_sequence SET seq = 73 WHERE name = 'audit_events';",
    );
    legacy.close();

    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);

    const migrated = new DatabaseSync(databasePath);
    try {
      migrated
        .prepare(
          `INSERT INTO audit_events (
             event_id, source_id, source_sequence, occurred_at, kind, action, status,
             actor_type, actor_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "event-after-empty-migration",
          "source-after-empty-migration",
          1,
          200,
          "message",
          "message.inbound.processed",
          "succeeded",
          "system",
          "gateway",
        );
      expect(
        migrated
          .prepare("SELECT sequence FROM audit_events WHERE event_id = ?")
          .get("event-after-empty-migration"),
      ).toEqual({ sequence: 74 });
    } finally {
      migrated.close();
    }
  });

  it("does not claim a legacy audit database with conflicting ownership", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("UPDATE schema_meta SET role = 'agent', agent_id = 'worker-1';");
    legacy.close();

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [expect.stringContaining("schema role agent; expected global")],
    });

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readSqliteNumberPragma(preserved, "user_version")).toBe(1);
      expect(
        preserved
          .prepare(
            "SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'",
          )
          .get(),
      ).toEqual({ role: "agent", schema_version: 1, agent_id: "worker-1" });
      expect(
        preserved
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'apns_registration_tombstones'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it("refuses an audit sequence high-water mark outside the supported cursor range", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("UPDATE sqlite_sequence SET seq = 9007199254740992 WHERE name = 'audit_events';");
    legacy.close();

    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [expect.stringContaining("exceeds the supported integer range")],
    });

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare(
            "SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'audit_events'",
          )
          .get(),
      ).toEqual({ seq: "9007199254740992" });
      expect(
        preserved.prepare("SELECT event_id FROM audit_events WHERE sequence = 7").get(),
      ).toEqual({ event_id: "event-legacy" });
    } finally {
      preserved.close();
    }
  });

  it("lets normal open create an audit ledger for a pre-v2 database", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("DROP TABLE audit_events");
    legacy.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [],
    });
    const beforeOpen = new DatabaseSync(databasePath, { readOnly: true });
    expect(readSqliteNumberPragma(beforeOpen, "user_version")).toBe(1);
    beforeOpen.close();

    const opened = openOpenClawStateDatabase(options);
    expect(
      opened.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
        .get(),
    ).toEqual({ name: "audit_events" });
    expect(readSqliteNumberPragma(opened.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
  });

  it("refuses to rebuild a noncanonical audit table with unknown data columns", () => {
    const stateDir = createTempStateDir();
    const databasePath = createLegacyAuditStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const customized = new DatabaseSync(databasePath);
    customized.exec("ALTER TABLE audit_events ADD COLUMN operator_note TEXT;");
    customized
      .prepare("UPDATE audit_events SET operator_note = ? WHERE event_id = ?")
      .run("preserve-me", "event-legacy");
    customized.close();

    const result = repairOpenClawStateDatabaseSchema(options);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("cannot be repaired automatically")]);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare("SELECT operator_note FROM audit_events WHERE event_id = ?")
          .get("event-legacy"),
      ).toEqual({ operator_note: "preserve-me" });
    } finally {
      preserved.close();
    }
  });

  it("refuses a v2 audit ledger without source identity uniqueness", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const malformed = new DatabaseSync(databasePath);
    rebuildAuditEventsTable(malformed, (sql) =>
      sql.replace("source_id TEXT NOT NULL UNIQUE", "source_id TEXT NOT NULL"),
    );
    insertAuditMarker(malformed, "event-duplicate-source-1", "duplicate-source", 7);
    insertAuditMarker(malformed, "event-duplicate-source-2", "duplicate-source", 8);
    malformed.close();

    expectNoncanonicalAuditSchemaRejected(stateDir, databasePath);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE source_id = ?")
          .get("duplicate-source"),
      ).toEqual({ count: 2 });
    } finally {
      preserved.close();
    }
  });

  it.each([
    ["a non-primary sequence", "sequence INTEGER"],
    ["a sequence without AUTOINCREMENT", "sequence INTEGER PRIMARY KEY"],
  ])("refuses a v2 audit ledger with %s", (_label, sequenceDeclaration) => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const malformed = new DatabaseSync(databasePath);
    rebuildAuditEventsTable(malformed, (sql) =>
      sql.replace("sequence INTEGER PRIMARY KEY AUTOINCREMENT", sequenceDeclaration),
    );
    insertAuditMarker(malformed, "event-sequence-shape", "source-sequence-shape");
    malformed.close();

    expectNoncanonicalAuditSchemaRejected(stateDir, databasePath);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare("SELECT sequence FROM audit_events WHERE event_id = ?")
          .get("event-sequence-shape"),
      ).toEqual({ sequence: 7 });
    } finally {
      preserved.close();
    }
  });

  it("refuses a v2 audit ledger with an extra column without dropping its data", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const malformed = new DatabaseSync(databasePath);
    malformed.exec("ALTER TABLE audit_events ADD COLUMN operator_note TEXT");
    insertAuditMarker(malformed, "event-v2-custom-column", "source-v2-custom-column");
    malformed
      .prepare("UPDATE audit_events SET operator_note = ? WHERE event_id = ?")
      .run("preserve-v2", "event-v2-custom-column");
    malformed.close();

    expectNoncanonicalAuditSchemaRejected(stateDir, databasePath);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare("SELECT operator_note FROM audit_events WHERE event_id = ?")
          .get("event-v2-custom-column"),
      ).toEqual({ operator_note: "preserve-v2" });
    } finally {
      preserved.close();
    }
  });

  it("refuses to recreate a missing v2 audit ledger", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const malformed = new DatabaseSync(databasePath);
    malformed.exec("DROP TABLE audit_events");
    malformed.close();

    expectNoncanonicalAuditSchemaRejected(stateDir, databasePath, "missing table audit_events");

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
          .get(),
      ).toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it("refuses a malformed audit identity key singleton table", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const malformed = new DatabaseSync(databasePath);
    malformed.exec(`
      DROP TABLE audit_identity_keys;
      CREATE TABLE audit_identity_keys (
        id INTEGER NOT NULL PRIMARY KEY CHECK (id > 0),
        key_id TEXT NOT NULL,
        key BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    malformed
      .prepare("INSERT INTO audit_identity_keys (id, key_id, key, created_at) VALUES (?, ?, ?, ?)")
      .run(2, "malformed-key", new Uint8Array([1, 2, 3]), 100);
    malformed.close();

    expectNoncanonicalAuditSchemaRejected(stateDir, databasePath);

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(preserved.prepare("SELECT id, key_id FROM audit_identity_keys").get()).toEqual({
        id: 2,
        key_id: "malformed-key",
      });
    } finally {
      preserved.close();
    }
  });

  it("keeps skill usage records scoped to their skill paths", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const kysely = getNodeSqliteKysely<StateDbTestDatabase>(database.db);

    executeSqliteQuerySync(
      database.db,
      kysely.insertInto("skill_usage").values({
        skill_file: "/skills/daily-brief/SKILL.md",
        skill_key: "daily-brief",
        skill_name: "Daily Brief",
        skill_source: "workspace",
        first_used_at_ms: 1,
        last_used_at_ms: 2,
        use_count: 3,
        last_agent_id: "main",
      }),
    );
    executeSqliteQuerySync(
      database.db,
      kysely.insertInto("skill_usage").values({
        skill_file: "/other-workspace/skills/daily-brief/SKILL.md",
        skill_key: "daily-brief",
        skill_name: "Daily Brief",
        skill_source: "workspace",
        first_used_at_ms: 4,
        last_used_at_ms: 5,
        use_count: 1,
        last_agent_id: "other",
      }),
    );
    expect(
      executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("skill_usage")
          .select(["skill_file", "use_count"])
          .where("skill_key", "=", "daily-brief")
          .orderBy("skill_file", "asc"),
      ).rows,
    ).toEqual([
      { skill_file: "/other-workspace/skills/daily-brief/SKILL.md", use_count: 1 },
      { skill_file: "/skills/daily-brief/SKILL.md", use_count: 3 },
    ]);
  });

  it.runIf(process.platform === "linux")("closes the database when initialization fails", () => {
    const databasePath = path.join(createTempStateDir(), "openclaw.sqlite");
    fs.writeFileSync(databasePath, "not a sqlite database");

    expect(() => openOpenClawStateDatabase({ path: databasePath })).toThrow(
      "file is not a database",
    );
    expect(listOpenFileDescriptorsForPath(databasePath)).toEqual([]);
  });

  it("rejects stale schema_meta indexes before writable initialization", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    createUnsafeSchemaMetaIndexDrift(databasePath);

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /integrity_check failed.*unsafe_schema_meta_role/iu,
    );
  });

  it("opens a pre-desktop current-schema database read-only", async () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const preDesktop = new DatabaseSync(databasePath);
    try {
      preDesktop.exec("ALTER TABLE worker_environments DROP COLUMN desktop_json;");
    } finally {
      preDesktop.close();
    }

    const database = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
    expect(database).toBeDefined();
    database?.walMaintenance.close();
  });

  it("accepts a missing same-version approval index read-only and repairs it on writable open", async () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const currentSchema = new DatabaseSync(databasePath);
    try {
      currentSchema.exec("DROP INDEX idx_operator_approvals_source_run_resolved;");
      expect(currentSchema.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
    } finally {
      currentSchema.close();
    }

    const beforeRepair = await openExistingOpenClawStateDatabaseReadOnly(options);
    expect(beforeRepair?.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    beforeRepair?.walMaintenance.close();

    const writable = openOpenClawStateDatabase(options);
    expect(
      writable.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get("idx_operator_approvals_source_run_resolved"),
    ).toEqual({ name: "idx_operator_approvals_source_run_resolved" });
    expect(writable.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    closeOpenClawStateDatabaseForTest();

    const afterRepair = await openExistingOpenClawStateDatabaseReadOnly(options);
    expect(afterRepair?.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    afterRepair?.walMaintenance.close();
  });

  it("reports success when retrying transient read-only snapshot cleanup", async () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const database = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
    const openedPath = database?.db.prepare("PRAGMA database_list").get() as
      | { file?: unknown }
      | undefined;
    const privateDirectory = path.dirname(String(openedPath?.file));
    const rmSync = fs.rmSync.bind(fs);
    let failRemoval = true;
    vi.spyOn(fs, "rmSync").mockImplementation(((pathname, options) => {
      if (
        fs.realpathSync.native(String(pathname)) === fs.realpathSync.native(privateDirectory) &&
        failRemoval
      ) {
        failRemoval = false;
        const error = new Error("busy");
        (error as NodeJS.ErrnoException).code = "EBUSY";
        throw error;
      }
      return rmSync(pathname, options);
    }) as typeof fs.rmSync);

    expect(database?.walMaintenance.close()).toBe(false);
    expect(fs.existsSync(privateDirectory)).toBe(true);
    expect(database?.walMaintenance.close()).toBe(true);
    expect(fs.existsSync(privateDirectory)).toBe(false);
    expect(database?.walMaintenance.close()).toBe(false);
  });

  it("reads committed live WAL rows without changing source database content", async () => {
    const stateDir = createTempStateDir();
    const writer = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    writer.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 0;");
    insertTaskRunProbe(writer.db, "task-live-wal");
    expect(fs.existsSync(`${writer.path}-wal`)).toBe(true);
    expect(fs.existsSync(`${writer.path}-shm`)).toBe(true);
    const beforeMain = fs.readFileSync(writer.path);
    const beforeWal = fs.readFileSync(`${writer.path}-wal`);
    const beforeShmSize = fs.statSync(`${writer.path}-shm`).size;
    const beforeEntries = fs.readdirSync(stateDir).toSorted();

    const database = await openExistingOpenClawStateDatabaseReadOnly({ path: writer.path });
    expect(
      database?.db.prepare("SELECT task_id FROM task_runs WHERE task_id = ?").get("task-live-wal"),
    ).toEqual({ task_id: "task-live-wal" });
    const openedPath = database?.db.prepare("PRAGMA database_list").get() as
      | { file?: unknown }
      | undefined;
    expect(path.resolve(String(openedPath?.file))).not.toBe(path.resolve(writer.path));
    const privateDirectory = path.dirname(String(openedPath?.file));
    expect(database?.walMaintenance.close()).toBe(true);

    expect(fs.existsSync(privateDirectory)).toBe(false);
    expect(fs.readFileSync(writer.path)).toEqual(beforeMain);
    expect(fs.readFileSync(`${writer.path}-wal`)).toEqual(beforeWal);
    expect(fs.statSync(`${writer.path}-shm`).size).toBe(beforeShmSize);
    expect(fs.readdirSync(stateDir).toSorted()).toEqual(beforeEntries);
  });

  it("rejects noncanonical indexes from read-only state without rewriting them", async () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(databasePath);
    try {
      drifted.exec(`
        DROP INDEX idx_task_runs_status;
        CREATE INDEX idx_task_runs_status ON task_runs(task_id);
      `);
    } finally {
      drifted.close();
    }

    await expect(openExistingOpenClawStateDatabaseReadOnly(options)).rejects.toThrow(
      /missing or drifted index idx_task_runs_status/iu,
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved
          .prepare("SELECT sql FROM sqlite_schema WHERE name = 'idx_task_runs_status'")
          .get(),
      ).toEqual({
        sql: "CREATE INDEX idx_task_runs_status ON task_runs(task_id)",
      });
    } finally {
      preserved.close();
    }
  });

  it("rejects physical canonical-index corruption from read-only state", async () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    createTaskRunStatusIndexPhysicalDrift(databasePath);

    await expect(
      openExistingOpenClawStateDatabaseReadOnly({
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    ).rejects.toThrow(/integrity_check failed.*idx_task_runs_status/iu);
  });

  it("rejects unrelated current-schema index corruption before exposure", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    createUnsafeIndexDrift(databasePath);

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /integrity_check failed.*missing from index unsafe_index_records_value/iu,
    );
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [
        expect.stringMatching(
          /integrity_check failed.*missing from index unsafe_index_records_value/iu,
        ),
      ],
    });
    const checkpointCallback = vi.fn();
    expect(() =>
      withOpenClawStateStartupMigrationCheckpointDatabase(checkpointCallback, options),
    ).toThrow(/integrity_check failed.*missing from index unsafe_index_records_value/iu);
    expect(checkpointCallback).not.toHaveBeenCalled();
  });

  it("configures checkpoint lock waits before schema mutation", () => {
    const stateDir = createTempStateDir();

    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) => {
        expect(readSqliteNumberPragma(db, "busy_timeout")).toBe(OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
      },
      { env: { OPENCLAW_STATE_DIR: stateDir } },
    );
  });

  it("runs full integrity before a pending state schema migration", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    createUnsafeIndexDrift(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const before = new DatabaseSync(databasePath);
    try {
      before.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};`);
    } finally {
      before.close();
    }

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /integrity_check failed.*missing from index unsafe_index_records_value/iu,
    );
  });

  it("runs full integrity before mutating a nonempty unversioned state database", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    createUnsafeIndexDrift(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const before = new DatabaseSync(databasePath);
    try {
      before.exec("PRAGMA user_version = 0;");
    } finally {
      before.close();
    }

    expect(() => openOpenClawStateDatabase(options)).toThrow(
      /integrity_check failed.*missing from index unsafe_index_records_value/iu,
    );
  });

  it("rejects current-schema foreign-key violations before exposure", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const { DatabaseSync } = requireNodeSqlite();
    const corrupted = new DatabaseSync(databasePath);
    try {
      corrupted.exec("PRAGMA foreign_keys = OFF;");
      corrupted.prepare("INSERT INTO task_delivery_state (task_id) VALUES (?)").run("missing-task");
      expect(corrupted.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(corrupted.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(corrupted.prepare("PRAGMA foreign_key_check").get()).toEqual({
        table: "task_delivery_state",
        rowid: 1,
        parent: "task_runs",
        fkid: 0,
      });
    } finally {
      corrupted.close();
    }

    const failure =
      /foreign_key_check failed.*task_delivery_state row 1 references task_runs \(foreign key 0\)/iu;
    expect(() => openOpenClawStateDatabase(options)).toThrow(failure);
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [],
      warnings: [expect.stringMatching(failure)],
    });
    const checkpointCallback = vi.fn();
    expect(() =>
      withOpenClawStateStartupMigrationCheckpointDatabase(checkpointCallback, options),
    ).toThrow(failure);
    expect(checkpointCallback).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "recovers a hot rollback journal privately before writable recovery",
    () => {
      const result = runHotRollbackJournalRecoveryProbe({
        moduleUrl: new URL("./openclaw-state-db.ts", import.meta.url).href,
        rootDir: createTempStateDir(),
      });

      expect(result.readOnly).toEqual({
        error: null,
        opened: true,
        uncommittedRows: 0,
      });
      expect(result).toMatchObject({
        committedRowsAfterRecovery: 256,
        immutableDirtyRowsBeforeKill: expect.any(Number),
        integrity: "ok",
        journalBytesBeforeReadOnly: expect.any(Number),
        journalExistsAfterReadOnly: true,
        journalExistsAfterRecovery: false,
      });
      expect(result.immutableDirtyRowsBeforeKill).toBeGreaterThan(0);
      expect(result.journalBytesBeforeReadOnly).toBeGreaterThan(0);
      expect(result.journalShaAfterReadOnly).toBe(result.journalShaBeforeReadOnly);
    },
  );

  it("adds gateway boot lifecycle startup markers to existing state databases", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec("ALTER TABLE gateway_boot_lifecycle DROP COLUMN startup_reason");
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = reopened.db
      .prepare("PRAGMA table_info(gateway_boot_lifecycle)")
      .all() as Array<{ name?: unknown }>;

    expect(columns.map((column) => column.name)).toContain("startup_reason");
  });

  it("adds and backfills Claw package update timestamps in existing state databases", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb
      .prepare(
        "INSERT INTO claw_package_refs (" +
          "agent_id, package_kind, package_source, package_ref, package_version, " +
          "package_integrity, schema_version, claw_name, package_status, relationship, origin, independent_owner, installed_at_ms, updated_at_ms" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "incident",
        "plugin",
        "clawhub",
        "@owner/audit",
        "2.0.1",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "openclaw.clawPackageRef.v1",
        "incident-claw",
        "complete",
        "referenced",
        "claw-introduced",
        0,
        1234,
        5678,
      );
    legacyDb.exec("ALTER TABLE claw_package_refs DROP COLUMN updated_at_ms");
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(
      reopened.db.prepare("SELECT installed_at_ms, updated_at_ms FROM claw_package_refs").get(),
    ).toEqual({ installed_at_ms: 1234, updated_at_ms: 1234 });
  });

  it("adds optional Claw application provenance columns to existing state databases", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      ALTER TABLE claw_package_refs DROP COLUMN extension_id;
      ALTER TABLE claw_package_refs DROP COLUMN extension_format;
      ALTER TABLE claw_package_refs DROP COLUMN extension_detected_format;
      ALTER TABLE claw_package_refs DROP COLUMN extension_mapped_json;
      ALTER TABLE claw_package_refs DROP COLUMN extension_unavailable_json;
      ALTER TABLE claw_package_refs DROP COLUMN extension_adapter_identity;
    `);
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const packageColumns = reopened.db
      .prepare("PRAGMA table_info(claw_package_refs)")
      .all() as Array<{ name?: string }>;
    expect(packageColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "extension_id",
        "extension_format",
        "extension_detected_format",
        "extension_mapped_json",
        "extension_unavailable_json",
        "extension_adapter_identity",
      ]),
    );
  });

  it("adds worker bootstrap lifecycle columns to existing state databases", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      DROP TABLE worker_environment_credentials;
      ALTER TABLE worker_environments DROP COLUMN bootstrap_bundle_hash;
      ALTER TABLE worker_environments DROP COLUMN bootstrap_openclaw_version;
      ALTER TABLE worker_environments DROP COLUMN bootstrap_protocol_features_json;
      ALTER TABLE worker_environments DROP COLUMN bootstrap_install_kind;
      ALTER TABLE worker_environments DROP COLUMN owner_epoch;
      ALTER TABLE worker_environments DROP COLUMN teardown_terminal_state;
      ALTER TABLE worker_environments DROP COLUMN ssh_host_key;
    `);
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = reopened.db.prepare("PRAGMA table_info(worker_environments)").all() as Array<{
      name?: string;
    }>;

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "bootstrap_bundle_hash",
        "bootstrap_openclaw_version",
        "bootstrap_protocol_features_json",
        "bootstrap_install_kind",
        "owner_epoch",
        "teardown_terminal_state",
        "ssh_host_key",
      ]),
    );
    const credentialTable = reopened.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_environment_credentials'",
      )
      .get() as { name?: string } | undefined;
    expect(credentialTable?.name).toBe("worker_environment_credentials");
  });

  it("repairs additive placement terminal columns in canonical physical order", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      ALTER TABLE worker_session_placements DROP COLUMN terminal_at_ms;
      ALTER TABLE worker_session_placements DROP COLUMN terminal_reason;
    `);
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = reopened.db
      .prepare("PRAGMA table_info(worker_session_placements)")
      .all() as Array<{ name?: string }>;

    expect(columns.map((column) => column.name).slice(-2)).toEqual([
      "terminal_reason",
      "terminal_at_ms",
    ]);
  });

  it("keeps placement-owned target machine class absent during generic repair and open", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const previousSchema = OPENCLAW_STATE_SCHEMA_SQL.replace(
      "  -- Keep this nullable column constraint-free so lazy ALTER TABLE produces the\n" +
        "  -- same shape as fresh databases; placement-move code validates its value.\n" +
        "  target_machine_class TEXT,\n",
      "",
    );
    const tableStart = previousSchema.indexOf(
      "CREATE TABLE IF NOT EXISTS worker_session_placement_moves (",
    );
    const tableEnd = previousSchema.indexOf("\n) STRICT;", tableStart);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      DROP TABLE worker_session_placement_moves;
      ${previousSchema.slice(tableStart, tableEnd + "\n) STRICT;".length)}
    `);
    legacyDb.close();

    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    expect(repairOpenClawStateDatabaseSchemaIfNeeded(options).warnings).toEqual([]);
    const repairedDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const repairedColumns = repairedDb
        .prepare("PRAGMA table_info(worker_session_placement_moves)")
        .all() as Array<{ name?: string }>;
      expect(repairedColumns.map((column) => column.name)).not.toContain("target_machine_class");
    } finally {
      repairedDb.close();
    }

    const reopened = openOpenClawStateDatabase(options);
    const columns = reopened.db
      .prepare("PRAGMA table_info(worker_session_placement_moves)")
      .all() as Array<{ name?: string }>;

    expect(columns.map((column) => column.name)).not.toContain("target_machine_class");
  });

  it("adds staged worker-result refs during the v5 state migration", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      ALTER TABLE worker_workspace_pending_results DROP COLUMN staged_result_ref;
      PRAGMA user_version = 4;
      UPDATE schema_meta SET schema_version = 4 WHERE meta_key = 'primary';
    `);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase(options);
    const columns = reopened.db
      .prepare("PRAGMA table_info(worker_workspace_pending_results)")
      .all() as Array<{ name?: string }>;
    expect(columns.map((column) => column.name)).toContain("staged_result_ref");
    expect(readSqliteNumberPragma(reopened.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(
      reopened.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
  });

  it("adds worker transcript commit tables to existing state databases", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      DROP TABLE worker_transcript_commits;
      DROP TABLE worker_transcript_commit_heads;
    `);
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const tables = reopened.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN (
            'worker_transcript_commit_heads',
            'worker_transcript_commits'
          )
          ORDER BY name`,
      )
      .all() as Array<{ name?: string }>;
    expect(tables.map((table) => table.name)).toEqual([
      "worker_transcript_commit_heads",
      "worker_transcript_commits",
    ]);
  });

  it("backfills durable approval transport references in databases created by PR 1", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);
    const approvalId = "approval/from-pr1";
    const expectedRef = buildApprovalResolutionRef({ approvalId, approvalKind: "exec" });
    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb
      .prepare(
        `INSERT INTO operator_approvals (
          approval_id,
          resolution_ref,
          kind,
          status,
          presentation_json,
          requested_by_device_token_auth,
          reviewer_device_ids_json,
          audience_session_keys_json,
          runtime_epoch,
          created_at_ms,
          expires_at_ms,
          updated_at_ms
        ) VALUES (?, ?, 'exec', 'pending', ?, 0, '[]', '[]', 'pr1-runtime', 1, 1000, 1)`,
      )
      .run(
        approvalId,
        expectedRef,
        JSON.stringify({
          kind: "exec",
          commandText: "echo migration",
          commandPreview: null,
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "deny"],
        }),
      );
    legacyDb.exec(`
      DROP INDEX idx_operator_approvals_resolution_ref;
      ALTER TABLE operator_approvals DROP COLUMN resolution_ref;
    `);
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    expect(
      reopened.db
        .prepare("SELECT resolution_ref FROM operator_approvals WHERE approval_id = ?")
        .get(approvalId),
    ).toEqual({ resolution_ref: expectedRef });
    const indexes = reopened.db.prepare("PRAGMA index_list(operator_approvals)").all() as Array<{
      name?: unknown;
      unique?: unknown;
    }>;
    expect(indexes).toContainEqual(
      expect.objectContaining({ name: "idx_operator_approvals_resolution_ref", unique: 1 }),
    );
  });

  it("migrates operator approvals to accept system-agent records", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    const currentSql = (
      legacyDb
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approvals'",
        )
        .get() as { sql: string }
    ).sql;
    legacyDb.exec("ALTER TABLE operator_approvals RENAME TO operator_approvals_current");
    legacyDb.exec(currentSql.replace("'exec', 'plugin', 'system-agent'", "'exec', 'plugin'"));
    legacyDb.exec("DROP TABLE operator_approvals_current");
    legacyDb.close();

    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toContainEqual({
      kind: "operator-approvals-system-agent",
      path: databasePath,
    });
    expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
      changes: [
        "Migrated shared state operator approvals → OpenClaw system changes",
        expect.stringMatching(/^Rebuilt canonical shared-state SQLite indexes \(\d+\)$/u),
      ],
      warnings: [],
    });

    const reopened = openOpenClawStateDatabase(options);
    const migratedSql = reopened.db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approvals'")
      .get() as { sql: string };
    expect(migratedSql.sql).toContain("'system-agent'");
  });

  it("does not recursively recommend doctor when operator approval repair refuses a shape", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const customizedDb = new DatabaseSync(databasePath);
    const currentSql = (
      customizedDb
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approvals'",
        )
        .get() as { sql: string }
    ).sql;
    customizedDb.exec("ALTER TABLE operator_approvals RENAME TO operator_approvals_current");
    customizedDb.exec(
      currentSql.replace("'exec', 'plugin', 'system-agent'", "'exec', 'plugin', 'custom-thing'"),
    );
    customizedDb.exec("DROP TABLE operator_approvals_current");
    customizedDb.close();

    const result = repairOpenClawStateDatabaseSchema(options);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("automatic repair refused the unrecognized schema shape"),
    ]);
    expect(result.warnings[0]).not.toContain("run openclaw doctor --fix");
  });

  it.each([
    { migrationPath: "runtime open", withRow: false },
    { migrationPath: "doctor repair", withRow: true },
  ])(
    "restores the true legacy managed-image table through $migrationPath",
    ({ migrationPath, withRow }) => {
      const stateDir = createTempStateDir();
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = materializeCurrentStateDatabase(stateDir);

      const { DatabaseSync } = requireNodeSqlite();
      const legacyDb = new DatabaseSync(databasePath);
      replaceManagedImageRecordsWithLegacyTable(legacyDb, { withRow });
      legacyDb.close();

      if (migrationPath === "doctor repair") {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      const reopened = openOpenClawStateDatabase(options);
      const columns = reopened.db
        .prepare("PRAGMA table_info(managed_outgoing_image_records)")
        .all() as Array<{ dflt_value?: unknown; name?: unknown; notnull?: unknown }>;
      expect(columns).toContainEqual(
        expect.objectContaining({ dflt_value: null, name: "original_media_root", notnull: 1 }),
      );
      expect(columns).toContainEqual(expect.objectContaining({ name: "agent_id" }));
      expect(columns).toContainEqual(expect.objectContaining({ name: "cleanup_pending" }));
      assertOpenClawStateDatabaseForMaintenance(reopened.db, { pathname: reopened.path });
      const tableSql = reopened.db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'managed_outgoing_image_records'",
        )
        .get() as { sql: string };
      expect(
        tableSql.sql
          .split("\n")
          .find((line) => line.includes("original_media_root"))
          ?.trim()
          .replace(/,$/u, ""),
      ).toBe("original_media_root TEXT NOT NULL");
      expect(tableSql.sql).toMatch(/\) STRICT$/u);
      const indexes = reopened.db
        .prepare("PRAGMA index_list(managed_outgoing_image_records)")
        .all() as Array<{ name?: unknown }>;
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "idx_managed_outgoing_images_session" }),
          expect.objectContaining({ name: "idx_managed_outgoing_images_message" }),
          expect.objectContaining({ name: "idx_managed_outgoing_images_agent_session" }),
          expect.objectContaining({ name: "idx_managed_outgoing_images_agent_message" }),
        ]),
      );
      if (withRow) {
        expect(
          reopened.db
            .prepare(
              `SELECT attachment_id, original_media_root, agent_id, cleanup_pending
                 FROM managed_outgoing_image_records`,
            )
            .get(),
        ).toEqual({
          agent_id: null,
          attachment_id: "legacy-attachment",
          cleanup_pending: 0,
          original_media_root: "/legacy/media",
        });
      }
    },
  );

  it("backfills diagnostic event sequences in legacy creation order", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      DROP INDEX idx_diagnostic_events_scope_sequence;
      ALTER TABLE diagnostic_events DROP COLUMN sequence;
      CREATE INDEX idx_diagnostic_events_scope_created
        ON diagnostic_events(scope, created_at, event_key);
      INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at) VALUES
        ('alpha', 'late', '{}', 20),
        ('alpha', 'tie-first', '{}', 10),
        ('alpha', 'tie-second', '{}', 10),
        ('beta', 'only', '{}', 30);
    `);
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase(options);
    const rows = reopened.db
      .prepare(
        `SELECT scope, event_key, sequence
           FROM diagnostic_events
          ORDER BY scope, sequence`,
      )
      .all();
    expect(rows).toEqual([
      { scope: "alpha", event_key: "tie-first", sequence: 1 },
      { scope: "alpha", event_key: "tie-second", sequence: 2 },
      { scope: "alpha", event_key: "late", sequence: 3 },
      { scope: "beta", event_key: "only", sequence: 1 },
    ]);
    const indexes = reopened.db.prepare("PRAGMA index_list(diagnostic_events)").all() as Array<{
      name?: unknown;
    }>;
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "idx_diagnostic_events_scope_sequence" }),
      ]),
    );
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "idx_diagnostic_events_scope_created" }),
      ]),
    );
  });

  it("adds relay origins to existing APNs registration tables", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec("ALTER TABLE apns_registrations DROP COLUMN relay_origin");
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase(options);
    const columns = reopened.db.prepare("PRAGMA table_info(apns_registrations)").all() as Array<{
      name?: unknown;
    }>;
    expect(columns).toContainEqual(expect.objectContaining({ name: "relay_origin" }));
  });

  it("serializes concurrent additive schema upgrades across processes", () => {
    const rootDir = createTempStateDir();
    const moduleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
    const databasePaths = runConcurrentSchemaProbe({ mode: "upgrade", moduleUrl, rootDir });
    const expectedShape = createInitialStateSchemaShape();
    const { DatabaseSync } = requireNodeSqlite();

    expect(databasePaths).toHaveLength(1);
    for (const [round, databasePath] of databasePaths.entries()) {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(readSqliteNumberPragma(db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
        expect(
          db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
        ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
        expect(
          db
            .prepare("SELECT agent_id, requester_agent_id FROM task_runs WHERE task_id = ?")
            .get(`legacy-concurrent-${round}`),
        ).toEqual({
          agent_id: "worker",
          requester_agent_id: "main",
        });
        expect(collectSqliteSchemaShape(db)).toEqual(expectedShape);
      } finally {
        db.close();
      }
    }
  }, 60_000);

  it("serializes concurrent fresh database initialization across processes", () => {
    const rootDir = createTempStateDir();
    const moduleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
    const databasePaths = runConcurrentSchemaProbe({ mode: "fresh", moduleUrl, rootDir });
    const expectedShape = createInitialStateSchemaShape();
    const { DatabaseSync } = requireNodeSqlite();

    expect(databasePaths).toHaveLength(1);
    for (const databasePath of databasePaths) {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(readSqliteNumberPragma(db, "auto_vacuum")).toBe(2);
        expect(readSqliteNumberPragma(db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
        expect(
          db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
        ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
        expect(collectSqliteSchemaShape(db)).toEqual(expectedShape);
      } finally {
        db.close();
      }
    }
  }, 60_000);

  it("migrates requester and executor attribution for existing cross-agent tasks", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec("ALTER TABLE task_runs DROP COLUMN requester_agent_id");
    legacyDb
      .prepare(
        `INSERT INTO task_runs (
          task_id,
          runtime,
          requester_session_key,
          owner_key,
          scope_kind,
          child_session_key,
          agent_id,
          task,
          status,
          delivery_status,
          notify_policy,
          created_at,
          last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-cross-agent",
        "subagent",
        "agent:main:main",
        "agent:main:main",
        "session",
        "agent:worker:subagent:child",
        "main",
        "Inspect worker state",
        "running",
        "pending",
        "done_only",
        100,
        100,
      );
    legacyDb
      .prepare(
        `INSERT INTO task_runs (
          task_id,
          runtime,
          requester_session_key,
          owner_key,
          scope_kind,
          child_session_key,
          agent_id,
          task,
          status,
          delivery_status,
          notify_policy,
          created_at,
          last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-global-cross-agent",
        "subagent",
        "global",
        "global",
        "session",
        "agent:worker:subagent:global-child",
        null,
        "Inspect global worker state",
        "running",
        "pending",
        "done_only",
        110,
        110,
      );
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = reopened.db.prepare("PRAGMA table_info(task_runs)").all() as Array<{
      name?: string;
    }>;
    expect(columns.some((column) => column.name === "requester_agent_id")).toBe(true);
    expect(
      reopened.db
        .prepare(
          `SELECT agent_id, requester_agent_id
           FROM task_runs
           WHERE task_id = ?`,
        )
        .get("legacy-cross-agent"),
    ).toEqual({
      agent_id: "worker",
      requester_agent_id: "main",
    });
    expect(
      reopened.db
        .prepare(
          `SELECT agent_id, requester_agent_id
           FROM task_runs
           WHERE task_id = ?`,
        )
        .get("legacy-global-cross-agent"),
    ).toEqual({
      agent_id: null,
      requester_agent_id: null,
    });

    reopened.db
      .prepare(
        `INSERT INTO task_runs (
          task_id,
          runtime,
          requester_session_key,
          owner_key,
          scope_kind,
          child_session_key,
          agent_id,
          requester_agent_id,
          task,
          status,
          delivery_status,
          notify_policy,
          created_at,
          last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "current-explicit-attribution",
        "subagent",
        "global",
        "global",
        "session",
        "agent:worker:subagent:current",
        "main",
        null,
        "Current explicit attribution",
        "running",
        "pending",
        "done_only",
        200,
        200,
      );
    closeOpenClawStateDatabaseForTest();

    const currentReopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(
      currentReopened.db
        .prepare(
          `SELECT agent_id, requester_agent_id
           FROM task_runs
           WHERE task_id = ?`,
        )
        .get("current-explicit-attribution"),
    ).toEqual({
      agent_id: "main",
      requester_agent_id: null,
    });
  });

  it("normalizes obsolete task delivery statuses in existing state databases", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-state-task-delivery-status-" },
      async ({ stateDir }) => {
        const databasePath = materializeCurrentStateDatabase(stateDir);
        const { DatabaseSync } = requireNodeSqlite();
        const database = new DatabaseSync(databasePath);
        const insert = database.prepare(
          `INSERT INTO task_runs (
            task_id, runtime, requester_session_key, owner_key, scope_kind, task, status,
            delivery_status, notify_policy, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const [taskId, deliveryStatus] of [
          ["obsolete", "not-requested"],
          ["canonical", "not_applicable"],
          ["pending", "pending"],
        ] as const) {
          insert.run(
            taskId,
            "cron",
            "",
            `system:cron:${taskId}`,
            "system",
            `Task ${taskId}`,
            "cancelled",
            deliveryStatus,
            "silent",
            100,
          );
        }
        markStateDatabaseAsPreviousAppVersion(database);
        database.close();

        const readStatuses = () =>
          openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } })
            .db.prepare("SELECT task_id, delivery_status FROM task_runs ORDER BY task_id")
            .all();
        const expectedStatuses = [
          { task_id: "canonical", delivery_status: "not_applicable" },
          { task_id: "obsolete", delivery_status: "not_applicable" },
          { task_id: "pending", delivery_status: "pending" },
        ];

        expect(readStatuses()).toEqual(expectedStatuses);
        expect(
          [...loadTaskRegistryStateFromSqlite().tasks.values()].map((task) => ({
            taskId: task.taskId,
            deliveryStatus: task.deliveryStatus,
          })),
        ).toEqual([
          { taskId: "canonical", deliveryStatus: "not_applicable" },
          { taskId: "obsolete", deliveryStatus: "not_applicable" },
          { taskId: "pending", deliveryStatus: "pending" },
        ]);

        closeOpenClawStateDatabaseForTest();
        expect(readStatuses()).toEqual(expectedStatuses);
        closeOpenClawStateDatabaseForTest();
      },
    );
  });

  it("adds hosted catalog snapshot trust columns to existing state databases", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_mode;
      ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_key_id;
      ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_signature_count;
      ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_threshold;
      ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_verified_at;
    `);
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = reopened.db
      .prepare("PRAGMA table_info(official_external_plugin_catalog_snapshots)")
      .all() as Array<{ name?: string }>;

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "trust_mode",
        "trust_key_id",
        "trust_signature_count",
        "trust_threshold",
        "trust_verified_at",
      ]),
    );
    closeOpenClawStateDatabaseForTest();
  });

  it("adds task detail storage to an existing state database", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec("ALTER TABLE task_runs DROP COLUMN detail_json");
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = reopened.db.prepare("PRAGMA table_info(task_runs)").all() as Array<{
      name?: string;
    }>;
    expect(columns.some((column) => column.name === "detail_json")).toBe(true);
  });

  it("rolls back the requester attribution column when its backfill fails", () => {
    const stateDir = createTempStateDir();
    const databasePath = materializeCurrentStateDatabase(stateDir);

    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(databasePath);
    legacyDb.exec(`
      ALTER TABLE task_runs DROP COLUMN requester_agent_id;
      CREATE TRIGGER reject_task_attribution_repair
      BEFORE UPDATE ON task_runs
      BEGIN
        SELECT RAISE(ABORT, 'blocked task attribution repair');
      END;
    `);
    legacyDb
      .prepare(
        `INSERT INTO task_runs (
          task_id,
          runtime,
          requester_session_key,
          owner_key,
          scope_kind,
          child_session_key,
          agent_id,
          task,
          status,
          delivery_status,
          notify_policy,
          created_at,
          last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "blocked-cross-agent",
        "subagent",
        "agent:main:main",
        "agent:main:main",
        "session",
        "agent:worker:subagent:blocked",
        "main",
        "Inspect blocked worker state",
        "running",
        "pending",
        "done_only",
        100,
        100,
      );
    markStateDatabaseVersion(legacyDb, 5);
    legacyDb.close();

    expect(() =>
      openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toThrow(/blocked task attribution repair/);

    const interruptedDb = new DatabaseSync(databasePath);
    const interruptedColumns = interruptedDb
      .prepare("PRAGMA table_info(task_runs)")
      .all() as Array<{
      name?: string;
    }>;
    expect(interruptedColumns.some((column) => column.name === "requester_agent_id")).toBe(false);
    interruptedDb.exec("DROP TRIGGER reject_task_attribution_repair");
    interruptedDb.close();

    const reopened = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(
      reopened.db
        .prepare(
          `SELECT agent_id, requester_agent_id
           FROM task_runs
           WHERE task_id = ?`,
        )
        .get("blocked-cross-agent"),
    ).toEqual({
      agent_id: "worker",
      requester_agent_id: "main",
    });
  });

  it("opens databases with early cron tables before creating cron indexes", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    const jobJson = JSON.stringify({
      id: "legacy-job",
      name: "Legacy job",
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: 123,
      updatedAtMs: 456,
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 0 },
      payload: { kind: "agentTurn", message: "hello", model: "anthropic/claude-sonnet-4-6" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "chat-1",
        accountId: "acct-1",
        bestEffort: true,
        failureDestination: { to: "https://example.invalid/hook" },
      },
      failureAlert: { mode: "announce", channel: "discord", to: "ops", after: 2 },
    });
    const projectedJobJson = JSON.stringify({ delivery: { threadId: 1008013 } });
    db.exec(`
      CREATE TABLE cron_jobs (
        store_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        schedule_kind TEXT NOT NULL DEFAULT 'manual',
        payload_kind TEXT NOT NULL DEFAULT 'message',
        delivery_thread_id TEXT,
        job_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store_key, job_id)
      );
    `);
    db.prepare(
      `INSERT INTO cron_jobs (store_key, job_id, job_json, updated_at)
         VALUES (?, ?, ?, ?)`,
    ).run(path.join(stateDir, "cron", "jobs.json"), "legacy-job", jobJson, 456);
    db.prepare(
      `INSERT INTO cron_jobs (
         store_key, job_id, name, schedule_kind, payload_kind, delivery_thread_id, job_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      path.join(stateDir, "cron", "jobs.json"),
      "already-projected-job",
      "Already projected",
      "every",
      "agentTurn",
      null,
      projectedJobJson,
      456,
    );
    db.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(
      database.db
        .prepare(
          `SELECT name, enabled, payload_kind, agent_id, job_json
             FROM cron_jobs
            WHERE job_id = ?`,
        )
        .get("legacy-job"),
    ).toEqual({
      enabled: 1,
      agent_id: "agent-a",
      name: "Legacy job",
      payload_kind: "agentTurn",
      job_json: jobJson,
    });
    expect(
      database.db
        .prepare(
          `SELECT json_extract(job_json, '$.delivery.threadId') AS delivery_thread_id
             FROM cron_jobs
            WHERE job_id = ?`,
        )
        .get("already-projected-job"),
    ).toEqual({ delivery_thread_id: 1008013 });
  });

  it("imports early cron run-log tables before dropping them", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE cron_run_logs (
        store_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (store_key, job_id, seq)
      );
    `);
    db.prepare("INSERT INTO cron_run_logs (store_key, job_id, seq, ts) VALUES (?, ?, ?, ?)").run(
      path.join(stateDir, "cron", "jobs.json"),
      "legacy-job",
      1,
      12345,
    );
    db.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(
      database.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_run_logs'")
        .get(),
    ).toBeUndefined();
    expect(
      database.db.prepare("SELECT source_id, ended_at FROM task_runs WHERE runtime = 'cron'").all(),
    ).toEqual([{ source_id: "legacy-job", ended_at: 12345 }]);
  });

  it("opens databases with early queue tables before creating newer indexes", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE sandbox_registry_entries (
        registry_kind TEXT NOT NULL,
        container_name TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (registry_kind, container_name)
      );
      CREATE TABLE delivery_queue_entries (
        queue_name TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        failed_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (queue_name, id)
      );
    `);
    db.prepare(
      `INSERT INTO delivery_queue_entries (
          queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "outbound",
      "delivery-1",
      "pending",
      JSON.stringify({
        id: "delivery-1",
        enqueuedAt: 10,
        retryCount: 3,
        lastAttemptAt: 20,
        lastError: "no listener",
        kind: "message",
        sessionKey: "agent:main:main",
        route: { channel: "telegram", to: "chat-1", accountId: "acct-1" },
      }),
      10,
      10,
      null,
    );
    db.prepare(
      `INSERT INTO delivery_queue_entries (
          queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "outbound",
      "delivery-invalid-integers",
      "pending",
      JSON.stringify({
        id: "delivery-invalid-integers",
        enqueuedAt: 11,
        retryCount: 1.5,
        lastAttemptAt: Number.MAX_SAFE_INTEGER + 1,
        platformSendStartedAt: 2.5,
      }),
      11,
      11,
      null,
    );
    const boundedRetention = {
      idPrefix: "cron-direct-delivery:v1:",
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxEntries: 10,
    };
    const pendingBoundedRetention = {
      idPrefix: "upgrade-bounded:v1:",
      maxAgeMs: 86_400_000,
      maxEntries: 2,
    };
    const insertPendingQueueRow = db.prepare(
      `INSERT INTO delivery_queue_entries (
          queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at
        ) VALUES (?, ?, 'pending', ?, 20, 20, NULL)`,
    );
    const pendingEntries = [
      {
        queueName: "outbound",
        id: "pending-failure-retention",
        enqueuedAt: 20,
        retryCount: 0,
        failureRetention: "permanent",
        payloads: [{ text: "keep until terminal transition" }],
      },
      {
        queueName: "outbound",
        id: "upgrade-bounded:v1:pending-completion-retention",
        enqueuedAt: 20,
        retryCount: 0,
        completionRetention: pendingBoundedRetention,
        payloads: [{ text: "private" }],
      },
      {
        queueName: "outbound",
        id: "pending-required-claim",
        enqueuedAt: 20,
        retryCount: 0,
        requiresProducerClaim: true,
        payloads: [{ text: "private" }],
      },
      {
        queueName: "outbound",
        id: "pending-producer-claim",
        enqueuedAt: 20,
        retryCount: 0,
        producerClaimId: "claim-before-upgrade",
        payloads: [{ text: "private" }],
      },
      {
        queueName: "outbound-prepared-v1",
        id: "pending-ambiguous-platform-send",
        enqueuedAt: 20,
        retryCount: 0,
        platformSendAttemptId: "attempt-before-upgrade",
        recoveryState: "unknown_after_send",
        payloads: [{ text: "private ambiguous send" }],
      },
      {
        queueName: "session",
        id: "pending-session-available-at",
        enqueuedAt: 20,
        retryCount: 0,
        availableAt: 30,
        payloads: [{ text: "private claimed session" }],
      },
      {
        queueName: "outbound-preparing-v1",
        id: "pending-stable-preparation",
        enqueuedAt: 20,
        retryCount: 0,
        payloads: [{ text: "private stable preparation" }],
      },
      {
        queueName: "outbound-prepared-v1",
        id: "pending-delivery-completion",
        enqueuedAt: 20,
        retryCount: 0,
        deliveryCompletion: { kind: "conversation", operationId: "op-before-upgrade" },
        payloads: [{ text: "private durable completion" }],
      },
    ];
    for (const { queueName, ...entry } of pendingEntries) {
      insertPendingQueueRow.run(queueName, entry.id, JSON.stringify(entry));
    }
    const insertQueueRow = db.prepare(
      `INSERT INTO delivery_queue_entries (
          queue_name, id, status, entry_json, enqueued_at, updated_at, failed_at
        ) VALUES (?, ?, 'failed', ?, ?, ?, ?)`,
    );
    insertQueueRow.run(
      "outbound",
      "rich-failure",
      JSON.stringify({
        id: "rich-failure",
        enqueuedAt: 30,
        retryCount: 2,
        channel: "private-channel",
        to: "private-target",
        accountId: "private-account",
        lastError: "raw provider error",
        payloads: [{ text: "private payload", mediaUrl: "/private/media" }],
      }),
      30,
      31,
      32,
    );
    insertQueueRow.run("session", "malformed-failure", "{corrupt private bytes", 40, -1, -1);
    insertQueueRow.run(
      "session",
      "minimal-failure",
      JSON.stringify({ id: "minimal-failure", enqueuedAt: 50, failedAt: 52, retryCount: 1 }),
      50,
      51,
      52,
    );
    insertQueueRow.run(
      "outbound-prepared-v1",
      "ambiguous-beta-failure",
      JSON.stringify({
        id: "ambiguous-beta-failure",
        enqueuedAt: 53,
        retryCount: 2,
        platformSendAttemptId: "beta-attempt",
        payloads: [{ text: "private ambiguous payload" }],
      }),
      53,
      54,
      55,
    );
    for (const [id, metadata, retryCount] of [
      ["cron-direct-delivery:v1:canonical", { completionRetention: boundedRetention }, 3],
      ["cron-direct-delivery:v1:failure", { failureRetention: boundedRetention }, 4],
      [
        "cron-direct-delivery:v1:terminal",
        { terminalPolicy: { fence: { kind: "producer-bounded", ...boundedRetention } } },
        5,
      ],
      ["terminal-permanent", { terminalPolicy: { fence: { kind: "permanent" } } }, 6],
      ["terminal-none", { retainOnFailure: true, terminalPolicy: { fence: { kind: "none" } } }, 7],
      ["legacy-none", { failureRetention: "none" }, 8],
      ["delivery-completion", { deliveryCompletion: { kind: "conversation" } }, 9],
      ["fractional-retry", { retainOnFailure: true }, 1.5],
      ["negative-retry", { retainOnFailure: true }, -1],
      ["unsafe-retry", { retainOnFailure: true }, Number.MAX_SAFE_INTEGER + 1],
      ["string-retry", { retainOnFailure: true }, "7"],
    ] as const) {
      insertQueueRow.run(
        "outbound",
        id,
        JSON.stringify({ id, enqueuedAt: 60, retryCount, ...metadata }),
        60,
        61,
        62,
      );
    }
    insertQueueRow.run(
      "session",
      "claimed-session-failure",
      JSON.stringify({
        id: "claimed-session-failure",
        enqueuedAt: 60,
        retryCount: 1,
        availableAt: 70,
      }),
      60,
      61,
      62,
    );
    const unsafeTimestampRetention = {
      idPrefix: "unsafe-timestamp:",
      maxAgeMs: 86_400_000,
      maxEntries: 1,
    };
    insertQueueRow.run(
      "outbound",
      "unsafe-timestamp:bounded",
      JSON.stringify({
        id: "unsafe-timestamp:bounded",
        enqueuedAt: 60,
        retryCount: 1,
        completionRetention: unsafeTimestampRetention,
      }),
      60,
      61,
      62,
    );
    const backfillCapRetention = {
      idPrefix: "backfill-cap:",
      maxAgeMs: 86_400_000,
      maxEntries: 1,
    };
    for (const [id, terminalAt] of [
      ["backfill-cap:old", 70],
      ["backfill-cap:new", 71],
    ] as const) {
      insertQueueRow.run(
        "outbound",
        id,
        JSON.stringify({
          id,
          enqueuedAt: terminalAt,
          retryCount: 0,
          completionRetention: backfillCapRetention,
        }),
        terminalAt,
        terminalAt,
        terminalAt,
      );
    }
    db.exec(
      "UPDATE delivery_queue_entries SET retry_count = 9223372036854775807 WHERE id = 'unsafe-retry'",
    );
    db.exec(
      "UPDATE delivery_queue_entries SET updated_at = 9223372036854775807, failed_at = 9223372036854775807 WHERE id = 'unsafe-timestamp:bounded'",
    );
    db.close();

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(() =>
      database.db.prepare("SELECT session_key FROM sandbox_registry_entries LIMIT 1").all(),
    ).not.toThrow();
    expect(() =>
      database.db.prepare("SELECT session_key FROM delivery_queue_entries LIMIT 1").all(),
    ).not.toThrow();
    expect(
      database.db
        .prepare(
          `SELECT retry_count, last_attempt_at, last_error, entry_kind, session_key,
                  channel, target, account_id
             FROM delivery_queue_entries
            WHERE id = ?`,
        )
        .get("delivery-1"),
    ).toEqual({
      account_id: "acct-1",
      channel: "telegram",
      entry_kind: "message",
      last_attempt_at: 20,
      last_error: "no listener",
      retry_count: 3,
      session_key: "agent:main:main",
      target: "chat-1",
    });
    expect(
      database.db
        .prepare(
          `SELECT retry_count, last_attempt_at, platform_send_started_at
             FROM delivery_queue_entries
            WHERE id = 'delivery-invalid-integers'`,
        )
        .get(),
    ).toEqual({ retry_count: 0, last_attempt_at: null, platform_send_started_at: null });
    expect(loadDeliveryQueueEntry("outbound", "pending-failure-retention", stateDir)).toMatchObject(
      {
        failureRetention: "permanent",
        payloads: [{ text: "keep until terminal transition" }],
      },
    );
    expect(
      loadDeliveryQueueEntry(
        "outbound",
        "upgrade-bounded:v1:pending-completion-retention",
        stateDir,
      ),
    ).toMatchObject({
      completionRetention: pendingBoundedRetention,
      payloads: [{ text: "private" }],
    });
    expect(
      loadDeliveryQueueEntry("session", "pending-session-available-at", stateDir),
    ).toMatchObject({
      retainOnFailure: true,
      availableAt: 30,
      payloads: [{ text: "private claimed session" }],
    });
    expect(
      loadDeliveryQueueEntry("outbound-preparing-v1", "pending-stable-preparation", stateDir),
    ).toMatchObject({
      retainOnFailure: true,
      payloads: [{ text: "private stable preparation" }],
    });
    expect(
      loadDeliveryQueueEntry("outbound-prepared-v1", "pending-delivery-completion", stateDir),
    ).toMatchObject({
      retainOnFailure: true,
      deliveryCompletion: { kind: "conversation", operationId: "op-before-upgrade" },
      payloads: [{ text: "private durable completion" }],
    });
    expect(
      loadDeliveryQueueEntry("outbound-prepared-v1", "pending-ambiguous-platform-send", stateDir),
    ).toMatchObject({
      retainOnFailure: true,
      platformSendAttemptId: "attempt-before-upgrade",
      payloads: [{ text: "private ambiguous send" }],
    });
    const transientClaimIds = new Set(["pending-required-claim", "pending-producer-claim"]);
    for (const { queueName, ...pending } of pendingEntries) {
      const entry = loadDeliveryQueueEntry(queueName, pending.id, stateDir);
      expect(entry).not.toBeNull();
      expect(
        terminalizePendingDeliveryQueueEntry({
          queueName,
          id: pending.id,
          entry: entry!,
          stateDir,
        }),
      ).toEqual({ status: "terminalized", retained: !transientClaimIds.has(pending.id) });
    }
    const failureRowsSql = `
      SELECT id, entry_kind, session_key, channel, target, account_id, retry_count,
             last_attempt_at, last_error, recovery_state, platform_send_started_at,
             entry_json, enqueued_at, failed_at
        FROM delivery_queue_entries
       WHERE status = 'failed'
       ORDER BY id`;
    const failureRows = database.db.prepare(failureRowsSql).all() as Array<Record<string, unknown>>;
    const boundedRetentions = new Map([
      ["cron-direct-delivery:v1:canonical", boundedRetention],
      ["cron-direct-delivery:v1:failure", boundedRetention],
      ["cron-direct-delivery:v1:terminal", boundedRetention],
      ["upgrade-bounded:v1:pending-completion-retention", pendingBoundedRetention],
      ["unsafe-timestamp:bounded", unsafeTimestampRetention],
      ["backfill-cap:new", backfillCapRetention],
    ]);
    const retryCounts = new Map<string, number>([
      ["claimed-session-failure", 1],
      ["cron-direct-delivery:v1:canonical", 3],
      ["cron-direct-delivery:v1:failure", 4],
      ["cron-direct-delivery:v1:terminal", 5],
      ["delivery-completion", 9],
      ["terminal-permanent", 6],
      ["ambiguous-beta-failure", 2],
      ["unsafe-timestamp:bounded", 1],
    ]);
    for (const row of failureRows) {
      const id = String(row.id);
      const retryCount = retryCounts.get(id) ?? 0;
      const completionRetention = boundedRetentions.get(id) ?? "permanent";
      const recoveryState = boundedRetentions.has(id) ? "completed_bounded" : "completed_permanent";
      expect(row).toMatchObject({
        entry_kind: null,
        session_key: null,
        channel: null,
        target: null,
        account_id: null,
        retry_count: retryCount,
        last_attempt_at: null,
        last_error: null,
        recovery_state: recoveryState,
        platform_send_started_at: null,
        enqueued_at: row.failed_at,
      });
      expect(Number.isSafeInteger(row.retry_count)).toBe(true);
      expect(Number(row.retry_count)).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(String(row.entry_json))).toEqual({
        id,
        enqueuedAt: Number(row.failed_at),
        failedAt: Number(row.failed_at),
        retryCount,
        completionRetention,
        recoveryState,
      });
    }
    expect(failureRows).toHaveLength(19);
    for (const id of ["ambiguous-beta-failure", "malformed-failure", "unsafe-timestamp:bounded"]) {
      expect(failureRows.some((row) => row.id === id)).toBe(true);
    }
    const malformedRow = failureRows.find((row) => row.id === "malformed-failure");
    expect(Number(malformedRow?.failed_at)).toBeGreaterThan(0);
    expect(String(malformedRow?.entry_json)).not.toContain("private bytes");
    for (const id of [
      "legacy-none",
      "minimal-failure",
      "pending-producer-claim",
      "pending-required-claim",
      "rich-failure",
      "terminal-none",
      "backfill-cap:old",
    ]) {
      expect(failureRows.some((row) => row.id === id)).toBe(false);
    }
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);

    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    expect(reopened.db.prepare(failureRowsSql).all()).toEqual(failureRows);
    expect(getDeliveryQueueEntryStatus("outbound", "unsafe-timestamp:bounded", stateDir)).toBe(
      "failed",
    );
    expect(
      countFailedDeliveryQueueEntries(stateDir).some(
        ({ queueName, count }) => queueName === "outbound" && count > 0,
      ),
    ).toBe(true);
  });

  it("configures durable SQLite connection pragmas", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(readSqliteNumberPragma(database.db, "busy_timeout")).toBe(
      OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    );
    expect(readSqliteNumberPragma(database.db, "foreign_keys")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "synchronous")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "auto_vacuum")).toBe(2);
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
    expect(readSqliteNumberPragma(database.db, "wal_autocheckpoint")).toBe(1000);
    expect(readSqliteNumberPragma(database.db, "journal_size_limit")).toBe(64 * 1024 * 1024);
    const journalMode = database.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    expect(journalMode?.journal_mode?.toLowerCase()).toBe("wal");
  });

  it("reopens a canonical current schema while another connection holds the writer lock", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = openOpenClawStateDatabase(options).path;
    upsertDeliveryQueueEntry({
      queueName: "outbound",
      entry: {
        id: "pending-telegram-delivery",
        enqueuedAt: 1,
        retryCount: 0,
      },
      metadata: { channel: "telegram", target: "chat-1" },
      stateDir,
    });
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    writer.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
    try {
      expect(runWithOpenClawStateBusyTimeout((database) => database.db.isOpen, options, 0)).toBe(
        true,
      );
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
    }
  });

  it("configures the busy timeout before a doctor schema repair transaction", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
      | ((this: import("node:sqlite").DatabaseSync, sql: string) => void)
      | undefined;
    if (!originalExec) {
      throw new Error("DatabaseSync.exec descriptor is unavailable");
    }
    const statements: string[] = [];
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: import("node:sqlite").DatabaseSync,
      sql: string,
    ) {
      statements.push(sql);
      return originalExec.call(this, sql);
    });

    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);

    const timeoutIndex = statements.findIndex((sql) =>
      sql.includes(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}`),
    );
    const transactionIndex = statements.indexOf("BEGIN IMMEDIATE");
    expect(timeoutIndex).toBeGreaterThanOrEqual(0);
    expect(transactionIndex).toBeGreaterThan(timeoutIndex);
  });

  it("uses rollback journaling for shared state databases on NFS-backed volumes", () => {
    const stateDir = createTempStateDir();
    const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x6969));

    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    const journalMode = database.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    expect(journalMode?.journal_mode?.toLowerCase()).toBe("delete");
    expect(statfs).toHaveBeenCalledWith(fs.realpathSync(path.join(stateDir, "state")));
  });

  it("records durable schema metadata", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);

    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        stateDb.selectFrom("schema_meta").select(["role", "schema_version", "app_version"]),
      ),
    ).toEqual({
      role: "global",
      schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
      app_version: VERSION,
    });
  });

  it("latches newer global schema failures before integrity scans", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const databasePath = openOpenClawStateDatabase(options).path;
    closeOpenClawStateDatabaseForTest();
    createUnsafeIndexDrift(databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    db.close();

    let firstFailure: unknown;
    try {
      openOpenClawStateDatabase(options);
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toMatchObject({
      name: "SqliteSchemaVersionError",
      message: expect.stringContaining("https://docs.openclaw.ai/reference/database-schemas"),
    });

    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }
    let secondFailure: unknown;
    try {
      openOpenClawStateDatabase(options);
    } catch (error) {
      secondFailure = error;
    }
    expect(secondFailure).toBe(firstFailure);

    clearOpenClawStateDatabaseOpenFailure(databasePath);
    expect(openOpenClawStateDatabase(options).db.isOpen).toBe(true);
  });

  it("does not chmod shared parent directories for explicit database paths", () => {
    const databasePath = path.join(
      os.tmpdir(),
      `openclaw-explicit-state-${process.pid}-${Date.now()}.sqlite`,
    );

    expect(() => openOpenClawStateDatabase({ path: databasePath })).not.toThrow();
    expect(fs.existsSync(databasePath)).toBe(true);
  });

  it("keeps cached handles open when another state path is opened", () => {
    const firstPath = path.join(
      createTempStateDir(),
      "state",
      `first-${process.pid}-${Date.now()}.sqlite`,
    );
    const secondPath = path.join(
      createTempStateDir(),
      "state",
      `second-${process.pid}-${Date.now()}.sqlite`,
    );

    const first = openOpenClawStateDatabase({ path: firstPath });
    const second = openOpenClawStateDatabase({ path: secondPath });

    expect(first.db.isOpen).toBe(true);
    expect(second.db.isOpen).toBe(true);
    expect(openOpenClawStateDatabase({ path: firstPath })).toBe(first);
    expect(readSqliteNumberPragma(first.db, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
  });

  it("keys explicit relative paths by resolved database pathname", () => {
    const moduleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          import os from "node:os";
          import path from "node:path";
          import {
            closeOpenClawStateDatabaseForTest,
            openOpenClawStateDatabase,
          } from ${JSON.stringify(moduleUrl)};

          const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-db-relative-"));
          const firstDir = path.join(root, "first");
          const secondDir = path.join(root, "second");
          fs.mkdirSync(firstDir);
          fs.mkdirSync(secondDir);
          const previousCwd = process.cwd();
          try {
            process.chdir(firstDir);
            const firstPath = path.resolve("state.sqlite");
            const first = openOpenClawStateDatabase({ path: "state.sqlite" });
            first.db
              .prepare("INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at) VALUES (?, ?, ?, ?)")
              .run("relative-path", "first", "{}", 1);

            process.chdir(secondDir);
            const secondPath = path.resolve("state.sqlite");
            const second = openOpenClawStateDatabase({ path: "state.sqlite" });
            second.db
              .prepare("INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at) VALUES (?, ?, ?, ?)")
              .run("relative-path", "second", "{}", 2);

            console.log(JSON.stringify({
              sameHandle: first === second,
              firstPath,
              secondPath,
              firstFileExists: fs.existsSync(path.join(firstDir, "state.sqlite")),
              secondFileExists: fs.existsSync(path.join(secondDir, "state.sqlite")),
              firstRows: first.db.prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?").all("relative-path"),
              secondRows: second.db.prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?").all("relative-path"),
            }));
          } finally {
            process.chdir(previousCwd);
            closeOpenClawStateDatabaseForTest();
          }
        `,
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output) as {
      firstFileExists: boolean;
      firstRows: Array<{ event_key: string }>;
      sameHandle: boolean;
      secondFileExists: boolean;
      secondRows: Array<{ event_key: string }>;
    };

    expect(result.sameHandle).toBe(false);
    expect(result.firstFileExists).toBe(true);
    expect(result.secondFileExists).toBe(true);
    expect(result.firstRows).toEqual([{ event_key: "first" }]);
    expect(result.secondRows).toEqual([{ event_key: "second" }]);
  });

  it("uses savepoints for nested write transaction rollback", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    runOpenClawStateWriteTransaction((database) => {
      const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        stateDb.insertInto("diagnostic_events").values({
          scope: "transaction-test",
          event_key: "outer",
          payload_json: "{}",
          created_at: 1,
        }),
      );
      expect(() =>
        runOpenClawStateWriteTransaction((inner) => {
          const innerDb = getNodeSqliteKysely<StateDbTestDatabase>(inner.db);
          executeSqliteQuerySync(
            inner.db,
            innerDb.insertInto("diagnostic_events").values({
              scope: "transaction-test",
              event_key: "inner",
              payload_json: "{}",
              created_at: 2,
            }),
          );
          throw new Error("rollback nested");
        }, options),
      ).toThrow("rollback nested");
    }, options);

    const database = openOpenClawStateDatabase(options);
    const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
    expect(
      executeSqliteQuerySync(
        database.db,
        stateDb
          .selectFrom("diagnostic_events")
          .select("event_key")
          .where("scope", "=", "transaction-test")
          .orderBy("event_key"),
      ).rows.map((row) => row.event_key),
    ).toEqual(["outer"]);
  });

  it("reads ownership once inside each cached-owner transaction", () => {
    const options = { env: { OPENCLAW_STATE_DIR: createTempStateDir() } };
    const database = openOpenClawStateDatabase(options);
    const { constants } = requireNodeSqlite();
    let ownershipSelects = 0;
    let schemaReads = 0;
    database.db.setAuthorizer((actionCode, tableName) => {
      if (actionCode === constants.SQLITE_SELECT) {
        ownershipSelects += 1;
      }
      if (actionCode === constants.SQLITE_READ && tableName === "sqlite_master") {
        schemaReads += 1;
      }
      return constants.SQLITE_OK;
    });

    try {
      for (let index = 0; index < 12; index += 1) {
        runOpenClawStateWriteTransaction(() => undefined, options);
      }
    } finally {
      database.db.setAuthorizer(null);
    }

    expect(ownershipSelects).toBe(12);
    expect(schemaReads).toBe(0);
  });

  it("discovers the ownership table for an injected handle at transaction admission", () => {
    const options = { env: { OPENCLAW_STATE_DIR: createTempStateDir() } };
    const pathname = openOpenClawStateDatabase(options).path;
    closeOpenClawStateDatabaseForTest();
    const { constants, DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(pathname);
    let schemaReads = 0;
    db.setAuthorizer((actionCode, tableName) => {
      if (actionCode === constants.SQLITE_READ && tableName === "sqlite_master") {
        schemaReads += 1;
      }
      return constants.SQLITE_OK;
    });

    try {
      runOpenClawStateWriteTransaction(() => undefined, {
        ...options,
        database: {
          db,
          path: pathname,
          walMaintenance: { checkpoint: () => false, close: () => false },
        },
      });
    } finally {
      db.setAuthorizer(null);
      db.close();
    }

    expect(schemaReads).toBe(4);
  });

  it("rejects Promise-returning write transactions", () => {
    const stateDir = createTempStateDir();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    expect(() =>
      runOpenClawStateWriteTransaction(async () => {
        return "not sync";
      }, options),
    ).toThrow("must be synchronous");

    expect(() =>
      runOpenClawStateWriteTransaction((database) => {
        const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          stateDb.insertInto("diagnostic_events").values({
            scope: "transaction-test",
            event_key: "after",
            payload_json: "{}",
            created_at: 3,
          }),
        );
      }, options),
    ).not.toThrow();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
