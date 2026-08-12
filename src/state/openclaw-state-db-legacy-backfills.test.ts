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
  started_at: number | null;
  ended_at: number | null;
  outcome_json: string | null;
  payload_json: string;
};

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE subagent_runs (
      run_id TEXT PRIMARY KEY,
      started_at INTEGER,
      ended_at INTEGER,
      outcome_json TEXT,
      payload_json TEXT NOT NULL
    ) STRICT;
  `);
  const insert = db.prepare(`
    INSERT INTO subagent_runs (run_id, started_at, ended_at, outcome_json, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  return {
    db,
    insert: (row: StoredRun) =>
      insert.run(row.run_id, row.started_at, row.ended_at, row.outcome_json, row.payload_json),
    read: (runId: string) =>
      db.prepare("SELECT * FROM subagent_runs WHERE run_id = ?").get(runId) as StoredRun,
  };
}

// Mirrors the timing/outcome overlay in v2026.7.2-beta.6's SQLite reader.
function readWithShippedBeta6Projection(row: StoredRun) {
  const payload = JSON.parse(row.payload_json);
  const outcome = row.outcome_json ? JSON.parse(row.outcome_json) : payload.outcome;
  return {
    ...payload,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(outcome ? { outcome } : {}),
    execution: {
      ...payload.execution,
      ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
      ...(row.ended_at !== null ? { status: "terminal", endedAt: row.ended_at, outcome } : {}),
    },
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
          run_id, child_session_key, requester_session_key, requester_display_key,
          task, cleanup, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        "agent:main:subagent:legacy",
        "agent:main:main",
        "main",
        "legacy retry limit",
        "keep",
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
      started_at: 100,
      ended_at: 200,
      outcome_json: null,
      payload_json: JSON.stringify({
        startedAt: 100,
        endedAt: 200,
        pauseReason: "sessions_yield",
        execution: { status: "running", startedAt: 100 },
      }),
    });
    store.insert({
      run_id: "killed",
      started_at: 300,
      ended_at: 400,
      outcome_json: JSON.stringify(killedOutcome),
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
    expect(
      firstPass.map(({ started_at, ended_at, outcome_json }) => ({
        started_at,
        ended_at,
        outcome_json,
      })),
    ).toEqual([
      { started_at: 100, ended_at: 200, outcome_json: null },
      { started_at: 300, ended_at: 400, outcome_json: JSON.stringify(killedOutcome) },
    ]);
    expect(readWithShippedBeta6Projection(firstPass[1]!)).toMatchObject({
      startedAt: 300,
      endedAt: 400,
      outcome: killedOutcome,
      execution: {
        status: "terminal",
        startedAt: 300,
        endedAt: 400,
        outcome: killedOutcome,
      },
    });
  });

  it("preserves newer canonical terminal state and optional start timing", () => {
    const store = createDatabase();
    store.insert({
      run_id: "newer-terminal",
      started_at: 100,
      ended_at: 200,
      outcome_json: JSON.stringify({ status: "error", error: "manual kill" }),
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
      started_at: null,
      ended_at: 500,
      outcome_json: null,
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
      started_at: null,
      ended_at: null,
      outcome_json: null,
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
        pending_final_delivery_payload_json TEXT,
        frozen_result_text TEXT,
        fallback_frozen_result_text TEXT
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
        run_id, payload_json, pending_final_delivery_payload_json,
        frozen_result_text, fallback_frozen_result_text
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "completion-run",
      JSON.stringify({
        runId: "completion-run",
        taskRunId: "task-run",
        completion: { required: true, resultText: "(no_reply)" },
        delivery: { status: "suspended", payload: legacyPayload },
      }),
      JSON.stringify(legacyPayload),
      "(no_reply)",
      null,
    );
    db.prepare(
      "INSERT INTO task_runs (task_id, runtime, run_id, progress_summary) VALUES (?, ?, ?, ?)",
    ).run("task-id", "subagent", "task-run", "(no_reply)");

    repairLegacySubagentRetainedResults(db);
    const firstPass = db
      .prepare(
        `SELECT payload_json, pending_final_delivery_payload_json,
                frozen_result_text, fallback_frozen_result_text
           FROM subagent_runs WHERE run_id = ?`,
      )
      .get("completion-run") as {
      payload_json: string;
      pending_final_delivery_payload_json: string;
      frozen_result_text: string | null;
      fallback_frozen_result_text: string | null;
    };
    repairLegacySubagentRetainedResults(db);
    const secondPass = db
      .prepare(
        `SELECT payload_json, pending_final_delivery_payload_json,
                frozen_result_text, fallback_frozen_result_text
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
    expect(JSON.parse(firstPass.pending_final_delivery_payload_json)).toEqual({
      requesterSessionKey: "agent:main:main",
    });
    expect(firstPass.frozen_result_text).toBe("(no_reply)");
    expect(firstPass.fallback_frozen_result_text).toBe("findings captured before wake");
    expect(
      db.prepare("SELECT progress_summary FROM task_runs WHERE task_id = ?").get("task-id"),
    ).toEqual({ progress_summary: "findings captured before wake" });
  });

  it("preserves newer canonical results over legacy payload copies", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE subagent_runs (
        run_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        pending_final_delivery_payload_json TEXT,
        frozen_result_text TEXT,
        fallback_frozen_result_text TEXT
      ) STRICT;
    `);
    db.prepare(
      `INSERT INTO subagent_runs (
        run_id, payload_json, pending_final_delivery_payload_json,
        frozen_result_text, fallback_frozen_result_text
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
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
      JSON.stringify({
        frozenResultText: "legacy result",
        fallbackFrozenResultText: "legacy fallback",
      }),
      "legacy result",
      "legacy fallback",
    );

    repairLegacySubagentRetainedResults(db);

    const row = db.prepare("SELECT * FROM subagent_runs WHERE run_id = ?").get("canonical-run") as {
      payload_json: string;
      pending_final_delivery_payload_json: string;
      frozen_result_text: string | null;
      fallback_frozen_result_text: string | null;
    };
    const payload = JSON.parse(row.payload_json);
    expect(payload.completion).toEqual({
      required: true,
      resultText: "canonical result",
      fallbackResultText: "canonical fallback",
    });
    expect(payload.delivery.payload).toEqual({});
    expect(JSON.parse(row.pending_final_delivery_payload_json)).toEqual({});
    expect(row.frozen_result_text).toBe("canonical result");
    expect(row.fallback_frozen_result_text).toBe("canonical fallback");
  });

  it("preserves authoritative terminal silence while promoting legacy results", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE subagent_runs (
        run_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        pending_final_delivery_payload_json TEXT,
        frozen_result_text TEXT,
        fallback_frozen_result_text TEXT
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
    db.prepare(
      `INSERT INTO subagent_runs (
        run_id, payload_json, pending_final_delivery_payload_json,
        frozen_result_text, fallback_frozen_result_text
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
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
      JSON.stringify(legacyPayload),
      "NO_REPLY",
      "older visible fallback",
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
