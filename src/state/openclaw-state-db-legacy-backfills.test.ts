import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  repairLegacySubagentExecutionPayloads,
  repairLegacySubagentRetainedResults,
} from "./openclaw-state-db-legacy-backfills.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

type StoredRun = {
  run_id: string;
  payload_json: string;
};

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE subagent_runs (
      run_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    ) STRICT;
  `);
  const insert = db.prepare(`
    INSERT INTO subagent_runs (run_id, payload_json)
    VALUES (?, ?)
  `);
  return {
    db,
    insert: (row: StoredRun) => insert.run(row.run_id, row.payload_json),
    read: (runId: string) =>
      db.prepare("SELECT * FROM subagent_runs WHERE run_id = ?").get(runId) as StoredRun,
  };
}

describe("repairLegacySubagentSuspensionReasons", () => {
  it("rewrites the shipped reason on open and stays canonical after a second open", () => {
    const stateDir = tempDirs.make("openclaw-subagent-suspension-backfill-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const initial = openOpenClawStateDatabase(options);
    const runId = "legacy-retry-limit";
    initial.db
      .prepare(
        `INSERT INTO subagent_runs (
          run_id, child_session_key, requester_session_key, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        "agent:main:subagent:legacy",
        "agent:main:main",
        100,
        JSON.stringify({
          runId,
          childSessionKey: "agent:main:subagent:legacy",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "legacy retry limit",
          cleanup: "keep",
          createdAt: 100,
          execution: { status: "terminal" },
          completion: { required: true },
          delivery: { status: "suspended", suspendedReason: "retry-limit" },
        }),
      );
    initial.db
      .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
      .run("2026.7.0");
    closeOpenClawStateDatabaseForTest();

    const firstOpen = openOpenClawStateDatabase(options);
    const firstStored = firstOpen.db
      .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get(runId) as { payload_json: string };
    expect(JSON.parse(firstStored.payload_json).delivery.suspendedReason).toBe("permanent_failure");
    closeOpenClawStateDatabaseForTest();

    const secondOpen = openOpenClawStateDatabase(options);
    const secondStored = secondOpen.db
      .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get(runId);
    expect(secondStored).toEqual(firstStored);
  });
});

describe("repairLegacySubagentExecutionPayloads", () => {
  it("moves shipped paused and killed terminal facts into execution once", () => {
    const store = createDatabase();
    const killedOutcome = { status: "error", error: "manual kill" };
    store.insert({
      run_id: "paused",
      payload_json: JSON.stringify({
        startedAt: 100,
        endedAt: 200,
        pauseReason: "sessions_yield",
        execution: { status: "running", startedAt: 100 },
      }),
    });
    store.insert({
      run_id: "killed",
      payload_json: JSON.stringify({
        startedAt: 300,
        endedAt: 400,
        outcome: killedOutcome,
        endedReason: "subagent-killed",
        killReconciliation: { killedAt: 400 },
        execution: { status: "running", startedAt: 300 },
      }),
    });

    repairLegacySubagentExecutionPayloads(store.db);
    const firstPass = [store.read("paused"), store.read("killed")];
    repairLegacySubagentExecutionPayloads(store.db);
    const secondPass = [store.read("paused"), store.read("killed")];

    expect(secondPass).toEqual(firstPass);
    const paused = JSON.parse(firstPass[0]!.payload_json);
    const killed = JSON.parse(firstPass[1]!.payload_json);
    expect(paused.execution).toEqual({ status: "terminal", startedAt: 100, endedAt: 200 });
    expect(killed.execution).toEqual({
      status: "terminal",
      startedAt: 300,
      endedAt: 400,
      outcome: killedOutcome,
    });
    for (const payload of [paused, killed]) {
      expect(payload).not.toHaveProperty("startedAt");
      expect(payload).not.toHaveProperty("endedAt");
      expect(payload).not.toHaveProperty("outcome");
    }
  });

  it("preserves newer canonical terminal state and optional start timing", () => {
    const store = createDatabase();
    store.insert({
      run_id: "newer-terminal",
      payload_json: JSON.stringify({
        startedAt: 100,
        endedAt: 200,
        outcome: { status: "error", error: "manual kill" },
        endedReason: "subagent-killed",
        execution: { status: "terminal", endedAt: 250, outcome: { status: "ok" } },
      }),
    });
    store.insert({
      run_id: "paused-without-start",
      payload_json: JSON.stringify({
        endedAt: 500,
        pauseReason: "sessions_yield",
        execution: { status: "running" },
      }),
    });

    repairLegacySubagentExecutionPayloads(store.db);

    const payload = JSON.parse(store.read("newer-terminal").payload_json);
    expect(payload.execution).toEqual({
      status: "terminal",
      endedAt: 250,
      outcome: { status: "ok" },
    });
    expect(payload.execution).not.toHaveProperty("startedAt");
    const paused = JSON.parse(store.read("paused-without-start").payload_json);
    expect(paused.execution).toEqual({ status: "terminal", endedAt: 500 });
    expect(paused.execution).not.toHaveProperty("startedAt");
  });

  it("leaves malformed payload JSON untouched", () => {
    const store = createDatabase();
    store.insert({
      run_id: "malformed",
      payload_json: "{not-json",
    });

    repairLegacySubagentExecutionPayloads(store.db);

    expect(store.read("malformed").payload_json).toBe("{not-json");
  });
});

describe("repairLegacySubagentRetainedResults", () => {
  it("promotes shipped payload results, projects tasks, and is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE subagent_runs (
        run_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        pending_final_delivery_payload_json TEXT
      ) STRICT;
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        run_id TEXT,
        progress_summary TEXT
      ) STRICT;
    `);
    const legacyPayload = {
      frozenResultText: "(no_reply)",
      fallbackFrozenResultText: "findings captured before wake",
      requesterSessionKey: "agent:main:main",
    };
    db.prepare(
      `INSERT INTO subagent_runs (
        run_id, payload_json, pending_final_delivery_payload_json
      ) VALUES (?, ?, ?)`,
    ).run(
      "completion-run",
      JSON.stringify({
        runId: "completion-run",
        taskRunId: "task-run",
        completion: { required: true, resultText: "(no_reply)" },
        delivery: {
          status: "suspended",
          payload: {
            frozenResultText: "(no_reply)",
            requesterSessionKey: "agent:main:main",
          },
        },
      }),
      JSON.stringify(legacyPayload),
    );
    db.prepare(
      "INSERT INTO task_runs (task_id, runtime, run_id, progress_summary) VALUES (?, ?, ?, ?)",
    ).run("task-id", "subagent", "task-run", "(no_reply)");

    repairLegacySubagentRetainedResults(db);
    const firstPass = db
      .prepare(
        `SELECT payload_json, pending_final_delivery_payload_json
           FROM subagent_runs WHERE run_id = ?`,
      )
      .get("completion-run") as {
      payload_json: string;
      pending_final_delivery_payload_json: string;
    };
    repairLegacySubagentRetainedResults(db);
    const secondPass = db
      .prepare(
        `SELECT payload_json, pending_final_delivery_payload_json
           FROM subagent_runs WHERE run_id = ?`,
      )
      .get("completion-run");

    expect(secondPass).toEqual(firstPass);
    const payload = JSON.parse(firstPass.payload_json);
    expect(payload.completion).toEqual({
      required: true,
      resultText: "(no_reply)",
      fallbackResultText: "findings captured before wake",
    });
    expect(payload.delivery.payload).toEqual({ requesterSessionKey: "agent:main:main" });
    expect(JSON.parse(firstPass.pending_final_delivery_payload_json)).toEqual(legacyPayload);
    expect(
      db.prepare("SELECT progress_summary FROM task_runs WHERE task_id = ?").get("task-id"),
    ).toEqual({ progress_summary: "findings captured before wake" });
  });

  it("preserves newer canonical results over legacy payload copies", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE subagent_runs (
        run_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      ) STRICT;
    `);
    db.prepare("INSERT INTO subagent_runs (run_id, payload_json) VALUES (?, ?)").run(
      "canonical-run",
      JSON.stringify({
        completion: {
          required: true,
          resultText: "canonical result",
          fallbackResultText: "canonical fallback",
        },
        delivery: {
          status: "suspended",
          payload: {
            frozenResultText: "legacy result",
            fallbackFrozenResultText: "legacy fallback",
          },
        },
      }),
    );

    repairLegacySubagentRetainedResults(db);

    const row = db.prepare("SELECT * FROM subagent_runs WHERE run_id = ?").get("canonical-run") as {
      payload_json: string;
    };
    const payload = JSON.parse(row.payload_json);
    expect(payload.completion).toEqual({
      required: true,
      resultText: "canonical result",
      fallbackResultText: "canonical fallback",
    });
    expect(payload.delivery.payload).toEqual({});
  });

  it("preserves authoritative terminal silence while promoting legacy results", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE subagent_runs (
        run_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        run_id TEXT,
        progress_summary TEXT
      ) STRICT;
    `);
    const legacyPayload = {
      frozenResultText: "NO_REPLY",
      fallbackFrozenResultText: "older visible fallback",
    };
    db.prepare("INSERT INTO subagent_runs (run_id, payload_json) VALUES (?, ?)").run(
      "silent-run",
      JSON.stringify({
        taskRunId: "silent-task-run",
        completion: {
          required: true,
          resultText: "NO_REPLY",
          terminalReply: { disposition: "silent" },
        },
        delivery: { status: "suspended", payload: legacyPayload },
      }),
    );
    db.prepare(
      "INSERT INTO task_runs (task_id, runtime, run_id, progress_summary) VALUES (?, ?, ?, ?)",
    ).run("silent-task", "subagent", "silent-task-run", "NO_REPLY");

    repairLegacySubagentRetainedResults(db);

    const stored = db
      .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get("silent-run") as { payload_json: string };
    expect(JSON.parse(stored.payload_json).completion).toEqual({
      required: true,
      resultText: "NO_REPLY",
      fallbackResultText: "older visible fallback",
      terminalReply: { disposition: "silent" },
    });
    expect(
      db.prepare("SELECT progress_summary FROM task_runs WHERE task_id = ?").get("silent-task"),
    ).toEqual({ progress_summary: null });
  });
});
