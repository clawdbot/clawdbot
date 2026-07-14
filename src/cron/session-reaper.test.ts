// Cron session reaper tests cover cleanup of sessions created by scheduled runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferred } from "../test-utils/deferred.js";
import type { Logger } from "./service/state.js";
import { sweepCronRunSessions, resolveRetentionMs, resetReaperThrottle } from "./session-reaper.js";

const { listSessionEntries, patchSessionEntry, replaceSessionEntry } = sessionAccessor;

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

async function seedSessionEntries(
  storePath: string,
  entries: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ storePath, sessionKey }, entry);
  }
}

function readSessionEntries(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
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
    const store: Record<string, SessionEntry> = {
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
    await seedSessionEntries(storePath, store);

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(2);

    const updated = readSessionEntries(storePath);
    expect(Object.keys(updated).toSorted()).toEqual([
      "agent:main:cron:job1",
      "agent:main:cron:job1:run:recent-run",
      "agent:main:cron:job1:run:recent-run:thread:reply",
      "agent:main:telegram:dm:123",
    ]);
    expect(updated["agent:main:cron:job1"]).toMatchObject({
      sessionId: "base-session",
      updatedAt: now,
    });
    expect(updated["agent:main:cron:job1:run:recent-run"]).toMatchObject({
      sessionId: "recent-run",
      updatedAt: now - 1 * 3_600_000,
    });
    expect(updated["agent:main:cron:job1:run:recent-run:thread:reply"]).toMatchObject({
      sessionId: "recent-run-thread",
      updatedAt: now - 1 * 3_600_000,
    });
    expect(updated["agent:main:telegram:dm:123"]).toMatchObject({
      sessionId: "regular-session",
      updatedAt: now - 100 * 3_600_000,
    });
  });

  it("preserves expired continuation rows while generated media is pending", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:pending-run";
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId: "pending-run",
        updatedAt: now - 25 * 3_600_000,
        cronRunContinuation: { lifecycleRevision: "revision-1", phase: "ready" },
      },
    };
    await seedSessionEntries(storePath, store);
    taskStatusMocks.hasPendingGeneratedMediaTask.mockReturnValue(true);

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(0);
    expect(readSessionEntries(storePath)).toEqual(store);
  });

  it("preserves an orphaned gateway continuation while generated media is pending", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:orphaned-run";
    await seedSessionEntries(storePath, {
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
    });
    taskStatusMocks.hasPendingGeneratedMediaTask.mockReturnValue(true);

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(0);
    expect(readSessionEntries(storePath)[sessionKey]).toMatchObject({
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
    await seedSessionEntries(storePath, {
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
    });

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(2);
    expect(readSessionEntries(storePath)).toEqual({});
  });

  it("preserves an expired run when work is admitted before writer-owned removal", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:active-run";
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId: "active-run",
        updatedAt: now - 25 * 3_600_000,
      },
    };
    await seedSessionEntries(storePath, store);
    const writerStarted = createDeferred();
    const releaseWriter = createDeferred();
    const firstValidation = createDeferred();
    const writer = patchSessionEntry({ storePath, sessionKey }, async () => {
      writerStarted.resolve();
      await releaseWriter.promise;
      return {};
    });
    await writerStarted.promise;

    const sweep = sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });
    const admissionPromise = beginSessionWorkAdmission({
      scope: storePath,
      identities: ["active-run"],
      assertAllowed: () => {
        firstValidation.resolve();
      },
    });
    await firstValidation.promise;

    let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    try {
      releaseWriter.resolve();
      const result = await sweep;
      admission = await admissionPromise;

      expect(result.pruned).toBe(0);
      expect(readSessionEntries(storePath)[sessionKey]).toMatchObject({
        sessionId: "active-run",
        updatedAt: expect.any(Number),
      });
    } finally {
      admission?.release();
      releaseWriter.resolve();
      await Promise.allSettled([writer, sweep, admissionPromise]);
    }
  });

  it("respects custom retention", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:job1:run:run1": {
        sessionId: "run1",
        updatedAt: now - 2 * 3_600_000, // 2h ago
      },
    };
    await seedSessionEntries(storePath, store);

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
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:job1:run:run1": {
        sessionId: "run1",
        updatedAt: now - 100 * 3_600_000,
      },
    };
    await seedSessionEntries(storePath, store);

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

  it("updates throttle after persistence errors so the next tick does not thrash (#105188)", async () => {
    const now = Date.now();
    const warn = vi.fn();
    const failingLog: Logger = { ...log, warn };
    const eacces = Object.assign(new Error("EACCES: permission denied, open 'sessions.json'"), {
      code: "EACCES",
    });
    const listSpy = vi.spyOn(sessionAccessor, "listSessionEntries").mockImplementation(() => {
      throw eacces;
    });

    try {
      const first = await sweepCronRunSessions({
        sessionStorePath: storePath,
        nowMs: now,
        log: failingLog,
      });
      expect(first).toEqual({ swept: false, pruned: 0 });
      expect(warn).toHaveBeenCalledWith(
        { err: String(eacces) },
        "cron-reaper: failed to sweep session store",
      );
      expect(listSpy).toHaveBeenCalledTimes(1);

      warn.mockClear();
      const immediateRetry = await sweepCronRunSessions({
        sessionStorePath: storePath,
        nowMs: now + 1_000,
        log: failingLog,
      });
      expect(immediateRetry).toEqual({ swept: false, pruned: 0 });
      expect(warn).not.toHaveBeenCalled();
      expect(listSpy).toHaveBeenCalledTimes(1);

      const afterCooldown = await sweepCronRunSessions({
        sessionStorePath: storePath,
        nowMs: now + 5 * 60_000,
        log: failingLog,
      });
      expect(afterCooldown).toEqual({ swept: false, pruned: 0 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(listSpy).toHaveBeenCalledTimes(2);
    } finally {
      listSpy.mockRestore();
    }
  });
});
