import { describe, expect, it, vi } from "vitest";
import {
  clearCommandLane,
  enqueueCommandInLane,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { CronService } from "./service.js";
import { createDeferred, setupCronServiceSuite } from "./service.test-harness.js";
import type { CronEvent, CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-one-shot-schedule-ownership-",
  baseTimeIso: "2026-07-27T12:00:00.000Z",
});

type IsolatedOutcome =
  | { status: "ok"; summary: string }
  | { status: "error"; error: string }
  | { status: "skipped"; error: string };

function createCron(params: {
  storePath: string;
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"];
  onEvent?: (event: CronEvent) => void;
}) {
  return new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: params.runIsolatedAgentJob,
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
}

async function addOneShot(params: {
  cron: CronService;
  name: string;
  atMs: number;
  deleteAfterRun?: boolean;
}) {
  return await params.cron.add({
    name: params.name,
    enabled: true,
    ...(params.deleteAfterRun === undefined ? {} : { deleteAfterRun: params.deleteAfterRun }),
    schedule: { kind: "at", at: new Date(params.atMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "verify one-shot schedule ownership" },
    delivery: { mode: "none" },
  });
}

async function expectFutureOneShot(params: {
  cron: CronService;
  storePath: string;
  jobId: string;
  atMs: number;
  status: IsolatedOutcome["status"];
}) {
  const expected = {
    id: params.jobId,
    enabled: true,
    schedule: { kind: "at", at: new Date(params.atMs).toISOString() },
    state: {
      lastRunStatus: params.status,
      lastStatus: params.status,
      nextRunAtMs: params.atMs,
    },
  };
  const listed = await params.cron.list({ includeDisabled: true });
  const listedJob = listed.find((job) => job.id === params.jobId);
  expect(listedJob).toMatchObject(expected);
  expect(listedJob?.state.runningAtMs).toBeUndefined();
  const durable = await loadCronStore(params.storePath);
  const durableJob = durable.jobs.find((job) => job.id === params.jobId);
  expect(durableJob).toMatchObject(expected);
  expect(durableJob?.state.runningAtMs).toBeUndefined();
}

describe("cron one-shot schedule ownership", () => {
  it.each([
    { label: "successful", outcome: { status: "ok", summary: "done" } },
    { label: "failed", outcome: { status: "error", error: "temporary provider failure" } },
    { label: "skipped", outcome: { status: "skipped", error: "temporarily unavailable" } },
  ] satisfies Array<{ label: string; outcome: IsolatedOutcome }>)(
    "keeps the future scheduled fire after a $label manual run",
    async ({ outcome }) => {
      const store = await makeStorePath();
      const events: CronEvent[] = [];
      const cron = createCron({
        storePath: store.storePath,
        runIsolatedAgentJob: vi.fn(async () => outcome),
        onEvent: (event) => events.push(event),
      });

      try {
        await cron.start();
        const atMs = Date.now() + 60 * 60_000;
        const job = await addOneShot({ cron, name: `manual ${outcome.status}`, atMs });

        await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

        await expectFutureOneShot({
          cron,
          storePath: store.storePath,
          jobId: job.id,
          atMs,
          status: outcome.status,
        });
        expect(events.some((event) => event.jobId === job.id && event.action === "removed")).toBe(
          false,
        );
      } finally {
        cron.stop();
      }
    },
  );

  it("keeps the future scheduled fire after a queued manual run", async () => {
    const store = await makeStorePath();
    const finished = createDeferred<void>();
    const events: CronEvent[] = [];
    const cron = createCron({
      storePath: store.storePath,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
      onEvent: (event) => {
        events.push(event);
        if (event.action === "finished") {
          finished.resolve();
        }
      },
    });

    try {
      await cron.start();
      const atMs = Date.now() + 60 * 60_000;
      const job = await addOneShot({ cron, name: "queued manual one-shot", atMs });

      await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
        ok: true,
        enqueued: true,
      });
      await finished.promise;
      await cron.status();

      await expectFutureOneShot({
        cron,
        storePath: store.storePath,
        jobId: job.id,
        atMs,
        status: "ok",
      });
      expect(events.some((event) => event.jobId === job.id && event.action === "removed")).toBe(
        false,
      );
    } finally {
      cron.stop();
    }
  });

  it("preserves a manual run accepted before its scheduled fire but admitted afterward", async () => {
    const store = await makeStorePath();
    const finished = createDeferred<void>();
    const blockerStarted = createDeferred<void>();
    const releaseBlocker = createDeferred<void>();
    const cron = createCron({
      storePath: store.storePath,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
      onEvent: (event) => {
        if (event.action === "finished") {
          finished.resolve();
        }
      },
    });

    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);
    const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
    });

    try {
      await blockerStarted.promise;
      await cron.start();
      cron.pauseScheduling();
      const atMs = Date.now() + 1_000;
      const job = await addOneShot({ cron, name: "manual queued across deadline", atMs });

      await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
        ok: true,
        enqueued: true,
      });
      vi.setSystemTime(new Date(atMs + 1));
      releaseBlocker.resolve();
      await blocker;
      await finished.promise;
      await cron.status();

      await expectFutureOneShot({
        cron,
        storePath: store.storePath,
        jobId: job.id,
        atMs,
        status: "ok",
      });
    } finally {
      releaseBlocker.resolve();
      await blocker;
      cron.stop();
      clearCommandLane(CommandLane.Cron);
    }
  });

  it("consumes a manually verified one-shot only when its scheduled occurrence fires", async () => {
    const store = await makeStorePath();
    const removed = createDeferred<void>();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
    }));
    const cron = createCron({
      storePath: store.storePath,
      runIsolatedAgentJob,
      onEvent: (event) => {
        if (event.action === "removed") {
          removed.resolve();
        }
      },
    });

    try {
      await cron.start();
      const atMs = Date.now() + 1_000;
      const job = await addOneShot({ cron, name: "manual then scheduled one-shot", atMs });

      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      await expectFutureOneShot({
        cron,
        storePath: store.storePath,
        jobId: job.id,
        atMs,
        status: "ok",
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await removed.promise;
      await cron.status();

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
      expect(
        (await cron.list({ includeDisabled: true })).find((entry) => entry.id === job.id),
      ).toBe(undefined);
      expect((await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id)).toBe(
        undefined,
      );
    } finally {
      cron.stop();
    }
  });

  it("preserves every scheduled one-shot in a concurrent queued manual batch", async () => {
    const store = await makeStorePath();
    const completions = new Map<string, ReturnType<typeof createDeferred<void>>>();
    const cron = createCron({
      storePath: store.storePath,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
      onEvent: (event) => {
        if (event.action === "finished") {
          completions.get(event.jobId)?.resolve();
        }
      },
    });

    try {
      await cron.start();
      const atMs = Date.now() + 60 * 60_000;
      const jobs = [];
      for (let index = 0; index < 24; index += 1) {
        const job = await addOneShot({ cron, name: `queued one-shot ${index}`, atMs });
        completions.set(job.id, createDeferred<void>());
        jobs.push(job);
      }

      const acknowledgements = await Promise.all(
        jobs.map(async (job) => await cron.enqueueRun(job.id, "force")),
      );
      expect(acknowledgements).toHaveLength(jobs.length);
      for (const acknowledgement of acknowledgements) {
        expect(acknowledgement).toMatchObject({ ok: true, enqueued: true });
      }
      await Promise.all([...completions.values()].map(async (completion) => completion.promise));
      await cron.status();

      const listed = await cron.list({ includeDisabled: true });
      const durable = await loadCronStore(store.storePath);
      expect(listed).toHaveLength(jobs.length);
      expect(durable.jobs).toHaveLength(jobs.length);
      for (const job of jobs) {
        for (const stored of [listed, durable.jobs]) {
          expect(stored.find((entry) => entry.id === job.id)).toMatchObject({
            id: job.id,
            enabled: true,
            state: { lastRunStatus: "ok", nextRunAtMs: atMs },
          });
        }
      }
    } finally {
      cron.stop();
    }
  });
});
