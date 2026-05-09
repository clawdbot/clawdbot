import { describe, expect, it } from "vitest";
import { redactSensitiveStatusSummary } from "./status.summary.js";
import type { StatusSummary } from "./status.types.js";

function createRecentSessionRow() {
  return {
    key: "main",
    kind: "direct" as const,
    sessionId: "sess-1",
    updatedAt: 1,
    age: 2,
    totalTokens: 3,
    totalTokensFresh: true,
    remainingTokens: 4,
    percentUsed: 5,
    model: "gpt-5",
    contextTokens: 200_000,
    flags: ["id:sess-1"],
  };
}

describe("redactSensitiveStatusSummary", () => {
  it("removes sensitive session and path details while preserving summary structure", () => {
    const input: StatusSummary = {
      runtimeVersion: "2026.3.8",
      heartbeat: {
        defaultAgentId: "main",
        agents: [{ agentId: "main", enabled: true, every: "5m", everyMs: 300_000 }],
      },
      channelSummary: ["ok"],
      queuedSystemEvents: ["none"],
      tasks: {
        total: 2,
        active: 1,
        terminal: 1,
        failures: 1,
        byStatus: {
          queued: 1,
          running: 0,
          succeeded: 0,
          failed: 1,
          timed_out: 0,
          cancelled: 0,
          lost: 0,
        },
        byRuntime: {
          subagent: 0,
          acp: 1,
          cli: 0,
          cron: 1,
        },
      },
      taskAudit: {
        total: 1,
        warnings: 1,
        errors: 0,
        byCode: {
          stale_queued: 0,
          stale_running: 0,
          lost: 0,
          delivery_failed: 1,
          missing_cleanup: 0,
          inconsistent_timestamps: 0,
        },
      },
      sessions: {
        paths: ["/tmp/openclaw/sessions.json"],
        count: 1,
        defaults: { model: "gpt-5", contextTokens: 200_000 },
        recent: [createRecentSessionRow()],
        byAgent: [
          {
            agentId: "main",
            path: "/tmp/openclaw/main-sessions.json",
            count: 1,
            recent: [createRecentSessionRow()],
          },
        ],
      },
    };

    const redacted = redactSensitiveStatusSummary(input);
    expect(redacted.sessions.paths).toStrictEqual([]);
    expect(redacted.sessions.defaults).toEqual({ model: null, contextTokens: null });
    expect(redacted.sessions.recent).toStrictEqual([]);
    expect(redacted.sessions.byAgent[0]?.path).toBe("[redacted]");
    expect(redacted.sessions.byAgent[0]?.recent).toStrictEqual([]);
    expect(redacted.runtimeVersion).toBe("2026.3.8");
    expect(redacted.heartbeat).toEqual(input.heartbeat);
    expect(redacted.channelSummary).toEqual(input.channelSummary);
    expect(redacted.tasks).toEqual(input.tasks);
    expect(redacted.taskAudit).toEqual(input.taskAudit);
  });
});
