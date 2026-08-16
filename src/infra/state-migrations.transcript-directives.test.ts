import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
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

function parseArchive(content: string): FixtureEvent[] {
  return content
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureEvent);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("historical transcript directive migration", () => {
  it("migrates assistant rows and archives while preserving code and derived indexes", () => {
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

    const result = migrateHistoricalTranscriptDirectives({ env });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);

    const migratedTagged = JSON.parse(readEventJson(databasePath, "tagged-session", 0)) as {
      message: Record<string, unknown>;
    };
    expect(migratedTagged.message).toMatchObject({
      content: [{ type: "text", text: "Final answer" }],
      openclawDelivery: {
        audioAsVoice: true,
        replyToCurrent: true,
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
    expect(migrateHistoricalTranscriptDirectives({ env })).toEqual({
      changes: [],
      warnings: [],
    });
    expect(readGeneration(databasePath, "tagged-session")).toBe(generationsAfterFirstRun.tagged);
    expect(readGeneration(databasePath, "reaction-session")).toBe(
      generationsAfterFirstRun.reaction,
    );
    expect(fs.readFileSync(archivePath)).toEqual(archiveBytesAfterFirstRun);
  });

  it("resumes after the committed transcript cursor", () => {
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

    expect(migrateHistoricalTranscriptDirectives({ env }).warnings).toEqual([]);
    expect(readGeneration(databasePath, "resume-a")).toBe("already-bumped");
    expect(readGeneration(databasePath, "resume-b")).not.toBe("pending-before");
    expect(JSON.parse(readEventJson(databasePath, "resume-b", 0))).toMatchObject({
      message: {
        content: [{ type: "text", text: "Pending" }],
        openclawDelivery: { audioAsVoice: true },
      },
    });
  });
});
