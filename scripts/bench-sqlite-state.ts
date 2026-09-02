// SQLite state benchmark seeds OpenClaw DBs and reports hot-query proof lines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../src/state/openclaw-agent-db-contract.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesForTest,
} from "../src/state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../src/state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../src/state/openclaw-state-db.js";
import { parseStrictIntegerOption } from "./lib/dev-tooling-safety.ts";
import {
  collectSqliteQueryPlanEvidence,
  type SqliteQueryPlanEvidence,
} from "./lib/sqlite-query-plan-evidence.js";
import {
  CliUsageError,
  parseSqliteStateBenchmarkCli,
  type ProfileId,
} from "./lib/sqlite-state-benchmark-cli.js";

type ProfileConfig = {
  agentCacheEntries: number;
  agentCount: number;
  channelIngressEvents: number;
  cronJobs: number;
  cronTaskRuns: number;
  deliveryQueueEntries: number;
  pluginStateEntries: number;
  queryRuns: number;
};

type TimedQuery = {
  database: "agent" | "state";
  id: string;
  p50Ms: number;
  p95Ms: number;
  plan: SqliteQueryPlanEvidence;
  runs: number;
  rows: number;
  sql: string;
};

type BenchmarkReport = {
  integrity: {
    agent: string[];
    state: string;
  };
  node: string;
  schemaVersion: 2;
  versions: {
    agentSchema: number;
    sqlite: string;
    stateSchema: number;
  };
  paths: {
    agentDatabases: string[];
    artifact: string | null;
    stateDatabase: string;
    stateDir: string;
  };
  profile: ProfileId;
  queries: TimedQuery[];
  rows: {
    agentCacheEntries: number;
    agentDatabases: number;
    channelIngressEvents: number;
    cronJobs: number;
    cronTaskRuns: number;
    deliveryQueueEntries: number;
    pluginStateEntries: number;
    stateRows: number;
    transcriptEvents: number;
  };
  timingsMs: {
    checkpoint: number;
    seed: number;
    total: number;
  };
  walBytes: {
    agentAfter: number[];
    agentBefore: number[];
    stateAfter: number;
    stateBefore: number;
  };
};

const PROFILES: Record<ProfileId, ProfileConfig> = {
  smoke: {
    agentCacheEntries: 1_000,
    agentCount: 2,
    channelIngressEvents: 1_000,
    cronJobs: 100,
    cronTaskRuns: 1_000,
    deliveryQueueEntries: 1_000,
    pluginStateEntries: 1_000,
    queryRuns: 20,
  },
  default: {
    agentCacheEntries: 20_000,
    agentCount: 5,
    channelIngressEvents: 10_000,
    cronJobs: 1_000,
    cronTaskRuns: 50_000,
    deliveryQueueEntries: 50_000,
    pluginStateEntries: 20_000,
    queryRuns: 30,
  },
  large: {
    agentCacheEntries: 50_000,
    agentCount: 10,
    channelIngressEvents: 100_000,
    cronJobs: 5_000,
    cronTaskRuns: 250_000,
    deliveryQueueEntries: 200_000,
    pluginStateEntries: 100_000,
    queryRuns: 40,
  },
};

const SQLITE_PERF_FULL_LOAD_RUNS = 20;
const SQLITE_PERF_TRANSCRIPT_EVENTS = 256;
const SQLITE_PERF_TRANSCRIPT_MESSAGE_BYTES = 4_096;
const SQLITE_PERF_TRANSCRIPT_PAGE_MESSAGES = 256;
const SQLITE_PERF_TRANSCRIPT_SESSION_ID = "perf-history";
const SQLITE_PERF_INGRESS_QUEUE = JSON.stringify(["telegram", "bench-account"]);
const SQLITE_PERF_PLUGIN_ID = "benchmark-plugin";
const SQLITE_PERF_PLUGIN_NAMESPACE = "journal";
const SQLITE_PERF_PLUGIN_NOW = 1_750_000_000_000;
const SQLITE_PERF_CATALOG_SCOPE = "plugin-model-catalog-v1";
const SQLITE_PERF_PAGE_SIZE = 100;

function applyScale(config: ProfileConfig): ProfileConfig {
  const scale = parseStrictIntegerOption({
    fallback: 1,
    label: "SQLITE_PERF_SCALE",
    min: 1,
    raw: process.env["SQLITE_PERF_SCALE"],
  });
  if (scale === 1) {
    return config;
  }
  return {
    agentCacheEntries: config.agentCacheEntries * scale,
    agentCount: config.agentCount,
    channelIngressEvents: config.channelIngressEvents * scale,
    cronJobs: config.cronJobs * scale,
    cronTaskRuns: config.cronTaskRuns * scale,
    deliveryQueueEntries: config.deliveryQueueEntries * scale,
    pluginStateEntries: config.pluginStateEntries * scale,
    queryRuns: config.queryRuns,
  };
}

function printUsage(): void {
  console.log(`OpenClaw SQLite state benchmark

Usage:
  node --import tsx scripts/bench-sqlite-state.ts [options]

Options:
  --profile <smoke|default|large>  Data volume profile (default: default)
  --state-dir <path>               Reuse a state directory instead of a temp dir
  --output <path>                  Write machine-readable JSON report
  --help                           Show this text

Environment:
  SQLITE_PERF_SCALE=<n>            Multiplies row counts for the selected profile
`);
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function fileSize(pathname: string): number {
  try {
    return fs.statSync(pathname).size;
  } catch {
    return 0;
  }
}

function walSize(pathname: string): number {
  return fileSize(`${pathname}-wal`);
}

function stateRowCount(config: ProfileConfig): number {
  return (
    config.channelIngressEvents +
    config.cronJobs +
    config.cronTaskRuns +
    config.deliveryQueueEntries +
    config.pluginStateEntries
  );
}

function seedStateDatabase(db: DatabaseSync, config: ProfileConfig): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    seedCronJobs(db, config.cronJobs);
    seedCronTaskRuns(db, config.cronTaskRuns, config.cronJobs);
    seedDeliveryQueue(db, config.deliveryQueueEntries);
    seedPluginState(db, config.pluginStateEntries);
    seedChannelIngress(db, config.channelIngressEvents);
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

function seedCronJobs(db: DatabaseSync, count: number): void {
  const insert = db.prepare(`
    INSERT INTO cron_jobs (
      store_key, job_id, name, enabled, agent_id, payload_kind,
      job_json, state_json, runtime_updated_at_ms, schedule_identity, sort_order, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'agentTurn', ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < count; i += 1) {
    const jobId = `job-${String(i).padStart(8, "0")}`;
    const storeKey = `/state/cron/jobs-${i % 8}.json`;
    const updatedAt = 1_700_000_000_000 + i;
    const name = `Benchmark job ${i}`;
    const enabled = i % 5 !== 0;
    const agentId = `agent-${i % 16}`;
    const job = {
      id: jobId,
      name,
      enabled,
      createdAtMs: updatedAt - 100_000,
      agentId,
      sessionKey: `agent:${agentId}:main`,
      schedule: {
        kind: "every",
        everyMs: 60_000 + (i % 120) * 1_000,
        anchorMs: updatedAt - 60_000,
      },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: `Benchmark payload ${i}`,
        model: "openai/gpt-5.6-luna",
        timeoutSeconds: 60,
        allowUnsafeExternalContent: false,
        lightContext: true,
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: `chat-${i % 32}`,
        accountId: "bench-account",
        bestEffort: true,
      },
      state: {},
    };
    const state = {
      nextRunAtMs: updatedAt + (i % 2_000) * 1_000,
      lastRunAtMs: updatedAt - 1_000,
      lastRunStatus: "completed",
      lastDurationMs: 50 + (i % 500),
      consecutiveErrors: 0,
      consecutiveSkipped: 0,
      scheduleErrorCount: 0,
      lastDeliveryStatus: "sent",
      lastDelivered: true,
    };
    insert.run(
      storeKey,
      jobId,
      name,
      enabled ? 1 : 0,
      agentId,
      JSON.stringify(job),
      JSON.stringify(state),
      updatedAt,
      `schedule-${i % 512}`,
      i,
      updatedAt,
    );
  }
}

function seedCronTaskRuns(db: DatabaseSync, count: number, cronJobCount: number): void {
  const insert = db.prepare(`
    INSERT INTO task_runs (
      task_id, runtime, source_id, requester_session_key, owner_key, scope_kind,
      child_session_key, run_id, task, status, delivery_status, notify_policy,
      created_at, started_at, ended_at, last_event_at, error, terminal_summary,
      terminal_outcome, detail_json
    ) VALUES (?, 'cron', ?, '', '', 'system', ?, ?, ?, ?, 'not_applicable', 'silent',
      ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < count; i += 1) {
    const jobIndex = i % 4 === 0 ? 0 : i % Math.max(1, cronJobCount);
    const jobId = `job-${String(jobIndex).padStart(8, "0")}`;
    const ts = 1_700_000_000_000 + i;
    const succeeded = i % 17 !== 0;
    const runId = `run-${i}`;
    const status = succeeded ? "ok" : "error";
    const storeKey = `/state/cron/jobs-${i % 8}.json`;
    insert.run(
      `cron-benchmark-${i}`,
      jobId,
      `agent:agent-${i % 16}:main`,
      runId,
      jobId,
      succeeded ? "succeeded" : "failed",
      ts,
      ts,
      ts + 20 + (i % 1_000),
      ts + 20 + (i % 1_000),
      succeeded ? null : `run ${i} failed`,
      `run ${i}`,
      succeeded ? "succeeded" : null,
      JSON.stringify({ kind: "cron-run", storeKey, action: "finished", status, runId }),
    );
  }
}

function seedDeliveryQueue(db: DatabaseSync, count: number): void {
  const insert = db.prepare(`
    INSERT INTO delivery_queue_entries (
      queue_name, id, status, entry_kind, session_key, channel, target, account_id,
      retry_count, last_attempt_at, last_error, recovery_state, platform_send_started_at,
      entry_json, enqueued_at, updated_at, failed_at
    ) VALUES (?, ?, ?, 'message', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)
  `);
  for (let i = 0; i < count; i += 1) {
    const status = i % 13 === 0 ? "failed" : i % 17 === 0 ? "completed" : "pending";
    const queueName = i % 5 === 0 ? "session" : "outbound";
    const enqueuedAt = 1_700_000_000_000 + i;
    const channel = i % 2 === 0 ? "telegram" : "discord";
    const target = `target-${i % 256}`;
    const accountId = `account-${i % 8}`;
    const sessionKey = `agent:agent-${i % 16}:main`;
    insert.run(
      queueName,
      `delivery-${String(i).padStart(8, "0")}`,
      status,
      sessionKey,
      channel,
      target,
      accountId,
      i % 5,
      status === "failed" ? enqueuedAt + 500 : null,
      JSON.stringify({
        id: `delivery-${String(i).padStart(8, "0")}`,
        retryCount: i % 5,
        enqueuedAt,
        sessionKey,
        route: { channel, to: target, accountId },
      }),
      enqueuedAt,
      enqueuedAt + 100,
      status === "failed" ? enqueuedAt + 1_000 : null,
    );
  }
}

function seedPluginState(db: DatabaseSync, count: number): void {
  const insert = db.prepare(`
    INSERT INTO plugin_state_entries (
      plugin_id, namespace, entry_key, value_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < count; i += 1) {
    const concentrated = i < Math.ceil(count * 0.75);
    const expiresAt =
      i % 10 === 0
        ? SQLITE_PERF_PLUGIN_NOW - 1_000 - i
        : i % 4 === 0
          ? SQLITE_PERF_PLUGIN_NOW + 1_000 + i
          : null;
    insert.run(
      concentrated ? SQLITE_PERF_PLUGIN_ID : `plugin-${i % 12}`,
      concentrated ? SQLITE_PERF_PLUGIN_NAMESPACE : `namespace-${i % 16}`,
      `entry-${String(i).padStart(8, "0")}`,
      JSON.stringify({ value: i, text: `payload ${i}` }),
      1_700_000_000_000 + i,
      expiresAt,
    );
  }
}

function seedChannelIngress(db: DatabaseSync, count: number): void {
  const insert = db.prepare(`
    INSERT INTO channel_ingress_events (
      queue_name, event_id, channel_id, account_id, status, lane_key, payload_json,
      metadata_json, received_at, updated_at, claim_token, claim_owner, claimed_at,
      attempts, last_attempt_at, last_error, failed_reason, failed_at, completed_at,
      completed_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)
  `);
  for (let i = 0; i < count; i += 1) {
    const status = i % 17 === 0 ? "claimed" : i % 29 === 0 ? "completed" : "pending";
    const timestamp = 1_700_000_000_000 + i;
    insert.run(
      SQLITE_PERF_INGRESS_QUEUE,
      `event-${String(i).padStart(8, "0")}`,
      "telegram",
      "bench-account",
      status,
      `lane-${i % 128}`,
      JSON.stringify({ messageId: `message-${i}`, text: `message ${i}` }),
      JSON.stringify({ source: "benchmark" }),
      timestamp,
      timestamp,
      status === "claimed" ? `claim-${i}` : null,
      status === "claimed" ? "benchmark-worker" : null,
      status === "claimed" ? timestamp : null,
      i % 3,
      status === "claimed" ? timestamp : null,
      status === "completed" ? timestamp : null,
    );
  }
}

function seedAgentDatabase(db: DatabaseSync, count: number, agentIndex: number): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const insert = db.prepare(`
      INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `);
    const catalogEntries = Math.min(count, 64);
    for (let i = 0; i < count; i += 1) {
      const isCatalog = i < catalogEntries;
      insert.run(
        isCatalog ? SQLITE_PERF_CATALOG_SCOPE : `runtime-cache-${i % 16}`,
        isCatalog
          ? `plugin-${String(i).padStart(3, "0")}`
          : `agent-${agentIndex}-entry-${String(i).padStart(8, "0")}`,
        JSON.stringify(
          isCatalog
            ? {
                generatedBy: "openclaw-plugin-model-catalog-v1",
                models: [{ id: `model-${i}`, name: `Benchmark model ${i}` }],
                pluginId: `plugin-${i}`,
              }
            : { agentIndex, i, value: `cache ${i}` },
        ),
        null,
        1_700_000_000_000 + i,
      );
    }
    if (agentIndex === 0) {
      seedTranscriptHistory(db);
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

function seedTranscriptHistory(db: DatabaseSync): void {
  const sessionKey = "agent:perf-agent-0:history";
  db.prepare(
    `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionKey, SQLITE_PERF_TRANSCRIPT_SESSION_ID, "{}", 1_700_000_000_000);
  db.prepare(
    `INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(SQLITE_PERF_TRANSCRIPT_SESSION_ID, sessionKey, 1_700_000_000_000, 1_700_000_000_000);

  const insertEvent = db.prepare(
    `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const insertIdentity = db.prepare(
    `INSERT INTO transcript_event_identities
       (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
     VALUES (?, ?, ?, 'message', NULL, NULL, ?)`,
  );
  const insertActive = db.prepare(
    `INSERT INTO session_transcript_active_events
       (session_id, active_position, event_seq, message_position)
     VALUES (?, ?, ?, ?)`,
  );
  const messageContent = "x".repeat(SQLITE_PERF_TRANSCRIPT_MESSAGE_BYTES);
  for (let seq = 1; seq <= SQLITE_PERF_TRANSCRIPT_EVENTS; seq += 1) {
    const eventId = `history-${seq}`;
    const message = {
      type: "message",
      id: eventId,
      message: { role: "user", content: messageContent },
    };
    insertEvent.run(SQLITE_PERF_TRANSCRIPT_SESSION_ID, seq, JSON.stringify(message), seq);
    insertIdentity.run(SQLITE_PERF_TRANSCRIPT_SESSION_ID, eventId, seq, seq);
    insertActive.run(SQLITE_PERF_TRANSCRIPT_SESSION_ID, seq - 1, seq, seq - 1);
  }
  db.prepare(
    `INSERT INTO session_transcript_index_state
       (session_id, indexed_seq, leaf_event_id, active_event_count, active_message_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    SQLITE_PERF_TRANSCRIPT_SESSION_ID,
    SQLITE_PERF_TRANSCRIPT_EVENTS,
    `history-${SQLITE_PERF_TRANSCRIPT_EVENTS}`,
    SQLITE_PERF_TRANSCRIPT_EVENTS,
    SQLITE_PERF_TRANSCRIPT_EVENTS,
    1_700_000_000_000,
  );
}

function readIntegrity(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown };
  return typeof row.integrity_check === "string" ? row.integrity_check : "missing";
}

function readSqliteVersion(db: DatabaseSync): string {
  const row = db.prepare("SELECT sqlite_version() AS version").get() as { version?: unknown };
  return typeof row.version === "string" ? row.version : "unknown";
}

function checkpoint(db: DatabaseSync): void {
  db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return Number(expectDefined(sorted[index], `SQLite benchmark percentile ${pct}`).toFixed(3));
}

function readQueryPlan(
  db: DatabaseSync,
  sql: string,
  params: SQLInputValue[],
): SqliteQueryPlanEvidence {
  const raw = (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail?: unknown }>
  ).map((row) => (typeof row.detail === "string" ? row.detail : JSON.stringify(row.detail ?? "")));
  return collectSqliteQueryPlanEvidence(raw);
}

function runTimedQuery(params: {
  database: "agent" | "state";
  db: DatabaseSync;
  fullLoad?: boolean;
  id: string;
  queryParams: SQLInputValue[];
  requestedRuns: number;
  sql: string;
}): TimedQuery {
  const runs = params.fullLoad
    ? Math.min(params.requestedRuns, SQLITE_PERF_FULL_LOAD_RUNS)
    : params.requestedRuns;
  const statement = params.db.prepare(params.sql);
  const samples: number[] = [];
  let rows = statement.all(...params.queryParams).length;
  for (let i = 0; i < runs; i += 1) {
    const started = nowMs();
    rows = statement.all(...params.queryParams).length;
    samples.push(nowMs() - started);
  }
  return {
    database: params.database,
    id: params.id,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    plan: readQueryPlan(params.db, params.sql, params.queryParams),
    runs,
    rows,
    sql: params.sql,
  };
}

function taskRunSelectSql(where: string): string {
  return `SELECT
      task_id, runtime, task_kind, source_id, requester_session_key, owner_key, scope_kind,
      child_session_key, parent_flow_id, parent_task_id, agent_id, requester_agent_id,
      run_id, label, task, status, delivery_status, notify_policy, created_at, started_at,
      ended_at, last_event_at, cleanup_after, tool_use_count, last_tool_name, error,
      progress_summary, terminal_summary, terminal_outcome, detail_json
    FROM task_runs
    WHERE ${where}
    ORDER BY created_at ASC, task_id ASC`;
}

function runHotQueries(params: {
  agentDb: DatabaseSync;
  config: ProfileConfig;
  stateDb: DatabaseSync;
}): TimedQuery[] {
  const transcriptPositions = Array.from(
    { length: SQLITE_PERF_TRANSCRIPT_PAGE_MESSAGES },
    (_, index) => SQLITE_PERF_TRANSCRIPT_EVENTS - SQLITE_PERF_TRANSCRIPT_PAGE_MESSAGES + index,
  );
  const transcriptPlaceholders = transcriptPositions.map(() => "?").join(", ");
  return [
    runTimedQuery({
      database: "state",
      db: params.stateDb,
      id: "cron.store.load",
      queryParams: ["/state/cron/jobs-0.json"],
      requestedRuns: params.config.queryRuns,
      sql: `SELECT *
         FROM cron_jobs
        WHERE store_key = ?
        ORDER BY sort_order ASC, updated_at ASC, job_id ASC`,
    }),
    runTimedQuery({
      database: "state",
      db: params.stateDb,
      fullLoad: true,
      id: "task-runs.cron.list",
      queryParams: ["cron"],
      requestedRuns: params.config.queryRuns,
      sql: taskRunSelectSql("runtime = ?"),
    }),
    runTimedQuery({
      database: "state",
      db: params.stateDb,
      fullLoad: true,
      id: "task-runs.cron-source.list",
      queryParams: ["cron", "job-00000000"],
      requestedRuns: params.config.queryRuns,
      sql: taskRunSelectSql("runtime = ? AND source_id = ?"),
    }),
    runTimedQuery({
      database: "state",
      db: params.stateDb,
      fullLoad: true,
      id: "delivery.pending.load",
      queryParams: ["outbound", "pending"],
      requestedRuns: params.config.queryRuns,
      sql: `SELECT id, entry_json, enqueued_at, retry_count, last_attempt_at, last_error,
                platform_send_started_at, recovery_state
         FROM delivery_queue_entries
        WHERE queue_name = ? AND status = ?
        ORDER BY enqueued_at ASC, id ASC`,
    }),
    runTimedQuery({
      database: "state",
      db: params.stateDb,
      id: "ingress.pending.first-page",
      queryParams: [SQLITE_PERF_INGRESS_QUEUE, "pending", SQLITE_PERF_PAGE_SIZE],
      requestedRuns: params.config.queryRuns,
      sql: `SELECT *
         FROM channel_ingress_events
        WHERE queue_name = ? AND status = ?
        ORDER BY received_at ASC, event_id ASC
        LIMIT ?`,
    }),
    runTimedQuery({
      database: "state",
      db: params.stateDb,
      id: "ingress.pending.seek-page",
      queryParams: [
        SQLITE_PERF_INGRESS_QUEUE,
        "pending",
        1_700_000_000_500,
        1_700_000_000_500,
        "event-00000500",
        SQLITE_PERF_PAGE_SIZE,
      ],
      requestedRuns: params.config.queryRuns,
      sql: `SELECT *
         FROM channel_ingress_events
        WHERE queue_name = ? AND status = ?
          AND (received_at > ? OR (received_at = ? AND event_id > ?))
        ORDER BY received_at ASC, event_id ASC
        LIMIT ?`,
    }),
    runTimedQuery({
      database: "state",
      db: params.stateDb,
      id: "ingress.pending.id-page",
      queryParams: [SQLITE_PERF_INGRESS_QUEUE, "pending", SQLITE_PERF_PAGE_SIZE],
      requestedRuns: params.config.queryRuns,
      sql: `SELECT *
         FROM channel_ingress_events
        WHERE queue_name = ? AND status = ?
        ORDER BY event_id ASC
        LIMIT ?`,
    }),
    runTimedQuery({
      database: "state",
      db: params.stateDb,
      id: "ingress.pending.id-seek-page",
      queryParams: [SQLITE_PERF_INGRESS_QUEUE, "pending", "event-00000500", SQLITE_PERF_PAGE_SIZE],
      requestedRuns: params.config.queryRuns,
      sql: `SELECT *
         FROM channel_ingress_events
        WHERE queue_name = ? AND status = ? AND event_id > ?
        ORDER BY event_id ASC
        LIMIT ?`,
    }),
    runTimedQuery({
      database: "state",
      db: params.stateDb,
      fullLoad: true,
      id: "plugin-state.namespace.live",
      queryParams: [SQLITE_PERF_PLUGIN_ID, SQLITE_PERF_PLUGIN_NAMESPACE, SQLITE_PERF_PLUGIN_NOW],
      requestedRuns: params.config.queryRuns,
      sql: `SELECT plugin_id, namespace, entry_key, value_json, created_at, expires_at
         FROM plugin_state_entries
        WHERE plugin_id = ? AND namespace = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at ASC, entry_key ASC`,
    }),
    runTimedQuery({
      database: "agent",
      db: params.agentDb,
      id: "agent-cache.plugin-model-catalog.list",
      queryParams: [SQLITE_PERF_CATALOG_SCOPE],
      requestedRuns: params.config.queryRuns,
      sql: `SELECT key, value_json
         FROM cache_entries
        WHERE scope = ?
        ORDER BY key ASC`,
    }),
    runTimedQuery({
      database: "agent",
      db: params.agentDb,
      id: "transcript.tail.metadata",
      queryParams: [SQLITE_PERF_TRANSCRIPT_SESSION_ID, ...transcriptPositions],
      requestedRuns: params.config.queryRuns,
      sql: `SELECT active.message_position,
                   LENGTH(CAST(event.event_json AS BLOB)) + 1 AS serialized_bytes
              FROM session_transcript_active_events AS active
              JOIN transcript_events AS event
                ON event.session_id = active.session_id AND event.seq = active.event_seq
             WHERE active.session_id = ?
               AND active.message_position IN (${transcriptPlaceholders})
             ORDER BY active.message_position DESC`,
    }),
    runTimedQuery({
      database: "agent",
      db: params.agentDb,
      id: "transcript.tail.payload",
      queryParams: [SQLITE_PERF_TRANSCRIPT_SESSION_ID, ...transcriptPositions],
      requestedRuns: params.config.queryRuns,
      sql: `SELECT active.message_position, event.event_json
              FROM session_transcript_active_events AS active
              JOIN transcript_events AS event
                ON event.session_id = active.session_id AND event.seq = active.event_seq
             WHERE active.session_id = ?
               AND active.message_position IN (${transcriptPlaceholders})
             ORDER BY active.message_position ASC`,
    }),
  ];
}

function printProofLines(report: BenchmarkReport): void {
  const p95 = Math.max(...report.queries.map((query) => query.p95Ms));
  console.log(`SQLITE_PERF_PROFILE=${report.profile}`);
  console.log(`SQLITE_PERF_STATE_ROWS=${report.rows.stateRows}`);
  console.log(`SQLITE_PERF_AGENT_ROWS=${report.rows.agentCacheEntries}`);
  console.log(`SQLITE_PERF_TRANSCRIPT_ROWS=${report.rows.transcriptEvents}`);
  console.log(`SQLITE_PERF_INTEGRITY=${report.integrity.state}`);
  console.log(`SQLITE_PERF_WAL_BYTES_BEFORE=${report.walBytes.stateBefore}`);
  console.log(`SQLITE_PERF_WAL_BYTES_AFTER=${report.walBytes.stateAfter}`);
  console.log(`SQLITE_PERF_QUERY_P95_MS=${p95.toFixed(3)}`);
  for (const query of report.queries) {
    console.log(`SQLITE_PERF_SCENARIO ${JSON.stringify(query)}`);
  }
  if (report.paths.artifact) {
    console.log(`SQLITE_PERF_ARTIFACT=${report.paths.artifact}`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const cli = parseSqliteStateBenchmarkCli(argv);
  if (cli.help) {
    printUsage();
    return;
  }
  const { options } = cli;
  const config = applyScale(PROFILES[options.profile]);
  const stateDir =
    options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-perf-"));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const started = nowMs();
  try {
    const stateDatabase = openOpenClawStateDatabase({ env });
    const agentDatabases = Array.from({ length: config.agentCount }, (_, index) =>
      openOpenClawAgentDatabase({ agentId: `perf-agent-${index}`, env }),
    );

    const seedStarted = nowMs();
    seedStateDatabase(stateDatabase.db, config);
    const perAgentEntries = Math.ceil(config.agentCacheEntries / config.agentCount);
    agentDatabases.forEach((database, index) =>
      seedAgentDatabase(database.db, perAgentEntries, index),
    );
    const seedMs = nowMs() - seedStarted;

    const stateWalBefore = walSize(stateDatabase.path);
    const agentWalBefore = agentDatabases.map((database) => walSize(database.path));
    const stateIntegrity = readIntegrity(stateDatabase.db);
    const agentIntegrity = agentDatabases.map((database) => readIntegrity(database.db));
    const queries = runHotQueries({
      agentDb: agentDatabases[0]?.db ?? stateDatabase.db,
      config,
      stateDb: stateDatabase.db,
    });

    const checkpointStarted = nowMs();
    checkpoint(stateDatabase.db);
    agentDatabases.forEach((database) => checkpoint(database.db));
    const checkpointMs = nowMs() - checkpointStarted;

    const report: BenchmarkReport = {
      integrity: {
        agent: agentIntegrity,
        state: stateIntegrity,
      },
      node: process.version,
      schemaVersion: 2,
      paths: {
        agentDatabases: agentDatabases.map((database) => database.path),
        artifact: options.output,
        stateDatabase: stateDatabase.path,
        stateDir,
      },
      profile: options.profile,
      queries,
      versions: {
        agentSchema: OPENCLAW_AGENT_SCHEMA_VERSION,
        sqlite: readSqliteVersion(stateDatabase.db),
        stateSchema: OPENCLAW_STATE_SCHEMA_VERSION,
      },
      rows: {
        agentCacheEntries: perAgentEntries * config.agentCount,
        agentDatabases: config.agentCount,
        channelIngressEvents: config.channelIngressEvents,
        cronJobs: config.cronJobs,
        cronTaskRuns: config.cronTaskRuns,
        deliveryQueueEntries: config.deliveryQueueEntries,
        pluginStateEntries: config.pluginStateEntries,
        stateRows: stateRowCount(config),
        transcriptEvents: SQLITE_PERF_TRANSCRIPT_EVENTS,
      },
      timingsMs: {
        checkpoint: Number(checkpointMs.toFixed(3)),
        seed: Number(seedMs.toFixed(3)),
        total: Number((nowMs() - started).toFixed(3)),
      },
      walBytes: {
        agentAfter: agentDatabases.map((database) => walSize(database.path)),
        agentBefore: agentWalBefore,
        stateAfter: walSize(stateDatabase.path),
        stateBefore: stateWalBefore,
      },
    };

    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    printProofLines(report);
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (!options.stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`error: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}
