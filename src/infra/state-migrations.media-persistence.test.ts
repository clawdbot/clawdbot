import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { appendTranscriptEventInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];
const PREVIOUS_VERSION = 16;

type FixtureEvent = Record<string, unknown>;

function createEvent(params: {
  id: string;
  message: Record<string, unknown>;
  parentId: string | null;
  timestamp: number;
}): FixtureEvent {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: params.timestamp,
    message: params.message,
  };
}

function createLegacyDatabaseFixture(params: {
  agentId?: string;
  env: NodeJS.ProcessEnv;
  eventsBySession: Record<string, FixtureEvent[]>;
  schemaVersion?: number;
}): string {
  const agentId = params.agentId ?? "main";
  const schemaVersion = params.schemaVersion ?? PREVIOUS_VERSION;
  const opened = openOpenClawAgentDatabase({ agentId, env: params.env });
  const databasePath = opened.path;
  closeOpenClawAgentDatabasesForTest();
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    if (schemaVersion < OPENCLAW_AGENT_SCHEMA_VERSION) {
      database.exec("DROP TABLE session_participants;");
    }
    database.exec(`PRAGMA user_version = ${schemaVersion};`);
    database
      .prepare(
        "UPDATE schema_meta SET schema_version = ?, app_version = ? WHERE meta_key = 'primary'",
      )
      .run(schemaVersion, "legacy-test");
    for (const [sessionId, events] of Object.entries(params.eventsBySession)) {
      const sessionKey = `agent:${agentId}:${sessionId}`;
      const firstTimestamp = Number(events[0]?.timestamp ?? 1);
      database
        .prepare(
          "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES(?,?,?,?)",
        )
        .run(sessionKey, sessionId, "{}", firstTimestamp);
      database
        .prepare(
          "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES(?,?,?,?)",
        )
        .run(sessionId, sessionKey, firstTimestamp, firstTimestamp);
      database
        .prepare(
          "INSERT INTO transcript_rewrite_watermarks(session_id,generation,updated_at) VALUES(?,?,?)",
        )
        .run(sessionId, `generation-${sessionId}`, firstTimestamp);
      events.forEach((event, seq) => {
        const createdAt = Number(event.timestamp ?? firstTimestamp) + 100;
        database
          .prepare(
            "INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES(?,?,?,?)",
          )
          .run(sessionId, seq, JSON.stringify(event), createdAt);
        database
          .prepare(
            "INSERT INTO transcript_event_identities(session_id,event_id,seq,event_type,parent_id,message_idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            sessionId,
            String(event.id),
            seq,
            String(event.type),
            typeof event.parentId === "string" ? event.parentId : null,
            (event.message as { idempotencyKey?: string }).idempotencyKey ?? null,
            createdAt,
          );
      });
      reconcileSessionTranscriptIndexInTransaction(database, sessionId);
    }
  } finally {
    database.close();
  }
  registerOpenClawAgentDatabase({
    agentId,
    env: params.env,
    path: databasePath,
    schemaVersion,
  });
  return databasePath;
}

function readDatabaseSnapshot(databasePath: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
    const rows = database
      .prepare(
        "SELECT session_id,seq,event_json,created_at FROM transcript_events ORDER BY session_id,seq",
      )
      .all() as Array<{
      session_id: string;
      seq: number;
      event_json: string;
      created_at: number;
    }>;
    const identities = database
      .prepare(
        "SELECT session_id,event_id,seq,event_type,parent_id,message_idempotency_key,created_at FROM transcript_event_identities ORDER BY session_id,seq",
      )
      .all();
    const activeBranch = database
      .prepare(
        "SELECT session_id,active_position,event_seq,message_position FROM session_transcript_active_events ORDER BY session_id,active_position",
      )
      .all();
    const windows = database
      .prepare(
        "SELECT session_id,session_key,created_at,updated_at,transcript_observed_at FROM session_windows ORDER BY session_id",
      )
      .all();
    const generations = database
      .prepare(
        "SELECT session_id,generation FROM transcript_rewrite_watermarks ORDER BY session_id",
      )
      .all();
    const trajectoryCount = database
      .prepare("SELECT count(*) AS count FROM trajectory_runtime_events")
      .get() as { count: number };
    const trajectoryRows = database
      .prepare(
        "SELECT session_id,seq,run_id,event_json,created_at FROM trajectory_runtime_events ORDER BY session_id,seq",
      )
      .all() as Array<{
      session_id: string;
      seq: number;
      run_id: string | null;
      event_json: string;
      created_at: number;
    }>;
    return {
      activeBranch,
      generations,
      identities,
      rows,
      trajectoryCount: trajectoryCount.count,
      trajectoryRows,
      version,
      windows,
    };
  } finally {
    database.close();
  }
}

function writeArchive(filePath: string, events: FixtureEvent[], compressed: boolean): void {
  const content = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!compressed) {
    fs.writeFileSync(filePath, content);
    return;
  }
  const encoded = encodeSessionArchiveContent(content);
  if (encoded.suffix !== SESSION_ARCHIVE_ZSTD_SUFFIX) {
    throw new Error("test runtime does not support zstd");
  }
  fs.writeFileSync(filePath, encoded.bytes);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("legacy media persistence doctor migration", () => {
  it("canonicalizes assistant media at the generic transcript append owner", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-append-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    runOpenClawAgentWriteTransaction(
      (database) => {
        expect(
          appendTranscriptEventInTransaction(
            database,
            {
              agentId: "main",
              env,
              sessionId: "append-session",
              sessionKey: "agent:main:append-session",
            },
            createEvent({
              id: "event-1",
              parentId: null,
              timestamp: 1000,
              message: {
                role: "assistant",
                content: "append",
                MediaPaths: ["/media/a.png"],
                MediaTypes: ["image/png"],
              },
            }),
          ),
        ).toBe(true);
      },
      { agentId: "main", env },
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const row = database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
      .get("append-session") as { event_json: string };
    const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> }).message;
    expect(message).toMatchObject({ role: "assistant", content: "append" });
    expect(message).not.toHaveProperty("MediaPaths");
    expect(message).not.toHaveProperty("MediaTypes");
    expect(message["__openclaw"]).toMatchObject({
      media: [expect.objectContaining({ path: "/media/a.png", contentType: "image/png" })],
    });
  });

  it("rewrites every active shape and trajectory snapshot, migrates mixed archives, and reruns as a no-op", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-migration-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const legacy = createEvent({
      id: "event-legacy",
      parentId: null,
      timestamp: 1000,
      message: {
        role: "user",
        content: "legacy",
        idempotencyKey: "idem-legacy",
        MediaPaths: ["/media/a.ogg", "/media/b.png"],
        MediaTypes: ["audio", "image/png"],
        MediaTranscribedIndexes: [0],
        MediaWorkspaceDir: "/workspace",
      },
    });
    const conflict = createEvent({
      id: "event-conflict",
      parentId: "event-legacy",
      timestamp: 2000,
      message: {
        role: "user",
        content: "conflict",
        MediaPath: "/legacy.png",
        MediaType: "image/png",
        __openclaw: {
          traceId: "trace-1",
          media: [{ path: "/canonical.jpg", contentType: "image/jpeg" }],
        },
      },
    });
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {
        "session-a": [legacy, conflict],
        "session-b": [
          createEvent({
            id: "event-sparse",
            parentId: null,
            timestamp: 3000,
            message: {
              role: "user",
              content: "sparse",
              MediaPaths: ["", "/media/c.pdf"],
              MediaTypes: ["", "application/pdf"],
            },
          }),
        ],
      },
    });
    const { DatabaseSync } = requireNodeSqlite();
    const trajectoryDatabase = new DatabaseSync(databasePath);
    trajectoryDatabase
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "session-a",
        0,
        "run-1",
        JSON.stringify({
          type: "model.completed",
          data: {
            messagesSnapshot: [legacy.message],
            modelOutput: "done",
            timing: { totalMs: 125 },
            toolTraces: [{ name: "read", durationMs: 5 }],
          },
        }),
        4000,
      );
    trajectoryDatabase
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "session-a",
        1,
        "run-1",
        JSON.stringify({ data: { toolArguments: { MediaPath: "/not-a-message-field" } } }),
        4001,
      );
    trajectoryDatabase
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "session-a",
        2,
        "run-1",
        JSON.stringify({
          data: {
            messagesSnapshot: [{ role: "user", media: [{ path: "/legacy-top-level.png" }] }],
          },
        }),
        4002,
      );
    const emptyCarrierEventJson = JSON.stringify({
      type: "model.completed",
      data: {
        messagesSnapshot: [
          { role: "user", content: "empty", media: [], MediaPaths: [], MediaTypes: [] },
        ],
        modelOutput: "empty",
      },
    });
    trajectoryDatabase
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run("session-a", 3, "run-1", emptyCarrierEventJson, 4003);
    trajectoryDatabase.close();

    const archiveDir = path.join(stateDir, "agents", "main", "sessions");
    const plainArchive = path.join(archiveDir, "cold-plain.jsonl.deleted.2026-07-24T01-02-03.000Z");
    const compressedArchive = `${path.join(
      archiveDir,
      "cold-zstd.jsonl.reset.2026-07-24T01-02-04.000Z",
    )}${SESSION_ARCHIVE_ZSTD_SUFFIX}`;
    writeArchive(plainArchive, [legacy], false);
    writeArchive(compressedArchive, [conflict], true);

    const before = readDatabaseSnapshot(databasePath);
    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(4);
    expect(result.changes).toEqual(
      expect.arrayContaining([
        `Upgraded agent database schema in ${databasePath}: v16 -> v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
        `Migrated media persistence in ${databasePath}: 2 transcript session(s), 2 trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
        `Migrated archived transcript media in ${plainArchive}.`,
        `Migrated archived transcript media in ${compressedArchive}.`,
      ]),
    );

    const after = readDatabaseSnapshot(databasePath);
    expect(after.version.user_version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(after.trajectoryCount).toBe(4);
    expect(after.trajectoryRows.map(({ event_json: _eventJson, ...row }) => row)).toEqual(
      before.trajectoryRows.map(({ event_json: _eventJson, ...row }) => row),
    );
    const migratedTrajectory = JSON.parse(after.trajectoryRows[0]?.event_json ?? "null") as {
      data?: Record<string, unknown>;
    };
    expect(migratedTrajectory.data).toMatchObject({
      modelOutput: "done",
      timing: { totalMs: 125 },
      toolTraces: [{ name: "read", durationMs: 5 }],
    });
    const migratedMessagesSnapshot = migratedTrajectory.data?.messagesSnapshot;
    expect(migratedMessagesSnapshot).toBeInstanceOf(Array);
    const migratedTrajectoryMessage = (
      migratedMessagesSnapshot as Array<Record<string, unknown>>
    )[0];
    expect(migratedTrajectoryMessage).not.toHaveProperty("MediaPaths");
    expect(migratedTrajectoryMessage?.["__openclaw"]).toMatchObject({
      media: [
        expect.objectContaining({ path: "/media/a.ogg" }),
        expect.objectContaining({ path: "/media/b.png" }),
      ],
    });
    expect(after.trajectoryRows[1]?.event_json).toBe(before.trajectoryRows[1]?.event_json);
    const topLevelMediaMessage = (
      JSON.parse(after.trajectoryRows[2]?.event_json ?? "null") as {
        data: { messagesSnapshot: Array<Record<string, unknown>> };
      }
    ).data.messagesSnapshot[0];
    expect(topLevelMediaMessage).not.toHaveProperty("media");
    expect(topLevelMediaMessage?.["__openclaw"]).toMatchObject({
      media: [expect.objectContaining({ path: "/legacy-top-level.png" })],
    });
    expect(after.trajectoryRows[3]?.event_json).toBe(emptyCarrierEventJson);
    expect(after.rows.map((row) => row.created_at)).toEqual(
      before.rows.map((row) => row.created_at),
    );
    expect(after.identities).toEqual(before.identities);
    expect(after.activeBranch).toEqual(before.activeBranch);
    expect(after.windows).toEqual(before.windows);
    expect(after.generations).not.toEqual(before.generations);
    const messages = after.rows.map((row) => (JSON.parse(row.event_json) as FixtureEvent).message);
    expect(messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "legacy",
        idempotencyKey: "idem-legacy",
        __openclaw: {
          media: [
            expect.objectContaining({ kind: "audio", transcribed: true }),
            expect.objectContaining({ contentType: "image/png" }),
          ],
        },
      }),
      expect.objectContaining({
        __openclaw: {
          traceId: "trace-1",
          media: [expect.objectContaining({ path: "/canonical.jpg" })],
        },
      }),
      expect.objectContaining({
        __openclaw: {
          media: [expect.any(Object), expect.objectContaining({ path: "/media/c.pdf" })],
        },
      }),
    ]);
    for (const message of messages) {
      expect(JSON.stringify(message)).not.toMatch(/"Media(?:Path|Paths|Type|Types|Url|Urls)/u);
    }
    expect(readSessionArchiveContentSync(plainArchive)).toContain('"__openclaw"');
    expect(readSessionArchiveContentSync(compressedArchive)).toContain('"__openclaw"');

    expect(openOpenClawAgentDatabase({ agentId: "main", env }).db.isOpen).toBe(true);
    closeOpenClawAgentDatabasesForTest();
    expect(await migrateLegacyMediaPersistence({ env })).toEqual({ changes: [], warnings: [] });
  });

  it("upgrades the existing v14 structural schema before the media cutover", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-v14-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {
        legacy: [
          createEvent({
            id: "event-1",
            parentId: null,
            timestamp: 1000,
            message: { role: "user", content: "legacy", MediaPath: "/media/a.png" },
          }),
        ],
      },
    });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP TABLE session_suggestions;
      PRAGMA user_version = 14;
      UPDATE schema_meta SET schema_version = 14 WHERE meta_key = 'primary';
    `);
    database.close();

    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        after
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_suggestions'",
          )
          .get(),
      ).toEqual({ name: "session_suggestions" });
      const row = after
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
        .get("legacy") as { event_json: string };
      const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> }).message;
      expect(message).not.toHaveProperty("MediaPath");
      expect(message["__openclaw"]).toMatchObject({
        media: [expect.objectContaining({ path: "/media/a.png" })],
      });
    } finally {
      after.close();
    }
  });

  it("upgrades an owned v0 database through the media prerequisite schema", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-v0-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {
        legacy: [
          createEvent({
            id: "event-1",
            parentId: null,
            timestamp: 1000,
            message: { role: "user", content: "legacy", MediaPath: "/media/a.png" },
          }),
        ],
      },
    });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA user_version = 0;
      UPDATE schema_meta SET schema_version = 0 WHERE meta_key = 'primary';
    `);
    database.close();

    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    const after = readDatabaseSnapshot(databasePath);
    expect(after.version.user_version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    const message = (JSON.parse(after.rows[0]?.event_json ?? "null") as FixtureEvent).message;
    expect(message).not.toHaveProperty("MediaPath");
  });

  it("migrates complete PR-1 facts beside a compact legacy projection", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-dual-write-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {
        dual: [
          createEvent({
            id: "event-1",
            parentId: null,
            timestamp: 1000,
            message: {
              role: "user",
              content: "dual",
              MediaPaths: ["/media/a.bin", "/media/b.pdf"],
              MediaTypes: ["application/pdf"],
              __openclaw: {
                media: [
                  { path: "/media/a.bin", contentType: "application/octet-stream" },
                  { path: "/media/b.pdf", contentType: "application/pdf" },
                ],
              },
            },
          }),
        ],
      },
    });

    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    const after = readDatabaseSnapshot(databasePath);
    expect(after.version.user_version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    const message = (
      JSON.parse(after.rows[0]?.event_json ?? "null") as {
        message: Record<string, unknown>;
      }
    ).message;
    expect(message).not.toHaveProperty("MediaPaths");
    expect(message).not.toHaveProperty("MediaTypes");
    expect(message["__openclaw"]).toMatchObject({
      media: [
        expect.objectContaining({
          path: "/media/a.bin",
          contentType: "application/octet-stream",
        }),
        expect.objectContaining({ path: "/media/b.pdf", contentType: "application/pdf" }),
      ],
    });
  });

  it("repairs a missing canonical v15 index before the media cutover", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-v15-index-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {
        legacy: [
          createEvent({
            id: "event-1",
            parentId: null,
            timestamp: 1000,
            message: { role: "user", content: "legacy", MediaPath: "/media/a.png" },
          }),
        ],
      },
    });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec("DROP INDEX idx_agent_transcript_event_parent;");
    database.close();

    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        after
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_event_parent'",
          )
          .get(),
      ).toEqual({ name: "idx_agent_transcript_event_parent" });
    } finally {
      after.close();
    }
  });

  it.each([PREVIOUS_VERSION, OPENCLAW_AGENT_SCHEMA_VERSION])(
    "canonicalizes retired media carriers on every transcript message role at schema v%s",
    async (schemaVersion) => {
      const stateDir = makeTempDir(tempDirs, "media-persistence-message-roles-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath = createLegacyDatabaseFixture({
        env,
        schemaVersion,
        eventsBySession: {
          roles: [
            createEvent({
              id: "event-assistant",
              parentId: null,
              timestamp: 1000,
              message: { role: "assistant", content: "result", MediaPath: "/media/result.png" },
            }),
            createEvent({
              id: "event-roleless",
              parentId: "event-assistant",
              timestamp: 2000,
              message: { content: "imported", MediaPath: "/media/imported.png" },
            }),
          ],
        },
      });

      const result = await migrateLegacyMediaPersistence({ env });
      expect(result).toEqual({
        changes: [
          ...(schemaVersion < OPENCLAW_AGENT_SCHEMA_VERSION
            ? [
                `Upgraded agent database schema in ${databasePath}: v${schemaVersion} -> v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
              ]
            : []),
          `Migrated media persistence in ${databasePath}: 1 transcript session(s), 0 trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
        ],
        warnings: [],
      });
      const messages = readDatabaseSnapshot(databasePath).rows.map(
        (row) => (JSON.parse(row.event_json) as FixtureEvent).message,
      );
      expect(messages).toEqual([
        expect.objectContaining({
          role: "assistant",
          __openclaw: { media: [expect.objectContaining({ path: "/media/result.png" })] },
        }),
        expect.objectContaining({
          __openclaw: { media: [expect.objectContaining({ path: "/media/imported.png" })] },
        }),
      ]);
      for (const message of messages) {
        expect(message).not.toHaveProperty("MediaPath");
      }
      expect(await migrateLegacyMediaPersistence({ env })).toEqual({ changes: [], warnings: [] });
    },
  );

  it("canonicalizes legacy trajectory metadata onto existing facts", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-trajectory-metadata-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {
        metadata: [
          createEvent({
            id: "event-1",
            parentId: null,
            timestamp: 1000,
            message: {
              role: "user",
              content: "metadata",
              __openclaw: {
                media: [{ path: "/media/a.png", contentType: "image/png" }],
              },
            },
          }),
        ],
      },
    });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "metadata",
        0,
        "run-1",
        JSON.stringify({
          data: {
            messagesSnapshot: [
              {
                role: "user",
                content: "metadata",
                __openclaw: {
                  media: [{ path: "/media/a.png", contentType: "image/png" }],
                },
                MediaTranscribedIndexes: [0],
                MediaWorkspaceDir: "/workspace",
                MediaStaged: true,
              },
            ],
            timing: { totalMs: 10 },
          },
        }),
        1100,
      );
    database.close();

    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    const after = readDatabaseSnapshot(databasePath);
    expect(after.trajectoryRows).toHaveLength(1);
    const event = JSON.parse(after.trajectoryRows[0]?.event_json ?? "null") as {
      data: { messagesSnapshot: Array<Record<string, unknown>>; timing: { totalMs: number } };
    };
    expect(event.data.timing).toEqual({ totalMs: 10 });
    const message = event.data.messagesSnapshot[0];
    expect(message).not.toHaveProperty("MediaTranscribedIndexes");
    expect(message).not.toHaveProperty("MediaWorkspaceDir");
    expect(message).not.toHaveProperty("MediaStaged");
    expect(message?.["__openclaw"]).toMatchObject({
      media: [
        expect.objectContaining({
          path: "/media/a.png",
          transcribed: true,
          workspaceDir: "/workspace",
          staged: true,
        }),
      ],
    });
  });

  it("preserves duplicate physical transcript rows during canonicalization", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-duplicates-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const event = createEvent({
      id: "duplicate-event",
      parentId: null,
      timestamp: 1000,
      message: { role: "user", content: "duplicate", MediaPath: "/media/a.png" },
    });
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: { duplicates: [event] },
    });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database
      .prepare(
        "INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES(?,?,?,?)",
      )
      .run("duplicates", 1, JSON.stringify(event), 1200);
    database.close();

    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    const rows = readDatabaseSnapshot(databasePath).rows;
    expect(rows).toHaveLength(2);
    const migrated = rows.map((row) => JSON.parse(row.event_json) as FixtureEvent);
    expect(migrated.map((entry) => entry.id)).toEqual(["duplicate-event", "duplicate-event"]);
    for (const entry of migrated) {
      expect(entry.message).not.toHaveProperty("MediaPath");
      expect(entry.message).toMatchObject({
        __openclaw: { media: [expect.objectContaining({ path: "/media/a.png" })] },
      });
    }
  });

  it("aborts one database on invalid JSON without advancing its version", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-corrupt-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {
        corrupt: [
          createEvent({
            id: "event-1",
            parentId: null,
            timestamp: 1000,
            message: { role: "user", MediaPath: "/media/a.png" },
          }),
        ],
      },
    });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database
      .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 0")
      .run("{broken", "corrupt");
    database.close();

    expect(() => openOpenClawAgentDatabase({ agentId: "main", env })).toThrow(
      "run openclaw doctor --fix to migrate persisted media",
    );
    closeOpenClawAgentDatabasesForTest();
    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toHaveLength(1);
    expect(result.changes).toEqual([]);
    expect(result.warnings[0]).toContain(`Skipped agent database migration for ${databasePath}:`);
    expect(result.warnings[0]).toContain("invalid transcript JSON");
    expect(readDatabaseSnapshot(databasePath).version.user_version).toBe(PREVIOUS_VERSION);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ path: databasePath, schemaVersion: PREVIOUS_VERSION })]);
  });

  it("aborts one database on invalid trajectory JSON without advancing its version", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-corrupt-trajectory-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {
        corrupt: [
          createEvent({
            id: "event-1",
            parentId: null,
            timestamp: 1000,
            message: { role: "user", MediaPath: "/media/a.png" },
          }),
        ],
      },
    });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run("corrupt", 0, "run-1", "{broken", 2000);
    database.close();

    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toHaveLength(1);
    expect(result.changes).toEqual([]);
    expect(result.warnings[0]).toContain(`Skipped agent database migration for ${databasePath}:`);
    expect(result.warnings[0]).toContain("invalid trajectory JSON");
    const snapshot = readDatabaseSnapshot(databasePath);
    expect(snapshot.version.user_version).toBe(PREVIOUS_VERSION);
    expect(snapshot.trajectoryCount).toBe(1);
  });

  it("aborts on active-row drift and archive source replacement without partial deletion", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-drift-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const { DatabaseSync } = requireNodeSqlite();
    const event = createEvent({
      id: "event-1",
      parentId: null,
      timestamp: 1000,
      message: { role: "user", content: "before", MediaPath: "/media/a.png" },
    });
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: { drift: [event] },
    });
    const transcriptDrift = await migrateLegacyMediaPersistence({
      env,
      hooks: {
        beforeDatabaseTransaction: (pathname) => {
          if (pathname !== databasePath) {
            return;
          }
          const writer = new DatabaseSync(databasePath);
          writer
            .prepare(
              "UPDATE transcript_events SET created_at = created_at + 1 WHERE session_id = ?",
            )
            .run("drift");
          writer.close();
        },
      },
    });
    expect(transcriptDrift.warnings.join("\n")).toContain("source changed");
    expect(readDatabaseSnapshot(databasePath).version.user_version).toBe(PREVIOUS_VERSION);

    const trajectoryWriter = new DatabaseSync(databasePath);
    trajectoryWriter
      .prepare(
        "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        "drift",
        0,
        "run-1",
        JSON.stringify({ data: { messagesSnapshot: [{ role: "user", MediaPath: "/old.png" }] } }),
        2000,
      );
    trajectoryWriter.close();
    const trajectoryDrift = await migrateLegacyMediaPersistence({
      env,
      hooks: {
        beforeDatabaseTransaction: (pathname) => {
          if (pathname !== databasePath) {
            return;
          }
          const writer = new DatabaseSync(databasePath);
          writer
            .prepare(
              "UPDATE trajectory_runtime_events SET event_json = ? WHERE session_id = ? AND seq = 0",
            )
            .run(
              JSON.stringify({
                data: { messagesSnapshot: [{ role: "user", MediaPath: "/changed.png" }] },
              }),
              "drift",
            );
          writer.close();
        },
      },
    });
    expect(trajectoryDrift.warnings.join("\n")).toContain("trajectory source changed");
    expect(readDatabaseSnapshot(databasePath).version.user_version).toBe(PREVIOUS_VERSION);

    const archivePath = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "drift.jsonl.deleted.2026-07-24T01-02-03.000Z",
    );
    writeArchive(archivePath, [event], false);
    const archiveDrift = await migrateLegacyMediaPersistence({
      env,
      hooks: {
        beforeArchiveReplace: (candidate) => {
          if (candidate === archivePath) {
            fs.writeFileSync(archivePath, "replacement\n");
          }
        },
      },
    });
    expect(archiveDrift.warnings.join("\n")).toContain("changed before atomic");
    expect(fs.readFileSync(archivePath, "utf8")).toBe("replacement\n");
  });

  it("rejects ambiguous sparse arrays and ignores stale interrupted temp files", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-sparse-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    createLegacyDatabaseFixture({ env, eventsBySession: {} });
    const archiveDir = path.join(stateDir, "agents", "main", "sessions");
    const archivePath = path.join(archiveDir, "sparse.jsonl.bak.2026-07-24T01-02-03.000Z");
    const event = createEvent({
      id: "event-1",
      parentId: null,
      timestamp: 1000,
      message: {
        role: "user",
        MediaPaths: ["", "/media/b.png"],
        MediaTypes: ["image/png"],
      },
    });
    writeArchive(archivePath, [event], false);
    expect((await migrateLegacyMediaPersistence({ env })).warnings.join("\n")).toContain(
      "ambiguous sparse positional alignment",
    );
    fs.unlinkSync(archivePath);

    const corruptArchivePath = path.join(
      archiveDir,
      "corrupt.jsonl.deleted.2026-07-24T01-02-04.000Z",
    );
    fs.writeFileSync(corruptArchivePath, "{broken\n");
    expect((await migrateLegacyMediaPersistence({ env })).warnings.join("\n")).toContain(
      "invalid transcript JSON",
    );
    expect(fs.readFileSync(corruptArchivePath, "utf8")).toBe("{broken\n");
    fs.unlinkSync(corruptArchivePath);

    writeArchive(
      archivePath,
      [
        createEvent({
          id: "event-1",
          parentId: null,
          timestamp: 1000,
          message: { role: "user", MediaPath: "/media/a.png", MediaType: "image/png" },
        }),
      ],
      false,
    );
    fs.writeFileSync(`${archivePath}.media-retirement.999.interrupted.tmp`, "partial");
    expect((await migrateLegacyMediaPersistence({ env })).changes.join("\n")).toContain(
      "Migrated archived transcript media",
    );
    expect(readSessionArchiveContentSync(archivePath)).toContain('"__openclaw"');
  });
});
