import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  });
});

// Exact affected tables from v2026.6.34:src/state/openclaw-state-schema.sql (schema v1).
// Its run-manager changed runId on steer but kept sessionStartedAt and the original task row.
const RELEASED_TABLES = `
  PRAGMA user_version = 1;
  CREATE TABLE task_runs (
    task_id TEXT NOT NULL PRIMARY KEY,
    runtime TEXT NOT NULL, task_kind TEXT, source_id TEXT,
    requester_session_key TEXT, owner_key TEXT NOT NULL, scope_kind TEXT NOT NULL,
    child_session_key TEXT, parent_flow_id TEXT, parent_task_id TEXT,
    agent_id TEXT, requester_agent_id TEXT, run_id TEXT, label TEXT,
    task TEXT NOT NULL, status TEXT NOT NULL, delivery_status TEXT NOT NULL,
    notify_policy TEXT NOT NULL, created_at INTEGER NOT NULL,
    started_at INTEGER, ended_at INTEGER, last_event_at INTEGER, cleanup_after INTEGER,
    error TEXT, progress_summary TEXT, terminal_summary TEXT, terminal_outcome TEXT
  );
  CREATE TABLE subagent_runs (
    run_id TEXT NOT NULL PRIMARY KEY,
    child_session_key TEXT NOT NULL, controller_session_key TEXT,
    requester_session_key TEXT NOT NULL, requester_display_key TEXT NOT NULL,
    requester_origin_json TEXT, task TEXT NOT NULL, task_name TEXT, cleanup TEXT NOT NULL,
    label TEXT, model TEXT, agent_dir TEXT, workspace_dir TEXT,
    run_timeout_seconds INTEGER, spawn_mode TEXT, created_at INTEGER NOT NULL,
    started_at INTEGER, session_started_at INTEGER, accumulated_runtime_ms INTEGER,
    ended_at INTEGER, outcome_json TEXT, archive_at_ms INTEGER,
    cleanup_completed_at INTEGER, cleanup_handled INTEGER, suppress_announce_reason TEXT,
    expects_completion_message INTEGER, announce_retry_count INTEGER,
    last_announce_retry_at INTEGER, last_announce_delivery_error TEXT,
    ended_reason TEXT, pause_reason TEXT, wake_on_descendant_settle INTEGER,
    frozen_result_text TEXT, frozen_result_captured_at INTEGER,
    fallback_frozen_result_text TEXT, fallback_frozen_result_captured_at INTEGER,
    ended_hook_emitted_at INTEGER, pending_final_delivery INTEGER,
    pending_final_delivery_created_at INTEGER, pending_final_delivery_last_attempt_at INTEGER,
    pending_final_delivery_attempt_count INTEGER, pending_final_delivery_last_error TEXT,
    pending_final_delivery_payload_json TEXT, completion_announced_at INTEGER,
    payload_json TEXT NOT NULL DEFAULT '{}'
  );
`;

function createReleasedDatabase(execution: "running" | "terminal") {
  const stateDir = fs.realpathSync(tempDirs.make("openclaw-released-subagent-binding-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(RELEASED_TABLES);
  const terminal = execution === "terminal";
  const payload = {
    runId: "replacement-run",
    childSessionKey: "agent:worker:subagent:legacy",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "retain the original task owner",
    cleanup: "keep",
    expectsCompletionMessage: true,
    createdAt: 200,
    startedAt: 200,
    sessionStartedAt: 100,
    ...(terminal ? { endedAt: 300, outcome: { status: "ok" } } : {}),
    execution: {
      status: execution,
      startedAt: 200,
      ...(terminal ? { endedAt: 300, outcome: { status: "ok" } } : {}),
    },
    completion: { required: true, ...(terminal ? { resultText: "retained result" } : {}) },
    delivery: terminal
      ? { status: "suspended", suspendedAt: 400, suspendedReason: "retry-limit" }
      : { status: "pending" },
  };
  db.prepare(`
    INSERT INTO task_runs (
      task_id, runtime, requester_session_key, owner_key, scope_kind,
      child_session_key, run_id, task, status, delivery_status, notify_policy,
      created_at, started_at, progress_summary
    ) VALUES (?, 'subagent', ?, ?, 'session', ?, ?, ?, ?, ?, 'done_only', 100, 100, ?)
  `).run(
    "original-task",
    payload.requesterSessionKey,
    payload.requesterSessionKey,
    payload.childSessionKey,
    "original-run",
    payload.task,
    terminal ? "succeeded" : "running",
    terminal ? "failed" : "pending",
    terminal ? "retained result" : null,
  );
  db.prepare(`
    INSERT INTO subagent_runs (
      run_id, child_session_key, requester_session_key, requester_display_key,
      task, cleanup, created_at, started_at, session_started_at, ended_at,
      expects_completion_message, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, 200, 200, 100, ?, 1, ?)
  `).run(
    payload.runId,
    payload.childSessionKey,
    payload.requesterSessionKey,
    payload.requesterDisplayKey,
    payload.task,
    payload.cleanup,
    terminal ? 300 : null,
    JSON.stringify(payload),
  );
  return { db, databasePath };
}

function snapshot(db: DatabaseSync) {
  return {
    tasks: db.prepare("SELECT * FROM task_runs ORDER BY task_id").all(),
    runs: db.prepare("SELECT * FROM subagent_runs ORDER BY run_id").all(),
    version: db.prepare("PRAGMA user_version").get(),
  };
}

const ADD_TASK = `
  INSERT INTO task_runs (
    task_id, runtime, requester_session_key, owner_key, scope_kind, child_session_key,
    run_id, task, status, delivery_status, notify_policy, created_at
  ) SELECT 'second-task', runtime, requester_session_key, owner_key, scope_kind,
    child_session_key, 'second-original', task, status, delivery_status, notify_policy, 150
    FROM task_runs WHERE task_id = 'original-task';
`;
const ADD_RUN = `
  INSERT INTO subagent_runs (
    run_id, child_session_key, requester_session_key, requester_display_key,
    task, cleanup, created_at, payload_json
  ) SELECT 'second-run', child_session_key, requester_session_key, requester_display_key,
    task, cleanup, created_at, json_set(payload_json, '$.runId', 'second-run')
    FROM subagent_runs WHERE run_id = 'replacement-run';
`;

function readBindings(db: DatabaseSync) {
  return db
    .prepare(`
    SELECT run_id, json_type(payload_json, '$.taskRunId') AS binding_type,
      json_extract(payload_json, '$.taskRunId') AS binding
    FROM subagent_runs ORDER BY run_id
  `)
    .all();
}

describe("released subagent task bindings", () => {
  it.each(["terminal", "running"] as const)(
    "upgrades a %s v2026.6.34 replacement and retains its owner after reopen",
    (execution) => {
      const { db: released } = createReleasedDatabase(execution);
      expect(released.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      released.close();

      const upgraded = openOpenClawStateDatabase();
      const run = loadSubagentRegistryFromSqlite().get("replacement-run");
      expect(run).toMatchObject({
        runId: "replacement-run",
        taskRunId: "original-run",
        execution: { status: execution },
      });
      expect(upgraded.db.prepare("PRAGMA table_info(subagent_runs)").all()).not.toContainEqual(
        expect.objectContaining({ name: "session_started_at" }),
      );
      const firstOpen = snapshot(upgraded.db);
      closeOpenClawStateDatabaseForTest();
      expect(snapshot(openOpenClawStateDatabase().db)).toEqual(firstOpen);

      if (execution === "running") {
        if (!run) {
          throw new Error("upgraded replacement was not restored");
        }
        run.execution = { status: "terminal", endedAt: 500, outcome: { status: "ok" } };
        run.completion = { required: true, resultText: "result after upgrade" };
        run.delivery = { status: "suspended", suspendedReason: "expiry", suspendedAt: 600 };
        saveSubagentRegistryChangesToSqlite(new Map([[run.runId, run]]), [run.runId]);
        closeOpenClawStateDatabaseForTest();
        expect(loadSubagentRegistryFromSqlite().get(run.runId)).toMatchObject({
          taskRunId: "original-run",
          execution: { status: "terminal" },
          completion: { resultText: "result after upgrade" },
        });
      }
    },
  );

  it.each([
    ["another child task", ADD_TASK],
    [
      "another child run already delivered",
      `${ADD_RUN}
      UPDATE subagent_runs SET payload_json = json_set(payload_json,
        '$.delivery.status', 'delivered') WHERE run_id = 'second-run';`,
    ],
    [
      "a task run collision in another child",
      `${ADD_TASK}
      UPDATE task_runs SET child_session_key = 'another-child', run_id = 'original-run'
        WHERE task_id = 'second-task';`,
    ],
    [
      "a remapped run collision in another child",
      `${ADD_RUN}
      UPDATE subagent_runs SET child_session_key = 'another-child',
        payload_json = json_set(payload_json, '$.taskRunId', 'original-run')
        WHERE run_id = 'second-run';`,
    ],
    [
      "an unmapped run collision in another child",
      `${ADD_RUN}
      UPDATE subagent_runs SET child_session_key = 'another-child', run_id = 'original-run'
        WHERE run_id = 'second-run';`,
    ],
    ["a different requester", "UPDATE task_runs SET requester_session_key = 'another-requester';"],
    ["a task before the session", "UPDATE task_runs SET created_at = 99;"],
    ["a task after the replacement", "UPDATE task_runs SET created_at = 201;"],
    [
      "no earlier session start",
      `UPDATE subagent_runs
      SET payload_json = json_set(payload_json, '$.sessionStartedAt', 200);`,
    ],
    [
      "an explicit canonical binding",
      `UPDATE subagent_runs
      SET payload_json = json_set(payload_json, '$.taskRunId', 'original-run');`,
    ],
    [
      "an explicit unmatched binding",
      `UPDATE subagent_runs
      SET payload_json = json_set(payload_json, '$.taskRunId', 'unknown-run');`,
    ],
    [
      "an explicit null binding",
      `UPDATE subagent_runs
      SET payload_json = json_set(payload_json, '$.taskRunId', NULL);`,
    ],
    [
      "a numeric completion requirement",
      `UPDATE subagent_runs
      SET payload_json = json_set(payload_json, '$.completion.required', 1);`,
    ],
  ])("preserves ownership with %s", (_label, change) => {
    const { db: released } = createReleasedDatabase("terminal");
    released.exec(change);
    const before = readBindings(released);
    released.close();

    const upgraded = openOpenClawStateDatabase();
    expect(readBindings(upgraded.db)).toEqual(before);
    const firstOpen = snapshot(upgraded.db);
    closeOpenClawStateDatabaseForTest();
    expect(snapshot(openOpenClawStateDatabase().db)).toEqual(firstOpen);
  });

  it("binds before projecting the result held only in the released pending payload", () => {
    const { db: released } = createReleasedDatabase("terminal");
    released.exec(`
      UPDATE task_runs SET progress_summary = NULL;
      UPDATE subagent_runs SET
        payload_json = json_remove(payload_json, '$.completion.resultText'),
        pending_final_delivery_payload_json = '{"frozenResultText":"only retained result"}';
    `);
    released.close();

    const upgraded = openOpenClawStateDatabase();
    expect(upgraded.db.prepare("SELECT run_id, progress_summary FROM task_runs").all()).toEqual([
      { run_id: "original-run", progress_summary: "only retained result" },
    ]);
    expect(loadSubagentRegistryFromSqlite().get("replacement-run")).toMatchObject({
      taskRunId: "original-run",
      completion: { resultText: "only retained result" },
    });
    const firstOpen = snapshot(upgraded.db);
    closeOpenClawStateDatabaseForTest();
    expect(snapshot(openOpenClawStateDatabase().db)).toEqual(firstOpen);
  });

  it("rolls back every binding and earlier repair when one binding write fails", () => {
    const { db: released, databasePath } = createReleasedDatabase("terminal");
    released.exec(`${ADD_TASK}${ADD_RUN}
      UPDATE task_runs SET child_session_key = 'another-child' WHERE task_id = 'second-task';
      UPDATE subagent_runs SET child_session_key = 'another-child' WHERE run_id = 'second-run';
      CREATE TRIGGER reject_second_binding BEFORE UPDATE OF payload_json ON subagent_runs
        WHEN OLD.run_id = 'second-run' AND json_type(NEW.payload_json, '$.taskRunId') = 'text'
      BEGIN
        SELECT RAISE(ABORT, 'binding write refused');
      END;
    `);
    const before = snapshot(released);
    released.close();

    expect(() => openOpenClawStateDatabase()).toThrow("binding write refused");
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(snapshot(preserved)).toEqual(before);
    } finally {
      preserved.close();
    }
  });
});
