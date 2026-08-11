// Cron session reaper tests cover cleanup of sessions created by scheduled runs.
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  listKnownSessionStoreAgentIds,
  resolveExistingAgentSessionStoreTargetsSync,
} from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import {
  isSameOpenClawAgentDatabasePath,
  listOpenClawRegisteredAgentDatabases,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { Logger } from "./service/state.js";
import { sweepCronRunSessions as sweepCronRunSessionsImpl } from "./session-reaper.js";
import { resetReaperThrottle } from "./session-reaper.test-support.js";

const { listSessionEntriesCore, patchSessionEntryCore, replaceSessionEntry } = sessionAccessor;

const taskStatusMocks = vi.hoisted(() => ({
  buildPendingSet: vi.fn<() => Set<string>>(() => new Set()),
}));

function sweepCronRunSessions(
  params: Omit<Parameters<typeof sweepCronRunSessionsImpl>[0], "agentId" | "defaultAgentId">,
) {
  return sweepCronRunSessionsImpl({ ...params, agentId: "main", defaultAgentId: "main" });
}

vi.mock("../tasks/task-status-access.js", () => ({
  buildPendingGeneratedMediaSessionKeySet: taskStatusMocks.buildPendingSet,
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
    await replaceSessionEntry({ agentId: "main", storePath, sessionKey }, entry);
  }
}

function readSessionEntries(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({ agentId: "main", storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
}

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
  const tempDirs: string[] = [];
  let tmpDir: string;
  let storePath: string;
  const log = createTestLogger();

  beforeEach(async () => {
    resetReaperThrottle();
    taskStatusMocks.buildPendingSet.mockReset().mockReturnValue(new Set());
    tmpDir = makeTempDir(tempDirs, "cron-reaper-");
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("prunes expired cron run sessions", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:job1": {
        sessionId: "base-session",
        updatedAt: now - 25 * 3_600_000, // stale base row — preserve
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
      updatedAt: now - 25 * 3_600_000,
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

  it("commits expired rows and warns when transcript archive retention cleanup fails", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:cleanup-failure";
    const sessionId = "cleanup-failure";
    const staleArchive = path.join(tmpDir, "older.jsonl.deleted.2026-01-01T00-00-00.000Z");
    const cleanupError = Object.assign(new Error("archive cleanup denied"), { code: "EACCES" });
    const warn = vi.fn();
    const failingLog: Logger = { ...log, warn };

    await seedSessionEntries(storePath, {
      [sessionKey]: { sessionId, updatedAt: now - 25 * 3_600_000 },
    });
    await sessionAccessor.appendTranscriptMessage(
      { agentId: "main", sessionId, sessionKey, storePath },
      { cwd: tmpDir, message: { role: "user", content: "archive me" } },
    );
    await fsPromises.writeFile(staleArchive, "stale archive", "utf8");
    setRuntimeConfigSnapshot({
      session: {
        maintenance: {
          maxDiskBytes: false,
          resetArchiveRetention: "1ms",
        },
      },
    });
    const rmSpy = vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(cleanupError);

    try {
      const result = await sweepCronRunSessions({
        sessionStorePath: storePath,
        nowMs: now,
        log: failingLog,
        force: true,
      });

      expect(result).toEqual({ swept: true, pruned: 1 });
      expect(readSessionEntries(storePath)[sessionKey]).toBeUndefined();
      await expect(fsPromises.access(staleArchive)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        { err: expect.stringContaining("archive cleanup denied") },
        "cron-reaper: transcript cleanup failed",
      );
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("discovers, accesses, and reaps a logical owner in one shared exact store", async () => {
    const now = Date.now();
    const exactStorePath = path.join(tmpDir, "shared.sqlite");
    const cfg: OpenClawConfig = {
      session: { store: exactStorePath },
      agents: { entries: { main: { default: true } } },
    };
    const mainKey = "agent:main:cron:main-job:run:keep";
    const opsKey = "agent:ops:cron:ops-job:run:expired";
    await replaceSessionEntry(
      {
        agentId: "main",
        defaultAgentId: "main",
        storePath: exactStorePath,
        sessionKey: mainKey,
      },
      { sessionId: "main-run", updatedAt: now - 1 * 3_600_000 },
    );
    await replaceSessionEntry(
      {
        agentId: "ops",
        defaultAgentId: "main",
        storePath: exactStorePath,
        sessionKey: opsKey,
      },
      { sessionId: "ops-run", updatedAt: now - 25 * 3_600_000 },
    );
    closeOpenClawAgentDatabasesForTest();
    unregisterOpenClawAgentDatabase({ agentId: "main", path: exactStorePath });
    expect(
      listOpenClawRegisteredAgentDatabases().filter((entry) =>
        isSameOpenClawAgentDatabasePath(entry.path, exactStorePath),
      ),
    ).toEqual([]);

    expect(listKnownSessionStoreAgentIds(cfg).toSorted()).toEqual(["main", "ops"]);
    expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ops")).toEqual([
      { agentId: "ops", storePath: exactStorePath },
    ]);
    expect(Object.keys(loadCombinedSessionStoreForGatewayCore(cfg).store).toSorted()).toEqual([
      mainKey,
      opsKey,
    ]);
    expect(
      sessionAccessor.loadSessionEntry({
        agentId: "ops",
        defaultAgentId: "main",
        storePath: exactStorePath,
        sessionKey: opsKey,
      }),
    ).toMatchObject({ sessionId: "ops-run" });

    expect(
      await sweepCronRunSessionsImpl({
        agentId: "main",
        defaultAgentId: "main",
        sessionStorePath: exactStorePath,
        nowMs: now,
        log,
      }),
    ).toEqual({ swept: true, pruned: 0 });
    const result = await sweepCronRunSessionsImpl({
      agentId: "ops",
      defaultAgentId: "main",
      sessionStorePath: exactStorePath,
      nowMs: now,
      log,
    });

    expect(result).toEqual({ swept: true, pruned: 1 });
    expect(
      sessionAccessor.loadSessionEntry({
        agentId: "main",
        defaultAgentId: "main",
        storePath: exactStorePath,
        sessionKey: mainKey,
      }),
    ).toMatchObject({ sessionId: "main-run" });
    expect(
      sessionAccessor.loadSessionEntry({
        agentId: "ops",
        defaultAgentId: "main",
        storePath: exactStorePath,
        sessionKey: opsKey,
      }),
    ).toBeUndefined();
  });

  it("falls back to the default retention when the configured duration is invalid", async () => {
    const now = Date.now();
    await seedSessionEntries(storePath, {
      "agent:main:cron:job1:run:old-run": {
        sessionId: "old-run",
        updatedAt: now - 25 * 3_600_000,
      },
    });

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: "not-a-duration" },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result).toEqual({ swept: true, pruned: 1 });
  });

  it("preserves expired continuation rows while generated media is pending", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:pending-run";
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId: "pending-run",
        updatedAt: now - 25 * 3_600_000,
        delivery: { kind: "none" },
        cronRunContinuation: { lifecycleRevision: "revision-1", phase: "ready" },
      },
    };
    await seedSessionEntries(storePath, store);
    taskStatusMocks.buildPendingSet.mockReturnValue(new Set([sessionKey]));

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
    taskStatusMocks.buildPendingSet.mockReturnValue(new Set([sessionKey]));

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
    const writer = patchSessionEntryCore({ storePath, sessionKey }, async () => {
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

  it.each([["0h"], ["0s"], ["0"]])(
    "treats a zero retention (%s) as disabled instead of pruning everything",
    async (sessionRetention) => {
      const now = Date.now();
      const store: Record<string, SessionEntry> = {
        "agent:main:cron:job1:run:run1": {
          sessionId: "run1",
          updatedAt: now - 100 * 3_600_000,
        },
      };
      await seedSessionEntries(storePath, store);

      const result = await sweepCronRunSessions({
        cronConfig: { sessionRetention },
        sessionStorePath: storePath,
        nowMs: now,
        log,
        force: true,
      });

      expect(result.swept).toBe(false);
      expect(result.pruned).toBe(0);
      expect(readSessionEntries(storePath)).toHaveProperty("agent:main:cron:job1:run:run1");
    },
  );

  it("sweeps immediately when disabled retention is enabled again", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:job1:run:expired-run";
    await seedSessionEntries(storePath, {
      [sessionKey]: {
        sessionId: "expired-run",
        updatedAt: now - 25 * 3_600_000,
      },
    });

    expect(
      await sweepCronRunSessions({
        cronConfig: { sessionRetention: false },
        sessionStorePath: storePath,
        nowMs: now,
        log,
      }),
    ).toEqual({ swept: false, pruned: 0 });

    expect(
      await sweepCronRunSessions({
        sessionStorePath: storePath,
        nowMs: now + 1_000,
        log,
      }),
    ).toEqual({ swept: true, pruned: 1 });
    expect(readSessionEntries(storePath)[sessionKey]).toBeUndefined();
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

  it("resumes retention cleanup after the wall clock moves backward", async () => {
    const now = Date.now();
    const rolledBackNow = now - 3_600_000;
    const sessionKey = "agent:main:cron:job1:run:clock-rollback";

    await expect(
      sweepCronRunSessions({ sessionStorePath: storePath, nowMs: now, log }),
    ).resolves.toEqual({ swept: true, pruned: 0 });

    await seedSessionEntries(storePath, {
      [sessionKey]: {
        sessionId: "clock-rollback",
        updatedAt: rolledBackNow - 25 * 3_600_000,
      },
    });

    await expect(
      sweepCronRunSessions({ sessionStorePath: storePath, nowMs: rolledBackNow, log }),
    ).resolves.toEqual({ swept: true, pruned: 1 });
    expect(readSessionEntries(storePath)[sessionKey]).toBeUndefined();
    await expect(
      sweepCronRunSessions({
        sessionStorePath: storePath,
        nowMs: rolledBackNow + 1_000,
        log,
      }),
    ).resolves.toEqual({ swept: false, pruned: 0 });
  });

  it("shares one throttle for canonical agent and session-store aliases", async () => {
    const now = Date.now();

    expect(
      await sweepCronRunSessionsImpl({
        agentId: "main",
        defaultAgentId: "main",
        sessionStorePath: storePath,
        nowMs: now,
        log,
      }),
    ).toEqual({ swept: true, pruned: 0 });

    expect(
      await sweepCronRunSessionsImpl({
        agentId: "MAIN",
        defaultAgentId: "main",
        sessionStorePath: `${tmpDir}${path.sep}.${path.sep}sessions.json`,
        nowMs: now + 1_000,
        log,
      }),
    ).toEqual({ swept: false, pruned: 0 });
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
    const listSpy = vi.spyOn(sessionAccessor, "listSessionEntriesCore").mockImplementation(() => {
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

  it("does not build the pending-media snapshot without an expired continuation", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:job1:run:recent-1": {
        sessionId: "recent-1",
        updatedAt: now - 1 * 3_600_000, // 1h ago — not expired
        cronRunContinuation: { lifecycleRevision: "revision-1", phase: "ready" },
      },
      "agent:main:cron:job1:run:expired": {
        sessionId: "expired",
        updatedAt: now - 25 * 3_600_000,
      },
      "agent:main:telegram:dm:123": {
        sessionId: "regular-dm",
        updatedAt: now - 50 * 3_600_000, // old, but not cron run
      },
    };
    await seedSessionEntries(storePath, store);
    taskStatusMocks.buildPendingSet.mockClear();

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
    expect(taskStatusMocks.buildPendingSet).not.toHaveBeenCalled();
  });

  it("builds one pending-media snapshot for multiple expired continuations", async () => {
    const now = Date.now();
    const keptKey = "agent:main:cron:job1:run:kept";
    const prunedKey = "agent:main:cron:job1:run:pruned";
    const continuation = { lifecycleRevision: "revision-1", phase: "ready" } as const;
    await seedSessionEntries(storePath, {
      [keptKey]: {
        sessionId: "kept",
        updatedAt: now - 25 * 3_600_000,
        cronRunContinuation: continuation,
      },
      [prunedKey]: {
        sessionId: "pruned",
        updatedAt: now - 25 * 3_600_000,
        cronRunContinuation: continuation,
      },
    });
    taskStatusMocks.buildPendingSet.mockReturnValue(new Set([keptKey]));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
    expect(taskStatusMocks.buildPendingSet).toHaveBeenCalledOnce();
    expect(Object.keys(readSessionEntries(storePath))).toEqual([keptKey]);
  });
});
