// SQLite state benchmark seeds OpenClaw DBs and reports hot-query proof lines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesForTest,
} from "../src/state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../src/state/openclaw-state-db.js";
import { parseStrictIntegerOption } from "./lib/dev-tooling-safety.ts";

type ProfileId = "smoke" | "default" | "large";

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
  p50Ms: number;
  p95Ms: number;
  query: string;
  rows: number;
};

type BenchmarkReport = {
  integrity: {
    agent: string[];
    state: string;
  };
  node: string;
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
    queryRuns: 12,
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

type CliOptions = {
  output: string | null;
  profile: ProfileId;
  stateDir: string | null;
};

const BOOLEAN_FLAGS = new Set(["--help"]);
const VALUE_FLAGS = new Set(["--output", "--profile", "--state-dir"]);

class CliUsageError extends Error {
  override name = "CliUsageError";
}

function parseFlagValue(flag: string, argv: string[]): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  return value;
}

function hasFlag(flag: string, argv = process.argv.slice(2)): boolean {
  return argv.includes(flag);
}

function validateArgs(argv: string[]): void {
  const seenValueFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (BOOLEAN_FLAGS.has(arg)) {
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      if (seenValueFlags.has(arg)) {
        throw new CliUsageError(`${arg} was provided more than once`);
      }
      seenValueFlags.add(arg);
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new CliUsageError(`${arg} requires a value`);
      }
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown argument: ${arg}`);
  }
}

function parseProfile(raw: string | undefined): ProfileId {
  if (!raw) {
    return "default";
  }
  if (raw === "smoke" || raw === "default" || raw === "large") {
    return raw;
  }
  throw new CliUsageError(
    `--profile must be one of smoke, default, large; got ${JSON.stringify(raw)}`,
  );
}

function parseOptions(argv = process.argv.slice(2)): CliOptions {
  validateArgs(argv);
  return {
    output: parseFlagValue("--output", argv) ?? null,
    profile: parseProfile(parseFlagValue("--profile", argv)),
    stateDir: parseFlagValue("--state-dir", argv) ?? null,
  };
}

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
    seedCronTaskRuns(db, config.cronTaskRuns);
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
      store_key, job_id, name, description, enabled, delete_after_run, created_at_ms,
      agent_id, session_key, schedule_kind, schedule_expr, schedule_tz, every_ms,
      anchor_ms, at, stagger_ms, session_target, wake_mode, payload_kind,
      payload_message, payload_model, payload_fallbacks_json, payload_thinking,
      payload_timeout_seconds, payload_allow_unsafe_external_content,
      payload_external_content_source_json, payload_light_context, payload_tools_allow_json,
      delivery_mode, delivery_channel, delivery_to, delivery_thread_id, delivery_account_id,
      delivery_best_effort, delivery_completion_mode, delivery_completion_to,
      failure_delivery_mode, failure_delivery_channel, failure_delivery_to,
      failure_delivery_account_id, failure_alert_disabled, failure_alert_after,
      failure_alert_channel, failure_alert_to, failure_alert_cooldown_ms,
      failure_alert_include_skipped, failure_alert_mode, failure_alert_account_id,
      next_run_at_ms, running_at_ms, last_run_at_ms, last_run_status, last_error,
      last_duration_ms, consecutive_errors, consecutive_skipped, schedule_error_count,
      last_delivery_status, last_delivery_error, last_delivered, last_failure_alert_at_ms,
      job_json, state_json, runtime_updated_at_ms, schedule_identity, sort_order, updated_at
    ) VALUES (
      ?, ?, ?, NULL, ?, NULL, ?, ?, ?, 'every', NULL, NULL, ?, ?, NULL, NULL,
      'isolated', 'now', 'agentTurn', ?, 'openai/gpt-5.6-luna', NULL, NULL, 60,
      0, NULL, 1, NULL, 'announce', 'telegram', ?, NULL, 'bench-account',
      1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, ?, NULL, ?, 'completed', NULL, ?, 0, 0, 0, 'sent',
      NULL, 1, NULL, ?, '{}', ?, ?, ?, ?
    )
  `);
  for (let i = 0; i < count; i += 1) {
    const jobId = `job-${String(i).padStart(8, "0")}`;
    const storeKey = `/state/cron/jobs-${i % 8}.json`;
    const updatedAt = 1_700_000_000_000 + i;
    insert.run(
      storeKey,
      jobId,
      `Benchmark job ${i}`,
      i % 5 === 0 ? 0 : 1,
      updatedAt - 100_000,
      `agent-${i % 16}`,
      `agent:agent-${i % 16}:main`,
      60_000 + (i % 120) * 1_000,
      updatedAt - 60_000,
      `Benchmark payload ${i}`,
      `chat-${i % 32}`,
      updatedAt + (i % 2_000) * 1_000,
      updatedAt - 1_000,
      50 + (i % 500),
      JSON.stringify({ id: jobId, seed: i }),
      updatedAt,
      `schedule-${i % 512}`,
      i,
      updatedAt,
    );
  }
}

function seedCronTaskRuns(db: DatabaseSync, count: number): void {
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
    const jobId = `job-${String(i % Math.max(1, Math.floor(count / 20))).padStart(8, "0")}`;
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
    const status = i % 13 === 0 ? "failed" : i % 3 === 0 ? "sending" : "pending";
    const enqueuedAt = 1_700_000_000_000 + i;
    insert.run(
      "outbound",
      `delivery-${String(i).padStart(8, "0")}`,
      status,
      `agent:agent-${i % 16}:main`,
      i % 2 === 0 ? "telegram" : "discord",
      `target-${i % 256}`,
      `account-${i % 8}`,
      i % 5,
      status === "failed" ? enqueuedAt + 500 : null,
      JSON.stringify({ id: i, route: { channel: "telegram", to: `target-${i % 256}` } }),
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
    insert.run(
      `plugin-${i % 12}`,
      `namespace-${i % 16}`,
      `entry-${String(i).padStart(8, "0")}`,
      JSON.stringify({ value: i, text: `payload ${i}` }),
      1_700_000_000_000 + i,
      i % 10 === 0 ? 1_800_000_000_000 + i : null,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL)
  `);
  for (let i = 0; i < count; i += 1) {
    insert.run(
      "ingress",
      `event-${String(i).padStart(8, "0")}`,
      i % 2 === 0 ? "telegram" : "discord",
      `account-${i % 8}`,
      i % 11 === 0 ? "claimed" : "pending",
      `lane-${i % 128}`,
      JSON.stringify({ text: `message ${i}` }),
      1_700_000_000_000 + i,
      1_700_000_000_000 + i,
      i % 3,
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
    for (let i = 0; i < count; i += 1) {
      insert.run(
        i % 4 === 0 ? "session_entries" : `scope-${i % 16}`,
        `agent-${agentIndex}-entry-${String(i).padStart(8, "0")}`,
        JSON.stringify({ agentIndex, i, value: `cache ${i}` }),
        i % 7 === 0 ? 1_800_000_000_000 + i : null,
        1_700_000_000_000 + i,
      );
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

function readIntegrity(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown };
  return typeof row.integrity_check === "string" ? row.integrity_check : "missing";
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

function runTimedQuery(
  db: DatabaseSync,
  query: string,
  params: SQLInputValue[],
  runs: number,
): TimedQuery {
  const statement = db.prepare(query);
  const samples: number[] = [];
  let rows = 0;
  for (let i = 0; i < runs; i += 1) {
    const started = nowMs();
    rows = statement.all(...params).length;
    samples.push(nowMs() - started);
  }
  return {
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    query,
    rows,
  };
}

function runHotQueries(params: {
  agentDb: DatabaseSync;
  config: ProfileConfig;
  stateDb: DatabaseSync;
}): TimedQuery[] {
  return [
    runTimedQuery(
      params.stateDb,
      `SELECT job_id, name, updated_at
         FROM cron_jobs
        WHERE store_key = ?
        ORDER BY sort_order ASC, updated_at ASC, job_id
        LIMIT 50`,
      ["/state/cron/jobs-0.json"],
      params.config.queryRuns,
    ),
    runTimedQuery(
      params.stateDb,
      `SELECT job_id, next_run_at_ms
         FROM cron_jobs
        WHERE store_key = ? AND enabled = 1 AND next_run_at_ms IS NOT NULL
        ORDER BY next_run_at_ms ASC, job_id
        LIMIT 50`,
      ["/state/cron/jobs-0.json"],
      params.config.queryRuns,
    ),
    runTimedQuery(
      params.stateDb,
      `SELECT id, entry_json
         FROM delivery_queue_entries
        WHERE queue_name = ? AND status = ?
        ORDER BY enqueued_at ASC, id
        LIMIT 100`,
      ["outbound", "pending"],
      params.config.queryRuns,
    ),
    runTimedQuery(
      params.stateDb,
      `SELECT entry_key, value_json
         FROM plugin_state_entries
        WHERE plugin_id = ? AND namespace = ?
        ORDER BY created_at ASC, entry_key
        LIMIT 100`,
      ["plugin-0", "namespace-0"],
      params.config.queryRuns,
    ),
    runTimedQuery(
      params.agentDb,
      `SELECT key, value_json
         FROM cache_entries
        WHERE scope = ?
        ORDER BY key ASC
        LIMIT 100`,
      ["session_entries"],
      params.config.queryRuns,
    ),
    runTimedQuery(
      params.agentDb,
      `SELECT key, expires_at
         FROM cache_entries
        WHERE scope = ? AND expires_at IS NOT NULL
        ORDER BY expires_at ASC, key
        LIMIT 100`,
      ["session_entries"],
      params.config.queryRuns,
    ),
  ];
}

function printProofLines(report: BenchmarkReport): void {
  const p95 = Math.max(...report.queries.map((query) => query.p95Ms));
  console.log(`SQLITE_PERF_PROFILE=${report.profile}`);
  console.log(`SQLITE_PERF_STATE_ROWS=${report.rows.stateRows}`);
  console.log(`SQLITE_PERF_AGENT_ROWS=${report.rows.agentCacheEntries}`);
  console.log(`SQLITE_PERF_INTEGRITY=${report.integrity.state}`);
  console.log(`SQLITE_PERF_WAL_BYTES_BEFORE=${report.walBytes.stateBefore}`);
  console.log(`SQLITE_PERF_WAL_BYTES_AFTER=${report.walBytes.stateAfter}`);
  console.log(`SQLITE_PERF_QUERY_P95_MS=${p95.toFixed(3)}`);
  if (report.paths.artifact) {
    console.log(`SQLITE_PERF_ARTIFACT=${report.paths.artifact}`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  validateArgs(argv);
  if (hasFlag("--help", argv)) {
    printUsage();
    return;
  }
  const options = parseOptions(argv);
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
      paths: {
        agentDatabases: agentDatabases.map((database) => database.path),
        artifact: options.output,
        stateDatabase: stateDatabase.path,
        stateDir,
      },
      profile: options.profile,
      queries,
      rows: {
        agentCacheEntries: perAgentEntries * config.agentCount,
        agentDatabases: config.agentCount,
        channelIngressEvents: config.channelIngressEvents,
        cronJobs: config.cronJobs,
        cronTaskRuns: config.cronTaskRuns,
        deliveryQueueEntries: config.deliveryQueueEntries,
        pluginStateEntries: config.pluginStateEntries,
        stateRows: stateRowCount(config),
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
