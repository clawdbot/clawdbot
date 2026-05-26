import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { saveCronStore } from "../store.js";
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

async function writeJobStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        version: 1,
        jobs,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function createStoreTestState(storePath: string) {
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
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

function expectWarnedJob(params: { storePath: string; jobId: string; message: string }) {
  const warnCalls = logger.warn.mock.calls as unknown as Array<
    [{ storePath?: string; jobId?: string }, string]
  >;
  const warning = warnCalls.find(
    ([metadata, message]) => metadata.jobId === params.jobId && message.includes(params.message),
  );
  expect(warning?.[0].storePath).toBe(params.storePath);
  expect(warning?.[0].jobId).toBe(params.jobId);
  expect(warning?.[1]).toContain(params.message);
}

describe("cron service store seam coverage", () => {
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
    expect(job?.state.nextRunAtMs).toBe(STORE_TEST_NOW);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    const persistedJob = persisted.jobs[0];
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

    const firstMtime = state.storeFileMtimeMs;
    expect(typeof firstMtime).toBe("number");

    await persist(state);
    expect(typeof state.storeFileMtimeMs).toBe("number");
    expect((state.storeFileMtimeMs ?? 0) >= (firstMtime ?? 0)).toBe(true);
  });

  it("preserves unsupported payload-kind rows across full persistence without loading them", async () => {
    const { storePath } = await makeStorePath();

    await writeJobStore(storePath, [
      {
        id: "valid-job",
        name: "valid job",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        updatedAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      },
      {
        id: "legacy-command",
        name: "legacy command",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        updatedAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "command", command: "echo daily" },
        state: { lastRunAtMs: STORE_TEST_NOW - 3_600_000 },
      },
      {
        id: "legacy-agentmessage",
        name: "legacy agentmessage",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentmessage", message: "summarize" },
        metadata: { preserve: { nested: true } },
      },
    ]);

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });

    expect(state.store?.jobs.map((job) => job.id)).toEqual(["valid-job"]);
    expect(() => findJobOrThrow(state, "legacy-command")).toThrow(/unknown cron job id/);
    expect(() => findJobOrThrow(state, "legacy-agentmessage")).toThrow(/unknown cron job id/);

    const valid = findJobOrThrow(state, "valid-job");
    valid.name = "valid job renamed";
    await persist(state);

    const config = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(config.jobs.map((job) => job.id)).toEqual([
      "valid-job",
      "legacy-command",
      "legacy-agentmessage",
    ]);
    expect(config.jobs[0]?.name).toBe("valid job renamed");
    expect(config.jobs[1]).toMatchObject({
      id: "legacy-command",
      payload: { kind: "command", command: "echo daily" },
      state: { lastRunAtMs: STORE_TEST_NOW - 3_600_000 },
    });
    expect(config.jobs[2]).toMatchObject({
      id: "legacy-agentmessage",
      payload: { kind: "agentmessage", message: "summarize" },
      metadata: { preserve: { nested: true } },
    });
    expect(config.jobs[2]).not.toHaveProperty("state");
    expect(config.jobs[2]).not.toHaveProperty("updatedAtMs");

    const stateFile = JSON.parse(
      await fs.readFile(storePath.replace(/\.json$/, "-state.json"), "utf8"),
    ) as { jobs: Record<string, unknown> };
    expect(Object.keys(stateFile.jobs)).toEqual(["valid-job"]);

    const invalidPayloadWarns = logger.warn.mock.calls.filter((call) => {
      const msg = typeof call[1] === "string" ? call[1] : "";
      return msg.includes("skipped invalid persisted job");
    });
    expect(invalidPayloadWarns.map((call) => (call[0] as { jobId?: string }).jobId)).toEqual([
      "legacy-command",
      "legacy-agentmessage",
    ]);
  });

  it("skips preserved unsupported rows that collide with supported jobs by canonical id", async () => {
    const { storePath } = await makeStorePath();

    await writeJobStore(storePath, [
      {
        id: "trimmed-collision",
        name: "supported trimmed collision",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        updatedAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      },
      {
        id: "  trimmed-collision  ",
        name: "stale unsupported padded id",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "command", command: "echo stale" },
      },
      {
        id: "legacy-jobid-collision",
        name: "supported legacy jobId collision",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        updatedAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "every", everyMs: 120_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "tick legacy" },
        state: {},
      },
      {
        jobId: "  legacy-jobid-collision  ",
        name: "stale unsupported legacy jobId",
        enabled: true,
        createdAtMs: STORE_TEST_NOW - 60_000,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentmessage", message: "summarize stale" },
      },
    ]);

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });

    expect(state.store?.jobs.map((job) => job.id)).toEqual([
      "trimmed-collision",
      "legacy-jobid-collision",
    ]);

    await persist(state);

    const config = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(config.jobs.map((job) => job.id)).toEqual([
      "trimmed-collision",
      "legacy-jobid-collision",
    ]);
    expect(config.jobs.map((job) => job.name)).toEqual([
      "supported trimmed collision",
      "supported legacy jobId collision",
    ]);
    expect(config.jobs.some((job) => job.jobId === "  legacy-jobid-collision  ")).toBe(false);
    expect(config.jobs.some((job) => job.name === "stale unsupported padded id")).toBe(false);
    expect(config.jobs.some((job) => job.name === "stale unsupported legacy jobId")).toBe(false);
  });

  it("normalizes jobId-only jobs in memory so scheduler lookups resolve by stable id", async () => {
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

    expectWarnedJob({ storePath, jobId: "repro-stable-id", message: "legacy jobId" });

    const job = findJobOrThrow(state, "repro-stable-id");
    expect(job.id).toBe("repro-stable-id");
    expect((job as { jobId?: unknown }).jobId).toBeUndefined();

    const raw = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(raw.jobs[0]?.jobId).toBe("repro-stable-id");
    expect(raw.jobs[0]?.id).toBeUndefined();
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

    const before = await fs.readFile(storePath, "utf8");
    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "disabled-string-job");
    expect(job.enabled).toBe(false);

    const after = await fs.readFile(storePath, "utf8");
    expect(after).toBe(before);
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

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(staleNextRunAtMs);

    await writeSingleJobStore(storePath, {
      id: "reload-cron-expr-job",
      name: "reload cron expr job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 30_000,
      schedule: { kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    const reloadedJob = findJobOrThrow(state, "reload-cron-expr-job");
    expect(reloadedJob.schedule).toEqual({ kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" });
    expect(reloadedJob.state.nextRunAtMs).toBeUndefined();
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

    await writeSingleJobStore(storePath, {
      id: "reload-cron-expr-job",
      name: "reload cron expr job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 30_000,
      schedule: { expr: "0 6 * * *", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(dueNextRunAtMs);
  });

  it("keeps a force-reloaded legacy string schedule for runtime repair handling", async () => {
    const { storePath } = await makeStorePath();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        updatedAtMs: STORE_TEST_NOW,
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
      schedule: "0 17 * * *",
    });

    await expect(ensureLoaded(state, { forceReload: true, skipRecompute: true })).resolves.toBe(
      undefined,
    );

    const job = findJobOrThrow(state, "reload-cron-expr-job");
    expect(job.schedule).toBe("0 17 * * *");
    expect(job.state.nextRunAtMs).toBeUndefined();
  });

  it("preserves nextRunAtMs after force reload when scheduling inputs are unchanged", async () => {
    const { storePath } = await makeStorePath();
    const originalNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({ state: { nextRunAtMs: originalNextRunAtMs } }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        updatedAtMs: STORE_TEST_NOW,
        state: { nextRunAtMs: originalNextRunAtMs + 60_000 },
      }),
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
    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        enabled: false,
        updatedAtMs: STORE_TEST_NOW,
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
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
    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        updatedAtMs: STORE_TEST_NOW,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
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
    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        updatedAtMs: STORE_TEST_NOW,
        schedule: { kind: "at", at: "2026-03-23T14:00:00.000Z" },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBeUndefined();
  });
});
