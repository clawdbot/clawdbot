import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, expect, test } from "vitest";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const SESSION_ID = "phase3-reclamation-e2e";
const SESSION_KEY = "discord:group:phase3-reclamation-e2e";
const CANONICAL_SESSION_KEY = `agent:main:${SESSION_KEY}`;
const HISTORICAL_SESSION_ID = "phase3-reclamation-e2e-history";
const UNRELATED_SESSION_ID = "phase3-reclamation-unrelated";
const UNRELATED_SESSION_KEY = "discord:group:phase3-reclamation-unrelated";
const ROWS = 200_000;

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function countRows(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  table: string,
  sessionId: string,
): number {
  const row = database.db
    .prepare(`SELECT count(*) AS count FROM ${table} WHERE session_id = ?`)
    .get(sessionId) as { count: number | bigint };
  return Number(row.count);
}

function seedTranscriptState(storePath: string): void {
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  if (!target.path) {
    throw new Error("expected SQLite database path");
  }
  const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  const now = Date.now();
  const eventJson = JSON.stringify({
    type: "message",
    message: { content: "phase3 e2e transcript message", role: "user" },
  });
  const insertEvent = database.db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertActive = database.db.prepare(
    `INSERT INTO session_transcript_active_events
       (session_id, active_position, event_seq, message_position)
     VALUES (?, ?, ?, ?)`,
  );
  const insertFts = database.db.prepare(
    `INSERT INTO session_transcript_fts (text, session_id, message_id, role, timestamp)
     VALUES ('phase3 e2e transcript message', ?, ?, 'user', ?)`,
  );
  // sqlite-allow-raw -- bulk fixture setup stays outside the measured delete path.
  database.db.exec("BEGIN IMMEDIATE");
  try {
    database.db
      .prepare(
        `INSERT INTO session_windows (
           session_id, session_key, reason, session_scope, created_at, updated_at
         )
         SELECT ?, session_key, 'initial', session_scope, ?, ?
         FROM session_windows
         WHERE session_id = ?`,
      )
      .run(HISTORICAL_SESSION_ID, now - 1, now - 1, SESSION_ID);
    database.db
      .prepare(
        `UPDATE session_windows
         SET previous_session_id = ?, reason = 'reset'
         WHERE session_id = ?`,
      )
      .run(HISTORICAL_SESSION_ID, SESSION_ID);
    for (let index = 0; index < ROWS; index += 1) {
      insertEvent.run(SESSION_ID, index, eventJson, now + index);
      insertActive.run(SESSION_ID, index, index, index);
      insertFts.run(SESSION_ID, `${SESSION_ID}-message-${index}`, now);
    }
    database.db
      .prepare(
        `INSERT INTO session_transcript_index_state (
           session_id, indexed_seq, needs_rebuild, active_event_count,
           active_message_count, updated_at
         ) VALUES (?, ?, 0, ?, ?, ?)`,
      )
      .run(SESSION_ID, ROWS - 1, ROWS, ROWS, now);
    database.db
      .prepare(
        `INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at)
         VALUES (?, 'phase3-e2e-generation', ?)`,
      )
      .run(SESSION_ID, now);
    insertEvent.run(HISTORICAL_SESSION_ID, 0, eventJson, now);
    insertActive.run(HISTORICAL_SESSION_ID, 0, 0, 0);
    insertFts.run(HISTORICAL_SESSION_ID, `${HISTORICAL_SESSION_ID}-message-0`, now);
    database.db
      .prepare(
        `INSERT INTO session_transcript_index_state (
           session_id, indexed_seq, needs_rebuild, active_event_count,
           active_message_count, updated_at
         ) VALUES (?, 0, 0, 1, 1, ?)`,
      )
      .run(HISTORICAL_SESSION_ID, now);
    database.db
      .prepare(
        `INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at)
         VALUES (?, 'phase3-e2e-current-generation', ?)`,
      )
      .run(HISTORICAL_SESSION_ID, now);
    insertEvent.run(
      UNRELATED_SESSION_ID,
      0,
      JSON.stringify({
        type: "message",
        message: { content: "unrelated transcript message", role: "assistant" },
      }),
      now,
    );
    insertActive.run(UNRELATED_SESSION_ID, 0, 0, 0);
    insertFts.run(UNRELATED_SESSION_ID, `${UNRELATED_SESSION_ID}-message-0`, now);
    database.db
      .prepare(
        `INSERT INTO session_transcript_index_state (
           session_id, indexed_seq, needs_rebuild, active_event_count,
           active_message_count, updated_at
         ) VALUES (?, 0, 0, 1, 1, ?)`,
      )
      .run(UNRELATED_SESSION_ID, now);
    database.db
      .prepare(
        `INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at)
         VALUES (?, 'phase3-unrelated-generation', ?)`,
      )
      .run(UNRELATED_SESSION_ID, now);
    // sqlite-allow-raw -- commits the deterministic fixture before measurement.
    database.db.exec("COMMIT");
  } catch (error) {
    // sqlite-allow-raw -- releases the failed fixture transaction.
    database.db.exec("ROLLBACK");
    throw error;
  }
}

test("sessions.delete keeps the Gateway responsive while reclaiming a large session", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [SESSION_KEY]: sessionStoreEntry(SESSION_ID),
      [UNRELATED_SESSION_KEY]: sessionStoreEntry(UNRELATED_SESSION_ID),
    },
    storePath,
  });
  seedTranscriptState(storePath);

  const samples: number[] = [];
  let previous = performance.now();
  const heartbeat = setInterval(() => {
    const current = performance.now();
    samples.push(current - previous);
    previous = current;
  }, 10);
  const { ws } = await openClient();
  let deleted: Awaited<
    ReturnType<
      typeof rpcReq<{
        archived: string[];
        deleted: boolean;
        key: string;
        ok: true;
      }>
    >
  >;
  let deleteMs = 0;
  try {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    const deleteStartedAt = performance.now();
    // The 200k-row fixture can take longer than the generic RPC helper's 10s
    // wall-clock budget on slower CI hosts. Responsiveness is asserted
    // independently below via the event-loop heartbeat.
    deleted = await rpcReq(ws, "sessions.delete", { key: SESSION_KEY }, 60_000);
    deleteMs = performance.now() - deleteStartedAt;
  } finally {
    clearInterval(heartbeat);
    ws.close();
  }
  const maxGatewayGapMs = Math.max(...samples);

  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  if (!target.path) {
    throw new Error("expected SQLite database path after deletion");
  }
  const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  const targetCounts = {
    active: countRows(database, "session_transcript_active_events", SESSION_ID),
    fts: countRows(database, "session_transcript_fts", SESSION_ID),
    indexState: countRows(database, "session_transcript_index_state", SESSION_ID),
    transcriptEvents: countRows(database, "transcript_events", SESSION_ID),
    rewriteWatermarks: countRows(database, "transcript_rewrite_watermarks", SESSION_ID),
    windows: countRows(database, "session_windows", SESSION_ID),
  };
  const historicalCounts = {
    active: countRows(database, "session_transcript_active_events", HISTORICAL_SESSION_ID),
    fts: countRows(database, "session_transcript_fts", HISTORICAL_SESSION_ID),
    indexState: countRows(database, "session_transcript_index_state", HISTORICAL_SESSION_ID),
    transcriptEvents: countRows(database, "transcript_events", HISTORICAL_SESSION_ID),
    rewriteWatermarks: countRows(database, "transcript_rewrite_watermarks", HISTORICAL_SESSION_ID),
    windows: countRows(database, "session_windows", HISTORICAL_SESSION_ID),
  };
  const unrelatedCounts = {
    active: countRows(database, "session_transcript_active_events", UNRELATED_SESSION_ID),
    fts: countRows(database, "session_transcript_fts", UNRELATED_SESSION_ID),
    indexState: countRows(database, "session_transcript_index_state", UNRELATED_SESSION_ID),
    transcriptEvents: countRows(database, "transcript_events", UNRELATED_SESSION_ID),
    rewriteWatermarks: countRows(database, "transcript_rewrite_watermarks", UNRELATED_SESSION_ID),
    windows: countRows(database, "session_windows", UNRELATED_SESSION_ID),
  };
  const targetNodeCount = Number(
    (
      database.db
        .prepare("SELECT count(*) AS count FROM session_nodes WHERE current_session_id = ?")
        .get(SESSION_ID) as { count: number | bigint }
    ).count,
  );
  const unrelatedNodeCount = Number(
    (
      database.db
        .prepare("SELECT count(*) AS count FROM session_nodes WHERE current_session_id = ?")
        .get(UNRELATED_SESSION_ID) as { count: number | bigint }
    ).count,
  );
  const archives = database.db
    .prepare(
      `SELECT session_id, archive_sha256, length(archive_blob) AS archive_bytes, published_at
       FROM session_transcript_archives
       WHERE session_id IN (?, ?)
       ORDER BY session_id`,
    )
    .all(SESSION_ID, HISTORICAL_SESSION_ID) as Array<{
    archive_bytes: number | bigint;
    archive_sha256: string;
    published_at: number | null;
    session_id: string;
  }>;

  if (process.env.OPENCLAW_TEST_RECLAMATION_LOG === "1") {
    process.stdout.write(
      `${JSON.stringify({
        deleteMs,
        maxGatewayGapMs,
        rows: ROWS,
        historicalCounts,
        targetCounts,
        unrelatedCounts,
      })}\n`,
    );
  }

  expect(deleted.ok).toBe(true);
  expect(deleted.payload).toMatchObject({
    archived: [expect.any(String), expect.any(String)],
    deleted: true,
    key: CANONICAL_SESSION_KEY,
    ok: true,
  });
  expect(deleted.payload?.archived.every((archivePath) => fs.existsSync(archivePath))).toBe(true);
  expect(targetCounts).toEqual({
    active: 0,
    fts: 0,
    indexState: 0,
    transcriptEvents: 0,
    rewriteWatermarks: 0,
    windows: 0,
  });
  expect(targetNodeCount).toBe(0);
  expect(historicalCounts).toEqual({
    active: 0,
    fts: 0,
    indexState: 0,
    transcriptEvents: 0,
    rewriteWatermarks: 0,
    windows: 0,
  });
  expect(unrelatedCounts).toEqual({
    active: 1,
    fts: 1,
    indexState: 1,
    transcriptEvents: 1,
    rewriteWatermarks: 1,
    windows: 1,
  });
  expect(unrelatedNodeCount).toBe(1);
  expect(archives).toEqual([
    {
      archive_bytes: expect.any(Number),
      archive_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      published_at: expect.any(Number),
      session_id: SESSION_ID,
    },
    {
      archive_bytes: expect.any(Number),
      archive_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      published_at: expect.any(Number),
      session_id: HISTORICAL_SESSION_ID,
    },
  ]);
  expect(archives.every((archive) => Number(archive.archive_bytes) > 0)).toBe(true);
  expect(samples.length).toBeGreaterThan(0);
  expect(maxGatewayGapMs).toBeLessThan(500);
}, 120_000);
