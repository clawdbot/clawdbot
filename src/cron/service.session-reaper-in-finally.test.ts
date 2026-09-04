// Session reaper finally tests cover cleanup after cron service failures.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  createNoopLogger,
  createCronStoreHarness,
  withCronServiceStateForTest,
} from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { onTimer } from "./service/timer.test-support.js";
import { resetReaperThrottle } from "./session-reaper.test-support.js";
import * as cronStoreModule from "./store.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-reaper-finally-",
});

function createDueIsolatedJob(params: { id: string; nowMs: number }): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: params.nowMs },
  };
}

async function seedReaperSessions(storePath: string, now: number) {
  const fresh = {
    sessionKey: "agent:main:cron:failing-job:run:fresh",
    entry: { sessionId: "fresh-run", updatedAt: now, delivery: { kind: "none" as const } },
  };
  for (const { sessionKey, entry } of [
    {
      sessionKey: "agent:main:cron:failing-job:run:stale",
      entry: { sessionId: "stale-run", updatedAt: now - 25 * 3_600_000 },
    },
    fresh,
  ]) {
    await replaceSessionEntry({ agentId: "main", storePath, sessionKey }, entry);
  }
  expect(listSessionEntriesCore({ agentId: "main", storePath })).toHaveLength(2);
  return fresh;
}

describe("CronService - session reaper runs in finally block (#31946)", () => {
  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
    resetReaperThrottle();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs explicit-agent jobs when no default reaper agent exists", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T10:00:00.000Z");
    const job = {
      ...createDueIsolatedJob({ id: "explicit-agent", nowMs: now }),
      agentId: "worker",
    };
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });
    const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");
    await replaceSessionEntry(
      {
        agentId: "worker",
        storePath: sessionStorePath,
        sessionKey: "agent:worker:cron:explicit-agent:run:expired",
      },
      { sessionId: "worker-expired", updatedAt: now - 25 * 3_600_000 },
    );
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "done" });
    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      resolveDefaultAgentId: () => undefined,
      resolveSessionStoreAgentIds: () => ["worker"],
      sessionStorePath,
    });
    state.store = { version: 1, jobs: [job] };

    await withCronServiceStateForTest(state, async () => {
      await expect(onTimer(state)).resolves.toBeUndefined();
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(
        listSessionEntriesCore({ agentId: "worker", storePath: sessionStorePath }),
      ).toStrictEqual([]);
      expect(state.running).toBe(false);
      expect(state.timer).not.toBeNull();
    });
  });

  it.each([
    { name: "agent discovery", failedOperation: "agents" },
    { name: "session-store resolution", failedOperation: "store" },
  ] as const)(
    "keeps the scheduler running after reaper $name fails",
    async ({ failedOperation }) => {
      const store = await makeStorePath();
      const now = Date.parse("2026-02-10T10:00:00.000Z");
      const job = createDueIsolatedJob({ id: `recover-reaper-${failedOperation}`, nowMs: now });
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });
      const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: "ok", summary: "done" });
      const state = createCronServiceState({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
        defaultAgentId: "main",
        resolveSessionStoreAgentIds: () => {
          if (failedOperation === "agents") {
            throw new Error("agent discovery temporarily unavailable");
          }
          return ["main"];
        },
        resolveSessionStorePath: () => {
          if (failedOperation === "store") {
            throw new Error("session store temporarily unavailable");
          }
          return path.join(path.dirname(store.storePath), "sessions", "sessions.json");
        },
      });

      await withCronServiceStateForTest(state, async () => {
        await expect(onTimer(state)).resolves.toBeUndefined();
        expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
        expect(state.running).toBe(false);
        expect(state.timer).not.toBeNull();
        expect(noopLogger.warn).toHaveBeenCalled();
      });
    },
  );

  it("prunes expired run sessions after a job execution error", async () => {
    const store = await makeStorePath();
    const now = Date.now();

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [createDueIsolatedJob({ id: "failing-job", nowMs: now })],
    });

    const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");
    const fresh = await seedReaperSessions(sessionStorePath, now);
    const runIsolatedAgentJob = vi.fn().mockRejectedValue(new Error("gateway down"));

    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      defaultAgentId: "main",
      sessionStorePath,
    });

    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);

      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect((await loadCronStore(store.storePath)).jobs[0]?.state).toMatchObject({
        lastRunStatus: "error",
        lastError: "gateway down",
      });
      expect(listSessionEntriesCore({ agentId: "main", storePath: sessionStorePath })).toEqual([
        fresh,
      ]);
      expect(state.running).toBe(false);

      if (state.timer === null) {
        throw new Error("expected timer to be re-armed");
      }
    });
  });

  it("prunes expired run sessions while propagating a cron store load failure", async () => {
    const store = await makeStorePath();
    const now = Date.now();
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [createDueIsolatedJob({ id: "failing-job", nowMs: now })],
    });
    const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");
    const fresh = await seedReaperSessions(sessionStorePath, now);
    const runIsolatedAgentJob = vi.fn();
    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      defaultAgentId: "main",
      sessionStorePath,
    });

    await withCronServiceStateForTest(state, async () => {
      await ensureLoaded(state, { skipRecompute: true });
      const failure = new Error("cron store unavailable");
      const loadSpy = vi
        .spyOn(cronStoreModule, "loadCronJobsStoreWithConfigJobs")
        .mockRejectedValueOnce(failure);
      try {
        await expect(onTimer(state)).rejects.toBe(failure);
        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(listSessionEntriesCore({ agentId: "main", storePath: sessionStorePath })).toEqual([
          fresh,
        ]);
        expect(state.running).toBe(false);
        expect(state.timer).not.toBeNull();
      } finally {
        loadSpy.mockRestore();
      }
    });
  });

  it("keeps same-path session reaper targets distinct by agent", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T10:00:00.000Z");

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        createDueIsolatedJob({ id: "default-job", nowMs: now }),
        {
          ...createDueIsolatedJob({ id: "worker-job", nowMs: now }),
          agentId: undefined,
          enabled: false,
          sessionKey: "agent:worker:main",
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "worker task" },
        },
      ],
    });

    const resolvedAgentIds: string[] = [];
    const sharedStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");
    await replaceSessionEntry(
      {
        agentId: "main",
        storePath: sharedStorePath,
        sessionKey: "agent:main:cron:default-job:run:expired",
      },
      { sessionId: "main-expired", updatedAt: now - 25 * 3_600_000 },
    );
    await replaceSessionEntry(
      {
        agentId: "worker",
        storePath: sharedStorePath,
        sessionKey: "agent:worker:cron:worker-job:run:expired",
      },
      { sessionId: "worker-expired", updatedAt: now - 25 * 3_600_000 },
    );
    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "done" }),
      defaultAgentId: "main",
      resolveSessionStorePath: (agentId) => {
        if (!agentId) {
          throw new Error("expected prepared agent id");
        }
        resolvedAgentIds.push(agentId);
        return sharedStorePath;
      },
    });

    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);

      expect([...new Set(resolvedAgentIds)].toSorted()).toEqual(["main", "worker"]);
      expect(listSessionEntriesCore({ agentId: "main", storePath: sharedStorePath })).toStrictEqual(
        [],
      );
      expect(
        listSessionEntriesCore({ agentId: "worker", storePath: sharedStorePath }),
      ).toStrictEqual([]);
      expect(state.running).toBe(false);
    });
  });

  it("resolves the current default agent for the session reaper", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T10:00:00.000Z");
    const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");
    await saveCronStore(store.storePath, { version: 1, jobs: [] });
    await replaceSessionEntry(
      {
        agentId: "ops",
        storePath: sessionStorePath,
        sessionKey: "agent:ops:cron:default:run:expired",
      },
      { sessionId: "ops-expired", updatedAt: now - 25 * 3_600_000 },
    );

    const resolvedAgentIds: string[] = [];
    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      resolveDefaultAgentId: () => "ops",
      resolveSessionStorePath: (agentId) => {
        if (!agentId) {
          throw new Error("expected prepared agent id");
        }
        resolvedAgentIds.push(agentId);
        return sessionStorePath;
      },
    });

    await withCronServiceStateForTest(state, async () => {
      await expect(onTimer(state)).resolves.toBeUndefined();

      expect([...new Set(resolvedAgentIds)]).toEqual(["ops"]);
      expect(listSessionEntriesCore({ agentId: "ops", storePath: sessionStorePath })).toStrictEqual(
        [],
      );
    });
  });

  it("sweeps every job owner in one static session store", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T10:00:00.000Z");
    const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [createDueIsolatedJob({ id: "default-job", nowMs: now })],
    });
    for (const agentId of ["main", "worker"]) {
      await replaceSessionEntry(
        {
          agentId,
          storePath: sessionStorePath,
          sessionKey: `agent:${agentId}:cron:expired:run:stale`,
        },
        { sessionId: `${agentId}-expired`, updatedAt: now - 25 * 3_600_000 },
      );
    }
    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "done" }),
      defaultAgentId: "main",
      resolveSessionStoreAgentIds: () => ["main", "worker"],
      sessionStorePath,
    });

    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);

      expect(
        listSessionEntriesCore({ agentId: "main", storePath: sessionStorePath }),
      ).toStrictEqual([]);
      expect(
        listSessionEntriesCore({ agentId: "worker", storePath: sessionStorePath }),
      ).toStrictEqual([]);
    });
  });

  it.each([
    { name: "deleted persisted owner", includeStaleJob: false },
    { name: "blocked-delete owner with unfinished job cleanup", includeStaleJob: true },
  ])("skips an unavailable $name without hiding a live owner", async ({ includeStaleJob }) => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T10:00:00.000Z");
    const liveAgentId = "live";
    const unavailableAgentId = includeStaleJob ? "blocked" : "deleted";
    const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");
    const jobs = includeStaleJob
      ? [
          {
            ...createDueIsolatedJob({ id: "unfinished-cleanup", nowMs: now }),
            agentId: unavailableAgentId,
            enabled: false,
          },
        ]
      : [];
    await saveCronStore(store.storePath, { version: 1, jobs });
    await replaceSessionEntry(
      {
        agentId: liveAgentId,
        storePath: sessionStorePath,
        sessionKey: `agent:${liveAgentId}:cron:old-job:run:expired`,
      },
      { sessionId: "live-expired", updatedAt: now - 25 * 3_600_000 },
    );
    const resolveSessionStorePath = vi.fn((agentId?: string) => {
      if (agentId === unavailableAgentId) {
        throw new Error(
          `OpenClaw agent database is unavailable while agent ${unavailableAgentId} is deleted.`,
        );
      }
      return sessionStorePath;
    });
    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      resolveDefaultAgentId: () => undefined,
      resolveSessionStoreAgentIds: () => [liveAgentId, unavailableAgentId],
      isAgentAvailable: (agentId) => agentId === liveAgentId,
      resolveSessionStorePath,
    });

    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);
      await onTimer(state);

      expect(resolveSessionStorePath.mock.calls).toEqual([[liveAgentId], [liveAgentId]]);
      expect(listSessionEntriesCore({ agentId: liveAgentId, storePath: sessionStorePath })).toEqual(
        [],
      );
      expect(noopLogger.warn).not.toHaveBeenCalled();
      expect(
        noopLogger.debug.mock.calls.filter(
          ([, message]) => message === "cron-reaper: skipped unavailable agent",
        ),
      ).toEqual([[{ agentId: unavailableAgentId }, "cron-reaper: skipped unavailable agent"]]);
    });
  });

  it("sweeps a persisted owner after it leaves the roster and cron store", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T10:00:00.000Z");
    const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");
    await saveCronStore(store.storePath, { version: 1, jobs: [] });
    await replaceSessionEntry(
      {
        agentId: "retired",
        storePath: sessionStorePath,
        sessionKey: "agent:retired:cron:old-job:run:expired",
      },
      { sessionId: "retired-expired", updatedAt: now - 25 * 3_600_000 },
    );

    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      defaultAgentId: "ops",
      resolveSessionStoreAgentIds: () => ["retired"],
      sessionStorePath,
    });

    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);

      expect(listSessionEntriesCore({ agentId: "retired", storePath: sessionStorePath })).toEqual(
        [],
      );
    });
  });

  it("prunes expired cron-run sessions while ignoring malformed legacy cron files", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T10:00:00.000Z");
    const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");

    // Runtime reads SQLite only; malformed legacy JSON is migrated by doctor,
    // not imported or thrown from the timer path.
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, "{invalid-json", "utf-8");

    // Seed an expired cron-run session entry that should be pruned by the reaper.
    await replaceSessionEntry(
      { storePath: sessionStorePath, sessionKey: "agent:agent-default:cron:failing-job:run:stale" },
      {
        sessionId: "session-stale",
        updatedAt: now - 3 * 24 * 3_600_000,
      },
    );

    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      defaultAgentId: "agent-default",
      sessionStorePath,
    });

    await withCronServiceStateForTest(state, async () => {
      await expect(onTimer(state)).resolves.toBeUndefined();

      expect(
        listSessionEntriesCore({ agentId: "agent-default", storePath: sessionStorePath }),
      ).toStrictEqual([]);
      expect(state.running).toBe(false);
    });
  });
});
