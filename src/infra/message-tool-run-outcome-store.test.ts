import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { recordMessageToolRunOutcome } from "./message-tool-run-outcome-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createEnv(): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-message-tool-outcome-") };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("message-tool run outcome store", () => {
  it("lazily records typed completion facts in an existing same-version database", () => {
    const env = createEnv();
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db.exec("DROP TABLE message_tool_run_outcomes;");
    closeOpenClawAgentDatabasesForTest();

    for (const [runId, outcome, runStatus] of [
      ["run-delivered", "tool_delivered", "completed"],
      ["run-mute", "mute", "completed"],
      ["run-error", "mute", "errored"],
    ] as const) {
      recordMessageToolRunOutcome({
        runId,
        sessionKey: "agent:main:main",
        agentId: "main",
        provider: "openai",
        model: "gpt-5.6-luna",
        outcome,
        runStatus,
        occurredAt: 100,
        env,
      });
    }

    expect(
      openOpenClawAgentDatabase({ agentId: "main", env })
        .db.prepare("SELECT run_id, outcome, run_status FROM message_tool_run_outcomes ORDER BY id")
        .all(),
    ).toEqual([
      { run_id: "run-delivered", outcome: "tool_delivered", run_status: "completed" },
      { run_id: "run-mute", outcome: "mute", run_status: "completed" },
      { run_id: "run-error", outcome: "mute", run_status: "errored" },
    ]);
  });

  it("prunes the per-agent operational history to 10,000 newest rows", () => {
    const env = createEnv();
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db.exec(`
      WITH RECURSIVE rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM rows WHERE value <= 10000
      )
      INSERT INTO message_tool_run_outcomes (
        run_id, session_key, agent_id, provider, model, outcome, run_status, occurred_at
      )
      SELECT
        'seed-' || value, 'agent:main:main', 'main', 'openai', 'gpt-5.6-luna',
        'mute', 'completed', value
      FROM rows;
    `);

    recordMessageToolRunOutcome({
      runId: "newest",
      sessionKey: "agent:main:main",
      agentId: "main",
      provider: "openai",
      model: "gpt-5.6-luna",
      outcome: "tool_delivered",
      runStatus: "completed",
      occurredAt: 20_000,
      env,
    });

    expect(
      database.db
        .prepare(
          "SELECT COUNT(*) AS count, MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest FROM message_tool_run_outcomes",
        )
        .get(),
    ).toEqual({ count: 10_000, oldest: 3, newest: 20_000 });
  });
});
