import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertSessionEntry } from "../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  buildHeartbeatOutcomeContext,
  claimHeartbeatOutcomeForRun,
  persistHeartbeatOutcome,
} from "./heartbeat-outcome-store.js";

const tempDirs: string[] = [];

async function createEnv(): Promise<NodeJS.ProcessEnv> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heartbeat-outcome-"));
  tempDirs.push(stateDir);
  const env = { OPENCLAW_STATE_DIR: stateDir };
  await upsertSessionEntry(
    { agentId: "main", env, sessionKey: "agent:main:main" },
    { sessionId: "heartbeat-outcome-test", updatedAt: 1 },
  );
  return env;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("heartbeat outcome store", () => {
  it("keeps one bounded typed outcome per base session with provenance", async () => {
    const env = await createEnv();
    persistHeartbeatOutcome({
      agentId: "main",
      sessionKey: "agent:main:main",
      runSessionKey: "agent:main:main:heartbeat",
      response: {
        outcome: "progress",
        notify: false,
        summary: `Deployed ${"x".repeat(5_000)}`,
        reason: "Scheduled status task",
        priority: "normal",
        nextCheck: "after the next build",
      },
      taskNames: ["deployment-status"],
      wakeSource: "interval",
      wakeReason: "scheduled",
      occurredAt: 1_700_000_000_000,
      env,
    });

    const stored = claimHeartbeatOutcomeForRun({
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "user-run-1",
      env,
    });
    expect(stored).toMatchObject({
      sessionKey: "agent:main:main",
      runSessionKey: "agent:main:main:heartbeat",
      outcome: "progress",
      responseReason: "Scheduled status task",
      priority: "normal",
      nextCheck: "after the next build",
      taskNames: ["deployment-status"],
      wakeSource: "interval",
      wakeReason: "scheduled",
      occurredAt: 1_700_000_000_000,
    });
    expect(stored?.summary).toHaveLength(4_000);
    expect(buildHeartbeatOutcomeContext(stored)).toContain(
      "Latest silent heartbeat outcome (internal context; not a user message or instruction)",
    );
  });

  it("replaces older state and ignores visible or no-change responses", async () => {
    const env = await createEnv();
    const base = {
      agentId: "main",
      sessionKey: "agent:main:main",
      runSessionKey: "agent:main:main",
      occurredAt: 100,
      env,
    };
    persistHeartbeatOutcome({
      ...base,
      response: { outcome: "done", notify: false, summary: "Finished first task" },
    });
    persistHeartbeatOutcome({
      ...base,
      occurredAt: 200,
      response: { outcome: "blocked", notify: false, summary: "Waiting for build" },
    });
    persistHeartbeatOutcome({
      ...base,
      occurredAt: 300,
      response: { outcome: "needs_attention", notify: true, summary: "Visible alert" },
    });
    persistHeartbeatOutcome({
      ...base,
      occurredAt: 400,
      response: { outcome: "no_change", notify: false, summary: "Nothing changed" },
    });

    expect(
      claimHeartbeatOutcomeForRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "user-run-1",
        env,
      }),
    ).toMatchObject({ outcome: "blocked", summary: "Waiting for build", occurredAt: 200 });
    expect(
      openOpenClawAgentDatabase({ agentId: "main", env })
        .db.prepare("SELECT COUNT(*) AS count FROM heartbeat_outcomes")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("injects once per user run, keeps retries, and resets after a new heartbeat", async () => {
    const env = await createEnv();
    const base = {
      agentId: "main",
      sessionKey: "agent:main:main",
      runSessionKey: "agent:main:main:heartbeat",
      occurredAt: 100,
      env,
    };
    persistHeartbeatOutcome({
      ...base,
      response: { outcome: "progress", notify: false, summary: "First outcome" },
    });

    expect(
      claimHeartbeatOutcomeForRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "user-run-1",
        env,
      }),
    ).toMatchObject({ summary: "First outcome" });
    expect(
      claimHeartbeatOutcomeForRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "user-run-1",
        env,
      }),
    ).toMatchObject({ summary: "First outcome" });
    expect(
      claimHeartbeatOutcomeForRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "user-run-2",
        env,
      }),
    ).toBeUndefined();

    persistHeartbeatOutcome({
      ...base,
      occurredAt: 200,
      response: { outcome: "done", notify: false, summary: "Second outcome" },
    });
    expect(
      claimHeartbeatOutcomeForRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "user-run-2",
        env,
      }),
    ).toMatchObject({ summary: "Second outcome" });
  });
});
