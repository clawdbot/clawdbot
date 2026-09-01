import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  assertAgentDatabaseMaintenanceAuthority,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withLegacySessionParticipantsSchema } from "../state/openclaw-agent-participants-migration.js";
import { sessionParticipantsSchemaSql } from "../state/openclaw-agent-session-participants-schema.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { migrateHistoricalTranscriptDirectives } from "./state-migrations.transcript-directives.js";

const tempDirs: string[] = [];

type FixtureEvent = Record<string, unknown>;

function messageEvent(params: {
  content: unknown;
  id: string;
  parentId?: string | null;
  role: "assistant" | "toolResult" | "user";
  timestamp: number;
}): FixtureEvent {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId ?? null,
    timestamp: params.timestamp,
    message: {
      role: params.role,
      content: params.content,
      timestamp: params.timestamp,
      ...(params.role === "assistant"
        ? {
            api: "messages",
            provider: "anthropic",
            model: "sonnet-4.6",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
          }
        : {}),
    },
  };
}

function insertSession(
  database: import("node:sqlite").DatabaseSync,
  params: { events: FixtureEvent[]; generation: string; sessionId: string },
): void {
  const sessionKey = `agent:main:${params.sessionId}`;
  database
    .prepare(
      `INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at)
       VALUES(?,?,?,?)`,
    )
    .run(sessionKey, params.sessionId, "{}", 1);
  database
    .prepare(
      `INSERT INTO session_windows(session_id,session_key,created_at,updated_at,transcript_updated_at)
       VALUES(?,?,?,?,?)`,
    )
    .run(params.sessionId, sessionKey, 1, 1, 1);
  database
    .prepare(
      `INSERT INTO transcript_rewrite_watermarks(session_id,generation,updated_at)
       VALUES(?,?,?)`,
    )
    .run(params.sessionId, params.generation, 1);
  for (const [seq, event] of params.events.entries()) {
    database
      .prepare(
        `INSERT INTO transcript_events(session_id,seq,event_json,created_at)
         VALUES(?,?,?,?)`,
      )
      .run(params.sessionId, seq, JSON.stringify(event), Number(event.timestamp ?? 1));
  }
  reconcileSessionTranscriptIndexInTransaction(database, params.sessionId);
}

function readEventJson(databasePath: string, sessionId: string, seq: number): string {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = ?")
      .get(sessionId, seq) as { event_json: string };
    return row.event_json;
  } finally {
    database.close();
  }
}

function readGeneration(databasePath: string, sessionId: string): string {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
      .get(sessionId) as { generation: string };
    return row.generation;
  } finally {
    database.close();
  }
}

function readMigrationCursor(databasePath: string): unknown {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT app_version FROM schema_meta WHERE meta_key = 'historical-transcript-directives-v1'",
      )
      .get() as { app_version: string };
    return JSON.parse(row.app_version);
  } finally {
    database.close();
  }
}

function hasTranscriptArchivesTable(databasePath: string): boolean {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Boolean(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("session_transcript_archives"),
    );
  } finally {
    database.close();
  }
}

function parseArchive(content: string): FixtureEvent[] {
  return content
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureEvent);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("historical transcript directive migration", () => {
  it("migrates assistant rows and archives while preserving code and derived indexes", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-migration-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    const tagged = messageEvent({
      id: "tagged-assistant",
      role: "assistant",
      timestamp: 10,
      content: [
        {
          type: "text",
          text: "[[reply_to_current]]\n[[reply_to: message-7 ]]\n[[audio_as_voice]]\nFinal answer [[react: 👍]]",
        },
      ],
    });
    const user = messageEvent({
      id: "user-marker",
      parentId: "tagged-assistant",
      role: "user",
      timestamp: 11,
      content: "Keep [[reply_to_current]] and [[react: 👍]]",
    });
    const tool = messageEvent({
      id: "tool-marker",
      parentId: "user-marker",
      role: "toolResult",
      timestamp: 12,
      content: [{ type: "text", text: "Keep [[audio_as_voice]]" }],
    });
    const codeText = [
      "Use `[[reply_to_current]]` and `[[react: 👍]]` literally.",
      "```text",
      "[[audio_as_voice]]",
      "[[react_to_current: ✅]]",
      "```",
    ].join("\n");
    const code = messageEvent({
      id: "code-assistant",
      role: "assistant",
      timestamp: 20,
      content: [{ type: "text", text: codeText }],
    });
    const reaction = messageEvent({
      id: "reaction-assistant",
      role: "assistant",
      timestamp: 30,
      content: [{ type: "text", text: "Reacted [[react_to_current: ✅]] without a fact" }],
    });
    insertSession(opened.db, {
      events: [tagged, user, tool],
      generation: "tagged-before",
      sessionId: "tagged-session",
    });
    insertSession(opened.db, {
      events: [code],
      generation: "code-before",
      sessionId: "code-session",
    });
    insertSession(opened.db, {
      events: [reaction],
      generation: "reaction-before",
      sessionId: "reaction-session",
    });

    const archivedTagged = messageEvent({
      id: "archived-tagged",
      role: "assistant",
      timestamp: 40,
      content: [{ type: "text", text: "[[reply_to: archive-2]] Archived answer" }],
    });
    const archivedCode = messageEvent({
      id: "archived-code",
      role: "assistant",
      timestamp: 41,
      content: [{ type: "text", text: "`[[reply_to_current]]`" }],
    });
    const archivedUser = messageEvent({
      id: "archived-user",
      role: "user",
      timestamp: 42,
      content: "[[audio_as_voice]]",
    });
    const archiveContent = `${[archivedTagged, archivedCode, archivedUser]
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`;
    const archiveBytes = Buffer.from(archiveContent, "utf8");
    const archiveName = "archived-session.jsonl.deleted.2026-01-01T00-00-00.000Z.archive-gen";
    opened.db
      .prepare(
        `INSERT INTO session_transcript_archives(
          session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
          archive_name,created_at,published_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "archived-session",
        "archive-gen",
        "agent:main:archived-session",
        "deleted",
        "identity",
        archiveBytes,
        createHash("sha256").update(archiveBytes).digest("hex"),
        archiveName,
        40,
        50,
      );
    const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
      agentId: "main",
      path: databasePath,
    });
    fs.mkdirSync(archiveDirectory, { recursive: true });
    const archivePath = path.join(archiveDirectory, archiveName);
    fs.writeFileSync(archivePath, archiveBytes);

    const codeEventJson = JSON.stringify(code);
    const userEventJson = JSON.stringify(user);
    const toolEventJson = JSON.stringify(tool);
    const archivedCodeJson = JSON.stringify(archivedCode);
    const archivedUserJson = JSON.stringify(archivedUser);
    closeOpenClawAgentDatabasesForTest();

    const result = await migrateHistoricalTranscriptDirectives({ env });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);

    const migratedTagged = JSON.parse(readEventJson(databasePath, "tagged-session", 0)) as {
      message: Record<string, unknown>;
    };
    expect(migratedTagged.message).toMatchObject({
      content: [{ type: "text", text: "Final answer" }],
      openclawDelivery: {
        audioAsVoice: true,
        replyToId: "message-7",
      },
    });
    expect(readEventJson(databasePath, "tagged-session", 1)).toBe(userEventJson);
    expect(readEventJson(databasePath, "tagged-session", 2)).toBe(toolEventJson);
    expect(readEventJson(databasePath, "code-session", 0)).toBe(codeEventJson);
    const migratedReaction = JSON.parse(readEventJson(databasePath, "reaction-session", 0)) as {
      message: Record<string, unknown>;
    };
    expect(migratedReaction.message).toMatchObject({
      content: [{ type: "text", text: "Reacted  without a fact" }],
    });
    expect(migratedReaction.message).not.toHaveProperty("openclawDelivery");

    expect(readGeneration(databasePath, "tagged-session")).not.toBe("tagged-before");
    expect(readGeneration(databasePath, "reaction-session")).not.toBe("reaction-before");
    expect(readGeneration(databasePath, "code-session")).toBe("code-before");

    const { DatabaseSync } = requireNodeSqlite();
    const migratedDb = new DatabaseSync(databasePath, { readOnly: true });
    let archivedRow: { archive_blob: Uint8Array; archive_sha256: string };
    try {
      expect(
        migratedDb
          .prepare(
            "SELECT session_id FROM session_transcript_fts WHERE session_transcript_fts MATCH ?",
          )
          .all("Final"),
      ).toContainEqual({ session_id: "tagged-session" });
      archivedRow = migratedDb
        .prepare(
          "SELECT archive_blob,archive_sha256 FROM session_transcript_archives WHERE session_id = ?",
        )
        .get("archived-session") as typeof archivedRow;
    } finally {
      migratedDb.close();
    }
    expect(createHash("sha256").update(archivedRow.archive_blob).digest("hex")).toBe(
      archivedRow.archive_sha256,
    );
    const migratedArchiveContent = Buffer.from(archivedRow.archive_blob).toString("utf8");
    const migratedArchive = parseArchive(migratedArchiveContent);
    expect(migratedArchive[0]).toMatchObject({
      message: {
        content: [{ type: "text", text: "Archived answer" }],
        openclawDelivery: { replyToId: "archive-2" },
      },
    });
    expect(migratedArchiveContent).toContain(archivedCodeJson);
    expect(migratedArchiveContent).toContain(archivedUserJson);
    expect(readSessionArchiveContentSync(archivePath)).toBe(migratedArchiveContent);

    const generationsAfterFirstRun = {
      tagged: readGeneration(databasePath, "tagged-session"),
      reaction: readGeneration(databasePath, "reaction-session"),
    };
    const archiveBytesAfterFirstRun = fs.readFileSync(archivePath);
    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(readGeneration(databasePath, "tagged-session")).toBe(generationsAfterFirstRun.tagged);
    expect(readGeneration(databasePath, "reaction-session")).toBe(
      generationsAfterFirstRun.reaction,
    );
    expect(fs.readFileSync(archivePath)).toEqual(archiveBytesAfterFirstRun);
  });

  it("resumes after the committed transcript cursor", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-resume-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    insertSession(opened.db, {
      events: [
        messageEvent({
          id: "already-migrated",
          role: "assistant",
          timestamp: 1,
          content: [{ type: "text", text: "Already clean" }],
        }),
      ],
      generation: "already-bumped",
      sessionId: "resume-a",
    });
    insertSession(opened.db, {
      events: [
        messageEvent({
          id: "still-pending",
          role: "assistant",
          timestamp: 2,
          content: [{ type: "text", text: "[[audio_as_voice]] Pending" }],
        }),
      ],
      generation: "pending-before",
      sessionId: "resume-b",
    });
    opened.db
      .prepare(
        `INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        "historical-transcript-directives-v1",
        "agent",
        1,
        "main",
        JSON.stringify({ phase: "transcripts", sessionId: "resume-a" }),
        1,
        1,
      );
    closeOpenClawAgentDatabasesForTest();

    expect((await migrateHistoricalTranscriptDirectives({ env })).warnings).toEqual([]);
    expect(readGeneration(databasePath, "resume-a")).toBe("already-bumped");
    expect(readGeneration(databasePath, "resume-b")).not.toBe("pending-before");
    expect(JSON.parse(readEventJson(databasePath, "resume-b", 0))).toMatchObject({
      message: {
        content: [{ type: "text", text: "Pending" }],
        openclawDelivery: { audioAsVoice: true },
      },
    });
  });

  it("completes an old-schema database without the optional archives table", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-old-schema-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    insertSession(opened.db, {
      events: [
        messageEvent({
          id: "old-schema-tagged",
          role: "assistant",
          timestamp: 1,
          content: [{ type: "text", text: "[[audio_as_voice]] Pending" }],
        }),
      ],
      generation: "before",
      sessionId: "old-schema-session",
    });
    opened.db.exec("DROP TABLE session_transcript_archives");
    closeOpenClawAgentDatabasesForTest();

    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual({
      changes: [expect.stringContaining("1 active session(s), 0 archived transcript(s)")],
      warnings: [],
    });
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete" });
    expect(hasTranscriptArchivesTable(databasePath)).toBe(false);
    expect(JSON.parse(readEventJson(databasePath, "old-schema-session", 0))).toMatchObject({
      message: {
        content: [{ type: "text", text: "Pending" }],
        openclawDelivery: { audioAsVoice: true },
      },
    });
    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("completes a pre-stuck archives cursor when the optional table is absent", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-stuck-archives-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    opened.db.exec("DROP TABLE session_transcript_archives");
    opened.db
      .prepare(
        `INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        "historical-transcript-directives-v1",
        "agent",
        1,
        "main",
        JSON.stringify({ generation: "", phase: "archives", sessionId: "" }),
        1,
        1,
      );
    closeOpenClawAgentDatabasesForTest();

    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete" });
    expect(hasTranscriptArchivesTable(databasePath)).toBe(false);
  });

  it("acquires stopped-writer maintenance before upgrading an older agent database", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-old-agent-schema-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    opened.db.exec(`
      DROP TABLE session_participants;
      ${withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql())}
      PRAGMA user_version = 17;
      UPDATE schema_meta SET schema_version = 17 WHERE meta_key = 'primary';
    `);
    closeOpenClawAgentDatabasesForTest();

    const result = await migrateHistoricalTranscriptDirectives({ env });

    expect(result.warnings).toEqual([]);
    const migrated = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(19);
    } finally {
      migrated.close();
    }
  });

  it("renews maintenance during a versioned schema upgrade beyond the original lease lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const startedAt = Date.now();
    const stateDir = makeTempDir(tempDirs, "transcript-directive-old-schema-renewal-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    opened.db.exec(`
      DROP TABLE session_participants;
      ${withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql())}
      PRAGMA user_version = 17;
      UPDATE schema_meta SET schema_version = 17 WHERE meta_key = 'primary';
    `);
    closeOpenClawAgentDatabasesForTest();

    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    const originalRenew = agentDatabaseLease.renewAgentDatabaseMaintenanceAuthorityIfPresent;
    const renew = vi
      .spyOn(agentDatabaseLease, "renewAgentDatabaseMaintenanceAuthorityIfPresent")
      .mockImplementation(() => {
        vi.setSystemTime(Date.now() + 30_000);
        originalRenew();
      });

    const result = await migrateHistoricalTranscriptDirectives({ env });

    expect(result.warnings).toEqual([]);
    expect(Date.now() - startedAt).toBeGreaterThan(60_000);
    expect(renew).toHaveBeenCalledTimes(3);
    const migrated = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(19);
    } finally {
      migrated.close();
    }
  });

  it("rolls back same-version convergence when maintenance expires before commit", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-same-version-expiry-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    opened.db.exec(`
      DROP TRIGGER session_nodes_entry_valid_after_insert;
      DROP TRIGGER session_nodes_entry_valid_after_entry_update;
      DROP TRIGGER session_nodes_entry_valid_after_identity_update;
      DROP INDEX idx_agent_session_nodes_entry_valid_pending;
      ALTER TABLE session_nodes DROP COLUMN entry_valid;
    `);
    closeOpenClawAgentDatabasesForTest();

    let competingLeaseId: string | undefined;
    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    const originalAssert = agentDatabaseLease.assertAgentDatabaseMaintenanceAuthorityIfPresent;
    const authority = vi
      .spyOn(agentDatabaseLease, "assertAgentDatabaseMaintenanceAuthorityIfPresent")
      .mockImplementation(() => {
        openOpenClawStateDatabase({ env })
          .db.prepare("UPDATE state_leases SET expires_at = ? WHERE scope = ? AND lease_key = ?")
          .run(
            Date.now() - 1,
            AGENT_DATABASE_MAINTENANCE_LEASE.scope,
            AGENT_DATABASE_MAINTENANCE_LEASE.key,
          );
        competingLeaseId = claimOpenClawAgentDatabaseLease({
          agentId: "competitor",
          path: path.join(stateDir, "competitor.sqlite"),
          env,
        });
        originalAssert();
      });

    const result = await migrateHistoricalTranscriptDirectives({ env }).finally(() => {
      authority.mockRestore();
    });

    expect(result.warnings.some((warning) => warning.includes("maintenance lease"))).toBe(true);
    expect(competingLeaseId).toBeDefined();
    const rolledBack = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(
        rolledBack
          .prepare("SELECT 1 FROM pragma_table_info('session_nodes') WHERE name = 'entry_valid'")
          .get(),
      ).toBeUndefined();
    } finally {
      rolledBack.close();
    }
    releaseOpenClawAgentDatabaseLease(competingLeaseId as string, { env });
  });

  it("leaves a current empty database and its active writer untouched", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-current-empty-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });

    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    expect(opened.db.isOpen).toBe(true);
  });

  it("surfaces lease inspection failures from preflight", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-lease-inspection-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();
    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    vi.spyOn(agentDatabaseLease, "assertNoOpenClawAgentDatabaseLeases").mockImplementation(() => {
      throw new Error("shared-state lease inspection failed");
    });

    const result = await migrateHistoricalTranscriptDirectives({ env });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        `Skipped historical transcript directive migration preflight for ${databasePath}: Error: shared-state lease inspection failed`,
      ),
    ]);
    const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(
        database
          .prepare("SELECT 1 FROM schema_meta WHERE meta_key = ?")
          .get("historical-transcript-directives-v1"),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("leaves canonical archives and their active writer untouched", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-current-archive-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const archived = messageEvent({
      content: [{ type: "text", text: "Already canonical" }],
      id: "archived-canonical",
      role: "assistant",
      timestamp: 1,
    });
    const archiveBytes = Buffer.from(`${JSON.stringify(archived)}\n`, "utf8");
    opened.db
      .prepare(
        `INSERT INTO session_transcript_archives(
          session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
          archive_name,created_at,published_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "archived-canonical",
        "generation",
        "agent:main:archived-canonical",
        "deleted",
        "identity",
        archiveBytes,
        createHash("sha256").update(archiveBytes).digest("hex"),
        "canonical.jsonl.deleted.2026-01-01T00-00-00.000Z.generation",
        1,
        null,
      );

    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    expect(opened.db.isOpen).toBe(true);
    expect(
      opened.db
        .prepare("SELECT 1 FROM schema_meta WHERE meta_key = ?")
        .get("historical-transcript-directives-v1"),
    ).toBeUndefined();
  });

  it("continues preflight after an unreadable target", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-preflight-targets-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "second", env });
    const databasePath = opened.path;
    const unreadablePath = path.join(stateDir, "unreadable", "agent.sqlite");
    fs.mkdirSync(path.dirname(unreadablePath), { recursive: true });
    fs.writeFileSync(unreadablePath, "not a sqlite database");
    opened.db.exec(`
      DROP TABLE session_participants;
      ${withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql())}
      PRAGMA user_version = 17;
      UPDATE schema_meta SET schema_version = 17 WHERE meta_key = 'primary';
    `);
    closeOpenClawAgentDatabasesForTest();

    const result = await migrateHistoricalTranscriptDirectives({
      env,
      configuredAgentDatabaseTargets: [
        { agentId: "first", path: unreadablePath },
        { agentId: "second", path: databasePath },
      ],
    });

    expect(result.warnings.some((warning) => warning.includes("preflight"))).toBe(true);
    const migrated = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(19);
    } finally {
      migrated.close();
    }
  });

  it("prunes a stale writer lease before completing an empty database", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-stale-writer-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: databasePath,
      env,
    });
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE agent_database_leases SET owner_pid = ? WHERE lease_id = ?")
      .run(2_147_483_647, leaseId);

    await expect(migrateHistoricalTranscriptDirectives({ env })).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete" });
  });

  it("rolls back a transcript transaction when maintenance expires before commit", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-expired-commit-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    insertSession(opened.db, {
      events: [
        messageEvent({
          content: [{ type: "text", text: "[[reply_to_current]] Migrating" }],
          id: "assistant-expired",
          role: "assistant",
          timestamp: 1,
        }),
      ],
      generation: "before",
      sessionId: "session-expired",
    });
    const originalEventJson = readEventJson(opened.path, "session-expired", 0);
    closeOpenClawAgentDatabasesForTest();

    let competingLeaseId: string | undefined;
    const originalAssert = assertAgentDatabaseMaintenanceAuthority;
    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    const authority = vi
      .spyOn(agentDatabaseLease, "assertAgentDatabaseMaintenanceAuthority")
      .mockImplementation(() => {
        originalAssert();
        if (authority.mock.calls.length !== 1) {
          return;
        }
        openOpenClawStateDatabase({ env })
          .db.prepare("UPDATE state_leases SET expires_at = ? WHERE scope = ? AND lease_key = ?")
          .run(
            Date.now() - 1,
            AGENT_DATABASE_MAINTENANCE_LEASE.scope,
            AGENT_DATABASE_MAINTENANCE_LEASE.key,
          );
        competingLeaseId = claimOpenClawAgentDatabaseLease({
          agentId: "competitor",
          path: path.join(stateDir, "competitor.sqlite"),
          env,
        });
      });

    const result = await migrateHistoricalTranscriptDirectives({ env }).finally(() => {
      authority.mockRestore();
    });

    expect(result.warnings).toHaveLength(2);
    expect(
      result.warnings.every(
        (warning) => warning.includes("maintenance lease") && warning.includes("was lost"),
      ),
    ).toBe(true);
    expect(competingLeaseId).toBeDefined();
    expect(readEventJson(opened.path, "session-expired", 0)).toBe(originalEventJson);
    const migrated = openNodeSqliteDatabase(opened.path, { readOnly: true });
    try {
      expect(
        migrated
          .prepare("SELECT 1 FROM schema_meta WHERE meta_key = ?")
          .get("historical-transcript-directives-v1"),
      ).toBeUndefined();
    } finally {
      migrated.close();
    }
    releaseOpenClawAgentDatabaseLease(competingLeaseId as string, { env });
  });

  it("preserves a published archive when maintenance expires before rename", async () => {
    const stateDir = makeTempDir(tempDirs, "transcript-directive-expired-archive-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const archived = messageEvent({
      content: [{ type: "text", text: "[[reply_to_current]] Archived" }],
      id: "archived-expired",
      role: "assistant",
      timestamp: 1,
    });
    const archiveBytes = Buffer.from(`${JSON.stringify(archived)}\n`, "utf8");
    const archiveName = "expired.jsonl.deleted.2026-01-01T00-00-00.000Z.generation";
    opened.db
      .prepare(
        `INSERT INTO session_transcript_archives(
          session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
          archive_name,created_at,published_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "archived-expired",
        "generation",
        "agent:main:archived-expired",
        "deleted",
        "identity",
        archiveBytes,
        createHash("sha256").update(archiveBytes).digest("hex"),
        archiveName,
        1,
        1,
      );
    opened.db
      .prepare(
        `INSERT INTO schema_meta(
          meta_key,schema_version,app_version,created_at,updated_at,role,agent_id
        ) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        "historical-transcript-directives-v1",
        1,
        JSON.stringify({ generation: "", phase: "archives", sessionId: "" }),
        1,
        1,
        "agent",
        "main",
      );
    const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
      agentId: "main",
      path: opened.path,
    });
    fs.mkdirSync(archiveDirectory, { recursive: true });
    const archivePath = path.join(archiveDirectory, archiveName);
    fs.writeFileSync(archivePath, archiveBytes);
    closeOpenClawAgentDatabasesForTest();

    let competingLeaseId: string | undefined;
    const originalAssert = assertAgentDatabaseMaintenanceAuthority;
    const agentDatabaseLease = await import("../state/openclaw-agent-db-lease.js");
    const authority = vi
      .spyOn(agentDatabaseLease, "assertAgentDatabaseMaintenanceAuthority")
      .mockImplementation(() => {
        if (!competingLeaseId && new Error().stack?.includes("beforeRename")) {
          openOpenClawStateDatabase({ env })
            .db.prepare("UPDATE state_leases SET expires_at = ? WHERE scope = ? AND lease_key = ?")
            .run(
              Date.now() - 1,
              AGENT_DATABASE_MAINTENANCE_LEASE.scope,
              AGENT_DATABASE_MAINTENANCE_LEASE.key,
            );
          competingLeaseId = claimOpenClawAgentDatabaseLease({
            agentId: "competitor",
            path: path.join(stateDir, "competitor.sqlite"),
            env,
          });
        }
        originalAssert();
      });

    const result = await migrateHistoricalTranscriptDirectives({ env }).finally(() => {
      authority.mockRestore();
    });

    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(
      result.warnings.every(
        (warning) => warning.includes("maintenance lease") && warning.includes("was lost"),
      ),
    ).toBe(true);
    expect(competingLeaseId).toBeDefined();
    expect(fs.readFileSync(archivePath)).toEqual(archiveBytes);
    expect(readMigrationCursor(opened.path)).toEqual({
      generation: "",
      phase: "archives",
      sessionId: "",
    });
    releaseOpenClawAgentDatabaseLease(competingLeaseId as string, { env });
  });

  it("renews maintenance beyond its original lifetime and fences writers through final mutation", async () => {
    vi.useFakeTimers();
    const stateDir = makeTempDir(tempDirs, "transcript-directive-lease-renewal-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    for (let index = 0; index <= 32; index += 1) {
      insertSession(opened.db, {
        events: [
          messageEvent({
            content: [{ type: "text", text: "[[reply_to_current]] Migrating" }],
            id: `assistant-${index}`,
            role: "assistant",
            timestamp: index + 1,
          }),
        ],
        generation: "before",
        sessionId: `session-${String(index).padStart(2, "0")}`,
      });
    }
    closeOpenClawAgentDatabasesForTest();

    vi.spyOn(globalThis, "setImmediate").mockImplementationOnce(
      (callback) => setTimeout(callback, 61_000) as unknown as NodeJS.Immediate,
    );
    let competingWriterError: unknown;
    let competingLeaseId: string | undefined;
    setTimeout(() => {
      try {
        competingLeaseId = claimOpenClawAgentDatabaseLease({
          agentId: "competitor",
          path: path.join(stateDir, "competitor.sqlite"),
          env,
        });
      } catch (error) {
        competingWriterError = error;
      }
    }, 60_500);

    let migrationDone = false;
    const migration = migrateHistoricalTranscriptDirectives({ env }).finally(() => {
      migrationDone = true;
    });
    await vi.advanceTimersByTimeAsync(61_000);
    for (let turn = 0; turn < 10; turn += 1) {
      await vi.advanceTimersByTimeAsync(1);
      if (migrationDone) {
        break;
      }
    }
    await expect(migration).resolves.toMatchObject({ warnings: [] });

    expect(competingWriterError).toEqual(
      expect.objectContaining({ message: expect.stringContaining("maintenance is in progress") }),
    );
    expect(competingLeaseId).toBeUndefined();
    expect(readMigrationCursor(opened.path)).toEqual({ phase: "complete" });
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "competitor",
      path: path.join(stateDir, "competitor.sqlite"),
      env,
    });
    releaseOpenClawAgentDatabaseLease(leaseId, { env });
  });
});
