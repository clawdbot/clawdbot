// SQLite query-plan tests pin hot OpenClaw state indexes used by perf proof.
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const planTempDirs: string[] = [];

function createTempStateDir(): string {
  return makeTempDir(planTempDirs, "openclaw-sqlite-plan-");
}

function explainQueryPlan(
  db: DatabaseSync,
  sql: string,
  params: readonly (number | string | null)[] = [],
): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail?: unknown;
  }>;
  return rows
    .map((row) => (typeof row.detail === "string" ? row.detail : JSON.stringify(row.detail ?? "")))
    .join("\n");
}

function expectPlanUsesIndex(params: {
  db: DatabaseSync;
  indexName: string;
  params?: readonly (number | string | null)[];
  sql: string;
}): void {
  expect(explainQueryPlan(params.db, params.sql, params.params)).toContain(params.indexName);
}

function expectPlanIncludes(params: {
  db: DatabaseSync;
  expected: string;
  params?: readonly (number | string | null)[];
  sql: string;
}): void {
  expect(explainQueryPlan(params.db, params.sql, params.params)).toContain(params.expected);
}

afterAll(() => {
  cleanupTempDirs(planTempDirs);
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("sqlite hot query plans", () => {
  it("uses shared state indexes for list and queue queries", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_cron_jobs_store_order",
      params: ["/state/cron/jobs.json"],
      sql: `
        SELECT job_id, name, updated_at
          FROM cron_jobs
         WHERE store_key = ?
         ORDER BY sort_order ASC, updated_at ASC, job_id
         LIMIT 25
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_cron_jobs_enabled_next_run",
      params: ["/state/cron/jobs.json"],
      sql: `
        SELECT job_id, next_run_at_ms
          FROM cron_jobs
         WHERE store_key = ? AND enabled = 1 AND next_run_at_ms IS NOT NULL
         ORDER BY next_run_at_ms ASC, job_id
         LIMIT 25
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_delivery_queue_pending",
      params: ["outbound", "pending"],
      sql: `
        SELECT id, entry_json
          FROM delivery_queue_entries
         WHERE queue_name = ? AND status = ?
         ORDER BY enqueued_at ASC, id
         LIMIT 50
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_delivery_queue_session",
      params: ["outbound", "pending", "agent:main:main"],
      sql: `
        SELECT id, entry_json
          FROM delivery_queue_entries
         WHERE queue_name = ? AND status = ? AND session_key = ?
         ORDER BY enqueued_at ASC, id
         LIMIT 50
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_plugin_state_listing",
      params: ["telegram", "kv"],
      sql: `
        SELECT entry_key, value_json
          FROM plugin_state_entries
         WHERE plugin_id = ? AND namespace = ?
         ORDER BY created_at ASC, entry_key
         LIMIT 50
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_channel_ingress_pending",
      params: ["ingress", "pending"],
      sql: `
        SELECT event_id, payload_json
          FROM channel_ingress_events
         WHERE queue_name = ? AND status = ?
         ORDER BY received_at ASC, event_id
         LIMIT 50
      `,
    });
  });

  it("uses per-agent cache indexes for session metadata and expiry scans", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expectPlanIncludes({
      db: database.db,
      expected: "sqlite_autoindex_cache_entries_1",
      params: ["session_entries"],
      sql: `
        SELECT key, value_json
          FROM cache_entries
         WHERE scope = ?
         ORDER BY key ASC
         LIMIT 50
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_agent_cache_expiry",
      params: ["session_entries"],
      sql: `
        SELECT key, expires_at
          FROM cache_entries
         WHERE scope = ? AND expires_at IS NOT NULL
         ORDER BY expires_at ASC, key
        LIMIT 50
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_agent_session_nodes_current_session_id",
      params: ["session-1"],
      sql: `
        SELECT session_key
          FROM session_nodes
         WHERE current_session_id = ?
         ORDER BY updated_at DESC, session_key ASC
         LIMIT 1
      `,
    });
    expectPlanUsesIndex({
      db: database.db,
      indexName: "idx_agent_session_nodes_status",
      params: ["running"],
      sql: `
        SELECT session_key, entry_json
          FROM session_nodes
         WHERE status = ?
      `,
    });
    const latestMessagePlan = explainQueryPlan(
      database.db,
      `
        SELECT te.event_json
          FROM transcript_events AS te
          JOIN transcript_event_identities AS ti
            ON ti.session_id = te.session_id AND ti.seq = te.seq
         WHERE te.session_id = ? AND ti.event_type = 'message'
         ORDER BY ti.seq DESC
         LIMIT 1
      `,
      ["session-1"],
    );
    expect(latestMessagePlan).toContain(
      "USING COVERING INDEX idx_agent_transcript_event_sequence (session_id=? AND event_type=?)",
    );
    expect(latestMessagePlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    expectPlanIncludes({
      db: database.db,
      expected: "sqlite_autoindex_transcript_rewrite_watermarks_1",
      params: ["session-1"],
      sql: `
        SELECT generation
          FROM transcript_rewrite_watermarks
         WHERE session_id = ?
      `,
    });
    const rawDeltaPlan = explainQueryPlan(
      database.db,
      `
        SELECT seq, LENGTH(CAST(event_json AS BLOB)) + 1 AS serialized_bytes
          FROM transcript_events
         WHERE session_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT 1001
      `,
      ["session-1", 90_000],
    );
    expect(rawDeltaPlan).toContain("sqlite_autoindex_transcript_events_1");
    expect(rawDeltaPlan).not.toContain("SCAN transcript_events");
    expect(rawDeltaPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    const rawFrontierPlan = explainQueryPlan(
      database.db,
      `
        SELECT seq
          FROM transcript_events
         WHERE session_id = ?
         ORDER BY seq DESC
         LIMIT 1
      `,
      ["session-1"],
    );
    expect(rawFrontierPlan).toContain("sqlite_autoindex_transcript_events_1");
    expect(rawFrontierPlan).not.toContain("SCAN transcript_events");
    expect(rawFrontierPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    const historyPagePlan = explainQueryPlan(
      database.db,
      `
        SELECT active.event_seq, event.event_json
          FROM session_transcript_active_events AS active
          JOIN transcript_events AS event
            ON event.session_id = active.session_id AND event.seq = active.event_seq
         WHERE active.session_id = ?
           AND active.message_position IS NOT NULL
           AND active.message_position >= ?
           AND active.message_position < ?
         ORDER BY active.message_position ASC
      `,
      ["session-1", 100, 125],
    );
    expect(historyPagePlan).toContain("idx_agent_transcript_active_messages");
    expect(historyPagePlan).toContain("sqlite_autoindex_transcript_events_1");
    expect(historyPagePlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    const visibleDeltaPlan = explainQueryPlan(
      database.db,
      `
        SELECT active.event_seq, active.message_position,
               LENGTH(CAST(event.event_json AS BLOB)) + 1 AS serialized_bytes
          FROM session_transcript_active_events AS active
          JOIN transcript_events AS event
            ON event.session_id = active.session_id AND event.seq = active.event_seq
         WHERE active.session_id = ?
           AND active.message_position IS NOT NULL
           AND active.message_position >= ?
         ORDER BY active.message_position ASC
         LIMIT 1001
      `,
      ["session-1", 100],
    );
    expect(visibleDeltaPlan).toContain("idx_agent_transcript_active_messages");
    expect(visibleDeltaPlan).toContain("sqlite_autoindex_transcript_events_1");
    expect(visibleDeltaPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    const visibleDeltaPayloadPlan = explainQueryPlan(
      database.db,
      `
        SELECT active.event_seq, active.message_position, event.event_json,
               parent_identity.event_id AS parent_id
          FROM session_transcript_active_events AS active
          JOIN transcript_events AS event
            ON event.session_id = active.session_id AND event.seq = active.event_seq
          LEFT JOIN session_transcript_active_events AS parent_active
            ON parent_active.session_id = active.session_id
           AND parent_active.active_position = active.active_position - 1
          LEFT JOIN transcript_event_identities AS parent_identity
            ON parent_identity.session_id = parent_active.session_id
           AND parent_identity.seq = parent_active.event_seq
         WHERE active.session_id = ?
           AND active.message_position >= ?
           AND active.message_position < ?
         ORDER BY active.message_position ASC
      `,
      ["session-1", 100, 125],
    );
    expect(visibleDeltaPayloadPlan).toContain("idx_agent_transcript_active_messages");
    expect(visibleDeltaPayloadPlan).toContain("sqlite_autoindex_transcript_events_1");
    expect(visibleDeltaPayloadPlan).toContain(
      "sqlite_autoindex_session_transcript_active_events_1",
    );
    expect(visibleDeltaPayloadPlan).toContain("idx_agent_transcript_event_sequence");
    expect(visibleDeltaPayloadPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    const historyAnchorPlan = explainQueryPlan(
      database.db,
      `
        SELECT active.message_position
          FROM transcript_event_identities AS identity
          JOIN session_transcript_active_events AS active
            ON active.session_id = identity.session_id AND active.event_seq = identity.seq
         WHERE identity.session_id = ? AND identity.event_id = ?
      `,
      ["session-1", "message-1"],
    );
    expect(historyAnchorPlan).toContain("sqlite_autoindex_transcript_event_identities_1");
    expect(historyAnchorPlan).toContain("idx_agent_transcript_active_event_seq");
  });
});
