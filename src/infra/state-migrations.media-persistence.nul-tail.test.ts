// NUL-only tail recovery tests for the legacy media persistence doctor
// migration, split out of state-migrations.media-persistence.test.ts so that
// file stays inside the oxlint max-lines budget.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];
const PREVIOUS_VERSION = OPENCLAW_AGENT_SCHEMA_VERSION - 1;

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
}): string {
  const agentId = params.agentId ?? "main";
  const opened = openOpenClawAgentDatabase({ agentId, env: params.env });
  const databasePath = opened.path;
  closeOpenClawAgentDatabasesForTest();
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec(`PRAGMA user_version = ${PREVIOUS_VERSION};`);
    database
      .prepare(
        "UPDATE schema_meta SET schema_version = ?, app_version = ? WHERE meta_key = 'primary'",
      )
      .run(PREVIOUS_VERSION, "legacy-test");
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
    }
  } finally {
    database.close();
  }
  registerOpenClawAgentDatabase({
    agentId,
    env: params.env,
    path: databasePath,
    schemaVersion: PREVIOUS_VERSION,
  });
  return databasePath;
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

describe("legacy media persistence doctor migration — NUL-only tail recovery", () => {
  it("recovers a terminal NUL-only tail in archived JSONL and leaves other malformed shapes untouched", () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-nul-tail-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const event = createEvent({
      id: "event-nul",
      parentId: null,
      timestamp: 1000,
      message: {
        role: "user",
        content: "recoverable",
        MediaPath: "/media/nul.png",
        MediaType: "image/png",
      },
    });
    createLegacyDatabaseFixture({ env, eventsBySession: {} });
    const archiveDir = path.join(stateDir, "agents", "main", "sessions");
    const plainArchive = path.join(archiveDir, "nul-tail.jsonl.deleted.2026-07-24T01-02-03.000Z");
    writeArchive(plainArchive, [event], false);
    fs.appendFileSync(plainArchive, "\x00".repeat(284));

    const compressedArchive = `${path.join(
      archiveDir,
      "nul-zstd.jsonl.reset.2026-07-24T01-02-04.000Z",
    )}${SESSION_ARCHIVE_ZSTD_SUFFIX}`;
    const compressedContent = `${JSON.stringify(event)}\n\x00\x00\x00`;
    const encoded = encodeSessionArchiveContent(compressedContent);
    if (encoded.suffix !== SESSION_ARCHIVE_ZSTD_SUFFIX) {
      throw new Error("test runtime does not support zstd");
    }
    fs.writeFileSync(compressedArchive, encoded.bytes);

    const result = migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    expect(result.changes.join("\n")).toContain("Migrated archived transcript media");

    const recovered = readSessionArchiveContentSync(plainArchive);
    expect(recovered.endsWith("\x00".repeat(284))).toBe(false);
    expect(recovered).toContain('"__openclaw"');
    expect(recovered).toContain('"/media/nul.png"');
    expect(readSessionArchiveContentSync(compressedArchive)).not.toContain("\x00");

    // Rerun is a no-op: the tail is gone and the content is canonical.
    expect(migrateLegacyMediaPersistence({ env })).toEqual({ changes: [], warnings: [] });

    // All-NUL file: rejected and left byte-for-byte untouched.
    const allNulPath = path.join(archiveDir, "all-nul.jsonl.deleted.2026-07-24T01-02-05.000Z");
    const allNulBytes = Buffer.alloc(64, 0);
    fs.writeFileSync(allNulPath, allNulBytes);
    expect(migrateLegacyMediaPersistence({ env }).warnings.join("\n")).toContain(
      "consists entirely of NUL bytes",
    );
    expect(fs.readFileSync(allNulPath)).toEqual(allNulBytes);
    fs.unlinkSync(allNulPath);

    // Interior NUL byte: still malformed, untouched.
    const interiorPath = path.join(
      archiveDir,
      "interior-nul.jsonl.deleted.2026-07-24T01-02-06.000Z",
    );
    fs.writeFileSync(interiorPath, `{"type":"message"\x00}\n`);
    expect(migrateLegacyMediaPersistence({ env }).warnings.join("\n")).toContain(
      "invalid transcript JSON",
    );
    expect(fs.readFileSync(interiorPath, "utf8")).toBe(`{"type":"message"\x00}\n`);
    fs.unlinkSync(interiorPath);

    // Blank record before the NUL tail: rejected, untouched.
    const blankPath = path.join(archiveDir, "blank-nul.jsonl.deleted.2026-07-24T01-02-07.000Z");
    fs.writeFileSync(blankPath, `${JSON.stringify(event)}\n\n\x00\x00`);
    expect(migrateLegacyMediaPersistence({ env }).warnings.join("\n")).toContain(
      "blank JSONL record",
    );
    expect(fs.readFileSync(blankPath, "utf8")).toBe(`${JSON.stringify(event)}\n\n\x00\x00`);
    fs.unlinkSync(blankPath);
  });
});
