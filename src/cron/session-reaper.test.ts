// Cron session reaper tests cover cleanup of sessions created by scheduled runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import type { Logger } from "./service/state.js";
import { sweepCronRunSessions, resolveRetentionMs, resetReaperThrottle } from "./session-reaper.js";

const taskStatusMocks = vi.hoisted(() => ({ hasPendingGeneratedMediaTask: vi.fn() }));

vi.mock("../tasks/task-status-access.js", () => ({
  hasPendingGeneratedMediaTaskForSessionKey: taskStatusMocks.hasPendingGeneratedMediaTask,
}));

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("resolveRetentionMs", () => {
  it("returns 24h default when no config", () => {
    expect(resolveRetentionMs()).toBe(24 * 3_600_000);
  });

  it("returns 24h default when config is empty", () => {
    expect(resolveRetentionMs({})).toBe(24 * 3_600_000);
  });

  it("parses duration string", () => {
    expect(resolveRetentionMs({ sessionRetention: "1h" })).toBe(3_600_000);
    expect(resolveRetentionMs({ sessionRetention: "7d" })).toBe(7 * 86_400_000);
    expect(resolveRetentionMs({ sessionRetention: "30m" })).toBe(30 * 60_000);
  });

  it("returns null when disabled", () => {
    expect(resolveRetentionMs({ sessionRetention: false })).toBeNull();
  });

  it("falls back to default on invalid string", () => {
    expect(resolveRetentionMs({ sessionRetention: "abc" })).toBe(24 * 3_600_000);
  });
});

describe("isCronRunSessionKey", () => {
  it("matches cron run session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc-123:run:def-456")).toBe(true);
    expect(isCronRunSessionKey("agent:debugger:cron:249ecf82:run:1102aabb")).toBe(true);
  });

  it("matches cron run descendant session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc-123:run:def-456:subagent:worker")).toBe(true);
    expect(isCronRunSessionKey("agent:main:cron:abc-123:run:def-456:thread:reply")).toBe(true);
  });

  it("does not match base cron session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc-123")).toBe(false);
  });

  it("does not match regular session keys", () => {
    expect(isCronRunSessionKey("agent:main:telegram:dm:123")).toBe(false);
  });

  it("does not match non-canonical cron-like keys", () => {
    expect(isCronRunSessionKey("agent:main:slack:cron:job:run:uuid")).toBe(false);
    expect(isCronRunSessionKey("cron:job:run:uuid")).toBe(false);
  });
});

describe("sweepCronRunSessions", () => {
  let tmpDir: string;
  let storePath: string;
  const log = createTestLogger();

  beforeEach(async () => {
    resetReaperThrottle();
    taskStatusMocks.hasPendingGeneratedMediaTask.mockReset().mockReturnValue(false);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-reaper-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  it("prunes expired cron run sessions", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1": {
        sessionId: "base-session",
        updatedAt: now,
      },
      "agent:main:cron:job1:run:old-run": {
        sessionId: "old-run",
        updatedAt: now - 25 * 3_600_000, // 25h ago — expired
      },
      "agent:main:cron:job1:run:old-run:subagent:worker": {
        sessionId: "old-run-child",
        updatedAt: now - 25 * 3_600_000, // expired cron-run descendant
      },
      "agent:main:cron:job1:run:recent-run": {
        sessionId: "recent-run",
        updatedAt: now - 1 * 3_600_000, // 1h ago — not expired
      },
      "agent:main:cron:job1:run:recent-run:thread:reply": {
        sessionId: "recent-run-thread",
        updatedAt: now - 1 * 3_600_000, // active cron-run descendant
      },
      "agent:main:telegram:dm:123": {
        sessionId: "regular-session",
        updatedAt: now - 100 * 3_600_000, // old but not a cron run
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(2);

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated).toEqual({
      "agent:main:cron:job1": {
        sessionId: "base-session",
        updatedAt: now,
      },
      "agent:main:cron:job1:run:recent-run": {
        sessionId: "recent-run",
        updatedAt: now - 1 * 3_600_000,
      },
      "agent:main:cron:job1:run:recent-run:thread:reply": {
        sessionId: "recent-run-thread",
        updatedAt: now - 1 * 3_600_000,
      },
      "agent:main:telegram:dm:123": {
        sessionId: "regular-session",
        updatedAt: now - 100 * 3_600_000,
      },
    });
  });

  it("preserves expired continuation rows while generated media is pending", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:pending-run";
    const store = {
      [sessionKey]: {
        sessionId: "pending-run",
        updatedAt: now - 25 * 3_600_000,
        cronRunContinuation: { lifecycleRevision: "revision-1", phase: "ready" },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));
    taskStatusMocks.hasPendingGeneratedMediaTask.mockReturnValue(true);

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(0);
    expect(JSON.parse(fs.readFileSync(storePath, "utf-8"))).toEqual(store);
  });

  it("preserves an orphaned gateway continuation while generated media is pending", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:orphaned-run";
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "orphaned-run",
          updatedAt: now - 25 * 3_600_000,
          cronRunContinuation: {
            lifecycleRevision: "revision-1",
            phase: "continuing",
            ownerRunId: "dead-gateway-run",
            basePersisted: false,
          },
        },
      }),
    );
    taskStatusMocks.hasPendingGeneratedMediaTask.mockReturnValue(true);

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(0);
    expect(JSON.parse(fs.readFileSync(storePath, "utf-8"))[sessionKey]).toMatchObject({
      updatedAt: now - 25 * 3_600_000,
      cronRunContinuation: {
        lifecycleRevision: "revision-1",
        phase: "continuing",
        ownerRunId: "dead-gateway-run",
        basePersisted: false,
      },
    });
  });

  it("prunes expired orphaned continuation owners", async () => {
    const now = Date.now();
    const runningKey = "agent:main:cron:job1:run:running-run";
    const continuingKey = "agent:main:cron:job1:run:continuing-run";
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [runningKey]: {
          sessionId: "running-run",
          updatedAt: now - 25 * 3_600_000,
          cronRunContinuation: {
            lifecycleRevision: "revision-1",
            phase: "running",
          },
        },
        [continuingKey]: {
          sessionId: "continuing-run",
          updatedAt: now - 25 * 3_600_000,
          cronRunContinuation: {
            lifecycleRevision: "revision-2",
            phase: "continuing",
            ownerRunId: "gateway-run",
          },
        },
      }),
    );

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(2);
    expect(JSON.parse(fs.readFileSync(storePath, "utf-8"))).toEqual({});
  });

  it("preserves an expired continuation while its gateway owner is active", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:continuing-run";
    const store = {
      [sessionKey]: {
        sessionId: "continuing-run",
        updatedAt: now - 25 * 3_600_000,
        cronRunContinuation: {
          lifecycleRevision: "revision-1",
          phase: "continuing",
          ownerRunId: "gateway-run",
        },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey],
      assertAllowed: () => {},
    });
    try {
      const result = await sweepCronRunSessions({
        sessionStorePath: storePath,
        nowMs: now,
        log,
        force: true,
      });

      expect(result.pruned).toBe(0);
      expect(JSON.parse(fs.readFileSync(storePath, "utf-8"))).toEqual(store);
    } finally {
      admission.release();
    }
  });

  it("archives transcript files for pruned run sessions that are no longer referenced", async () => {
    const now = Date.now();
    const runSessionId = "old-run";
    const runTranscript = path.join(tmpDir, `${runSessionId}.jsonl`);
    fs.writeFileSync(runTranscript, '{"type":"session"}\n');
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:old-run": {
        sessionId: runSessionId,
        updatedAt: now - 25 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
    expect(fs.existsSync(runTranscript)).toBe(false);
    const files = fs.readdirSync(tmpDir);
    const archivedRunTranscripts = files.filter((name) =>
      name.startsWith(`${runSessionId}.jsonl.deleted.`),
    );
    expect(archivedRunTranscripts.length).toBeGreaterThan(0);
  });

  it("does not archive external transcript paths for pruned runs", async () => {
    const now = Date.now();
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-reaper-external-"));
    const externalTranscript = path.join(externalDir, "outside.jsonl");
    fs.writeFileSync(externalTranscript, '{"type":"session"}\n');
    const store: Record<string, { sessionId: string; sessionFile?: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:old-run": {
        sessionId: "old-run",
        sessionFile: externalTranscript,
        updatedAt: now - 25 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    try {
      const result = await sweepCronRunSessions({
        sessionStorePath: storePath,
        nowMs: now,
        log,
        force: true,
      });

      expect(result.pruned).toBe(1);
      expect(fs.existsSync(externalTranscript)).toBe(true);
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("respects custom retention", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:run1": {
        sessionId: "run1",
        updatedAt: now - 2 * 3_600_000, // 2h ago
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: "1h" },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
  });

  it("does nothing when pruning is disabled", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:run1": {
        sessionId: "run1",
        updatedAt: now - 100 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: false },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(false);
    expect(result.pruned).toBe(0);
  });

  it("throttles sweeps without force", async () => {
    const now = Date.now();
    fs.writeFileSync(storePath, JSON.stringify({}));

    // First sweep runs
    const r1 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });
    expect(r1.swept).toBe(true);

    // Second sweep (1 second later) is throttled
    const r2 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now + 1000,
      log,
    });
    expect(r2.swept).toBe(false);
  });

  it("throttles per store path", async () => {
    const now = Date.now();
    const otherPath = path.join(tmpDir, "sessions-other.json");
    fs.writeFileSync(storePath, JSON.stringify({}));
    fs.writeFileSync(otherPath, JSON.stringify({}));

    const r1 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });
    expect(r1.swept).toBe(true);

    const r2 = await sweepCronRunSessions({
      sessionStorePath: otherPath,
      nowMs: now + 1000,
      log,
    });
    expect(r2.swept).toBe(true);

    const r3 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now + 1000,
      log,
    });
    expect(r3.swept).toBe(false);
  });
});
