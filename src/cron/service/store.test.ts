// Cron service store tests cover persisted service state loading and writes.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow } from "./jobs.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-store-seam",
});

const STORE_TEST_NOW = Date.parse("2026-03-23T12:00:00.000Z");

async function writeSingleJobStore(storePath: string, job: Record<string, unknown>) {
  await writeJobStore(storePath, [job]);
}

async function writeJobStore(storePath: string, jobs: unknown[]) {
  await saveCronStore(storePath, {
    version: 1,
    jobs: jobs as CronJob[],
  });
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function createStoreTestState(storePath: string, onEvent = vi.fn()) {
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent,
  });
}

function createReloadCronJob(params?: Partial<CronJob>): CronJob {
  return {
    id: "reload-cron-expr-job",
    name: "reload cron expr job",
    enabled: true,
    createdAtMs: STORE_TEST_NOW - 60_000,
    updatedAtMs: STORE_TEST_NOW - 60_000,
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
    ...params,
  };
}
describe("cron service store seam coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads stored jobs, recomputes next runs, and does not rewrite the store on load", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "modern-job",
      name: "modern job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      state: {},
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = state.store?.jobs[0];
    if (!job) {
      throw new Error("expected loaded cron job");
    }
    expect(job.sessionTarget).toBe("isolated");
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("ping");
    }
    expect(job.delivery?.mode).toBe("announce");
    expect(job.delivery?.channel).toBe("telegram");
    expect(job.delivery?.to).toBe("123");
    expect(job?.state.nextRunAtMs).toBe(STORE_TEST_NOW + 60_000);

    const persistedJob = (await loadCronStore(storePath)).jobs[0];
    const persistedPayload = persistedJob?.payload as
      | { kind?: string; message?: string }
      | undefined;
    expect(persistedPayload?.kind).toBe("agentTurn");
    expect(persistedPayload?.message).toBe("ping");
    const persistedDelivery = persistedJob?.delivery as
      | { mode?: string; channel?: string; to?: string }
      | undefined;
    expect(persistedDelivery?.mode).toBe("announce");
    expect(persistedDelivery?.channel).toBe("telegram");
    expect(persistedDelivery?.to).toBe("123");
    await expectPathMissing(storePath);

    await persist(state);
  });

  it("publishes durable wake changes only after save and exactly once after retry", async () => {
    const { storePath } = await makeStorePath();
    const initialNextRunAtMs = STORE_TEST_NOW + 60_000;
    const changedNextRunAtMs = STORE_TEST_NOW + 120_000;
    await writeSingleJobStore(
      storePath,
      createReloadCronJob({
        id: "durable-wake-job",
        state: { nextRunAtMs: initialNextRunAtMs },
      }),
    );
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state, { skipRecompute: true });
    const job = findJobOrThrow(state, "durable-wake-job");
    job.state.nextRunAtMs = changedNextRunAtMs;

    vi.spyOn(cronStoreModule, "saveCronJobsStore").mockRejectedValueOnce(new Error("disk full"));
    await expect(persist(state)).rejects.toThrow("disk full");

    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBe(initialNextRunAtMs);

    await persist(state);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: changedNextRunAtMs,
      }),
    );
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBe(changedNextRunAtMs);

    await persist(state);
    expect(onEvent).toHaveBeenCalledTimes(1);

    job.state.nextRunAtMs = undefined;
    await persist(state);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: undefined,
      }),
    );
    expect(state.durableNextRunAtMsByJobId.has(job.id)).toBe(true);
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBeUndefined();
  });

  it("advances durable wake state while suppressing duplicate scheduled delivery", async () => {
    const { storePath } = await makeStorePath();
    const initialNextRunAtMs = STORE_TEST_NOW + 60_000;
    const suppressedNextRunAtMs = STORE_TEST_NOW + 120_000;
    const publishedNextRunAtMs = STORE_TEST_NOW + 180_000;
    await writeSingleJobStore(
      storePath,
      createReloadCronJob({
        id: "suppressed-scheduled-job",
        state: { nextRunAtMs: initialNextRunAtMs },
      }),
    );
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state, { skipRecompute: true });
    const job = findJobOrThrow(state, "suppressed-scheduled-job");

    job.state.nextRunAtMs = suppressedNextRunAtMs;
    await persist(state, { suppressScheduledJobId: job.id });

    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBe(suppressedNextRunAtMs);

    job.state.nextRunAtMs = publishedNextRunAtMs;
    await persist(state);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: publishedNextRunAtMs,
      }),
    );
  });

  it("does not publish scheduled events for full-save topology changes", async () => {
    const { storePath } = await makeStorePath();
    const firstNextRunAtMs = STORE_TEST_NOW + 60_000;
    const readdedNextRunAtMs = STORE_TEST_NOW + 180_000;
    await writeSingleJobStore(
      storePath,
      createReloadCronJob({
        id: "existing-job",
        state: { nextRunAtMs: firstNextRunAtMs },
      }),
    );
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state, { skipRecompute: true });
    if (!state.store) {
      throw new Error("expected loaded cron store");
    }

    const topologyJob = createReloadCronJob({
      id: "topology-job",
      state: { nextRunAtMs: STORE_TEST_NOW + 120_000 },
    });
    state.store.jobs.push(topologyJob);
    await persist(state);
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.has(topologyJob.id)).toBe(true);

    state.store.jobs = state.store.jobs.filter((job) => job.id !== topologyJob.id);
    await persist(state);
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.has(topologyJob.id)).toBe(false);

    const readdedJob = createReloadCronJob({
      id: topologyJob.id,
      state: { nextRunAtMs: readdedNextRunAtMs },
    });
    state.store.jobs.push(readdedJob);
    await persist(state);
    expect(onEvent).not.toHaveBeenCalled();

    readdedJob.state.nextRunAtMs = readdedNextRunAtMs + 60_000;
    await persist(state);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: topologyJob.id,
        nextRunAtMs: readdedNextRunAtMs + 60_000,
      }),
    );
  });

  it("keeps state-only wake publication aligned with persisted topology", async () => {
    const { storePath } = await makeStorePath();
    const initialNextRunAtMs = STORE_TEST_NOW + 60_000;
    const changedNextRunAtMs = STORE_TEST_NOW + 180_000;
    await writeSingleJobStore(
      storePath,
      createReloadCronJob({
        id: "durable-state-only-job",
        state: { nextRunAtMs: initialNextRunAtMs },
      }),
    );
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state, { skipRecompute: true });
    if (!state.store) {
      throw new Error("expected loaded cron store");
    }

    state.store.jobs = [
      createReloadCronJob({
        id: "new-state-only-job",
        state: { nextRunAtMs: STORE_TEST_NOW + 120_000 },
      }),
    ];
    await persist(state, { stateOnly: true });

    expect(onEvent).not.toHaveBeenCalled();
    expect([...state.durableNextRunAtMsByJobId.keys()]).toEqual(["durable-state-only-job"]);
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([
      "durable-state-only-job",
    ]);

    state.store.jobs = [
      createReloadCronJob({
        id: "durable-state-only-job",
        state: { nextRunAtMs: changedNextRunAtMs },
      }),
    ];
    await persist(state, { stateOnly: true });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: "durable-state-only-job",
        nextRunAtMs: changedNextRunAtMs,
      }),
    );
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(changedNextRunAtMs);
  });

  it("does not advance durable wake state when quarantine prevents a save", async () => {
    const { storePath } = await makeStorePath();
    const initialNextRunAtMs = STORE_TEST_NOW + 60_000;
    const changedNextRunAtMs = STORE_TEST_NOW + 120_000;
    await writeSingleJobStore(
      storePath,
      createReloadCronJob({
        id: "quarantine-retry-job",
        state: { nextRunAtMs: initialNextRunAtMs },
      }),
    );
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state, { skipRecompute: true });
    const job = findJobOrThrow(state, "quarantine-retry-job");
    job.state.nextRunAtMs = changedNextRunAtMs;
    state.pendingQuarantineConfigJobs = [
      { sourceIndex: 0, reason: "invalid-schedule", job: { id: "quarantined-job" } },
    ];
    vi.spyOn(cronStoreModule, "saveCronQuarantineFile").mockRejectedValueOnce(
      new Error("quarantine unavailable"),
    );
    const saveStore = vi.spyOn(cronStoreModule, "saveCronJobsStore");

    await persist(state, { stateOnly: true });

    expect(saveStore).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBe(initialNextRunAtMs);
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(initialNextRunAtMs);

    await persist(state, { stateOnly: true });

    expect(saveStore).toHaveBeenCalledWith(storePath, state.store, undefined);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: changedNextRunAtMs,
      }),
    );
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(changedNextRunAtMs);
  });

  it("loads normalized jobId-only jobs from SQLite so scheduler lookups resolve by stable id", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      jobId: "repro-stable-id",
      name: "handed",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "repro-stable-id");
    expect(job.id).toBe("repro-stable-id");
    expect((job as { jobId?: unknown }).jobId).toBeUndefined();
    await expectPathMissing(`${storePath}.migrated`);
  });

  it("preserves disabled jobs when persisted booleans roundtrip through string values", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "disabled-string-job",
      name: "disabled string job",
      enabled: "false",
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "disabled-string-job");
    expect(job.enabled).toBe(false);
    await expectPathMissing(`${storePath}.migrated`);
  });

  it("loads persisted jobs with opaque custom session ids containing separators", async () => {
    const { storePath } = await makeStorePath();
    const sessionTarget = "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";

    await writeSingleJobStore(storePath, {
      id: "opaque-session-target-job",
      name: "opaque session target job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget,
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping" },
      state: {},
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state, { skipRecompute: true });

    const job = findJobOrThrow(state, "opaque-session-target-job");
    expect(job.sessionTarget).toBe(sessionTarget);
    const warnCalls = logger.warn.mock.calls as unknown as Array<
      [{ storePath?: string; jobId?: string }, string]
    >;
    expect(
      warnCalls.some(
        ([metadata, message]) =>
          metadata.jobId === "opaque-session-target-job" &&
          message.includes("invalid persisted sessionTarget"),
      ),
    ).toBe(false);
  });

  it("clears stale nextRunAtMs after force reload when cron schedule expression changes", async () => {
    const { storePath } = await makeStorePath();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state, { skipRecompute: true });
    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(staleNextRunAtMs);

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          updatedAtMs: STORE_TEST_NOW - 30_000,
          schedule: { kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" },
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    const reloadedJob = findJobOrThrow(state, "reload-cron-expr-job");
    expect(reloadedJob.schedule).toEqual({ kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" });
    expect(reloadedJob.state.nextRunAtMs).toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.get(reloadedJob.id)).toBe(staleNextRunAtMs);

    await persist(state);

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: reloadedJob.id,
        nextRunAtMs: undefined,
      }),
    );
  });

  it("clears a paced slot and its provenance after force reload changes pacing", async () => {
    const { storePath } = await makeStorePath();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          pacing: { max: "4h" },
          state: {
            nextRunAtMs: staleNextRunAtMs,
            pacedNextRunAtMs: staleNextRunAtMs,
          },
        }),
      ],
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          pacing: { max: "2h" },
          updatedAtMs: STORE_TEST_NOW,
          state: {
            nextRunAtMs: staleNextRunAtMs,
            pacedNextRunAtMs: staleNextRunAtMs,
          },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    const reloadedJob = findJobOrThrow(state, "reload-cron-expr-job");
    expect(reloadedJob.state.nextRunAtMs).toBeUndefined();
    expect(reloadedJob.state.pacedNextRunAtMs).toBeUndefined();
  });

  it("preserves nextRunAtMs after force reload when cron schedule key order changes only", async () => {
    const { storePath } = await makeStorePath();
    const dueNextRunAtMs = STORE_TEST_NOW - 1_000;

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          state: { nextRunAtMs: dueNextRunAtMs },
        }),
      ],
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          updatedAtMs: STORE_TEST_NOW - 30_000,
          schedule: { expr: "0 6 * * *", kind: "cron", tz: "UTC" },
          state: { nextRunAtMs: dueNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(dueNextRunAtMs);
  });

  it("preserves nextRunAtMs after force reload when scheduling inputs are unchanged", async () => {
    const { storePath } = await makeStorePath();
    const originalNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({ state: { nextRunAtMs: originalNextRunAtMs } }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          updatedAtMs: STORE_TEST_NOW,
          state: { nextRunAtMs: originalNextRunAtMs + 60_000 },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(
      originalNextRunAtMs + 60_000,
    );
  });

  it("clears stale nextRunAtMs after force reload when enabled state changes", async () => {
    const { storePath } = await makeStorePath();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        enabled: true,
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          enabled: false,
          updatedAtMs: STORE_TEST_NOW,
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBeUndefined();
  });

  it("clears stale nextRunAtMs after force reload when every schedule anchor changes", async () => {
    const { storePath } = await makeStorePath();
    const jobId = "reload-every-anchor-job";
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW - 60_000 },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          id: jobId,
          updatedAtMs: STORE_TEST_NOW,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW },
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBeUndefined();
  });

  it("clears stale nextRunAtMs after force reload when at schedule target changes", async () => {
    const { storePath } = await makeStorePath();
    const jobId = "reload-at-target-job";
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        schedule: { kind: "at", at: "2026-03-23T13:00:00.000Z" },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          id: jobId,
          updatedAtMs: STORE_TEST_NOW,
          schedule: { kind: "at", at: "2026-03-23T14:00:00.000Z" },
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBeUndefined();
  });
});
