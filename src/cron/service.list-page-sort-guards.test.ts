// Cron list pagination tests cover stable sorting and page boundary guards.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { locked } from "./service/locked.js";
import { list, listPage } from "./service/ops-read.js";
import type { CronJob } from "./types.js";

function createBaseJob(overrides?: Partial<CronJob>): CronJob {
  return {
    id: "job-1",
    name: "job",
    enabled: true,
    schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: { nextRunAtMs: Date.parse("2026-02-27T15:30:00.000Z") },
    createdAtMs: Date.parse("2026-02-27T15:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-27T15:05:00.000Z"),
    ...overrides,
  };
}

describe("cron listPage sort guards", () => {
  it("keeps malformed name fields sortable", async () => {
    const jobs = [
      createBaseJob({ id: "job-a", name: undefined as unknown as string }),
      createBaseJob({ id: "job-b", name: "beta" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { sortBy: "name", sortDir: "asc" });
    expect(page.jobs).toHaveLength(2);
  });

  it("keeps missing ids sortable during tie-breaks", async () => {
    const nextRunAtMs = Date.parse("2026-02-27T15:30:00.000Z");
    const jobs = [
      createBaseJob({
        id: undefined as unknown as string,
        name: "alpha",
        state: { nextRunAtMs },
      }),
      createBaseJob({
        id: undefined as unknown as string,
        name: "alpha",
        state: { nextRunAtMs },
      }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { sortBy: "nextRunAtMs", sortDir: "asc" });
    expect(page.jobs).toHaveLength(2);
  });

  it.each([
    { sortDir: "asc" as const, scheduledIds: ["earlier", "later"] },
    { sortDir: "desc" as const, scheduledIds: ["later", "earlier"] },
  ])(
    "keeps unscheduled jobs after the scheduled $sortDir page",
    async ({ sortDir, scheduledIds }) => {
      const jobs = [
        createBaseJob({ id: "paused-z", enabled: false, state: {} }),
        createBaseJob({ id: "later", state: { nextRunAtMs: 200 } }),
        createBaseJob({ id: "paused-a", enabled: false, state: {} }),
        createBaseJob({ id: "earlier", state: { nextRunAtMs: 100 } }),
      ];
      const state = createMockCronStateForJobs({ jobs });
      const options = {
        enabled: "all" as const,
        sortBy: "nextRunAtMs" as const,
        sortDir,
        limit: 2,
      };

      const firstPage = await listPage(state, { ...options, offset: 0 });
      const secondPage = await listPage(state, { ...options, offset: 2 });

      expect(firstPage.jobs.map((job) => job.id)).toEqual(scheduledIds);
      expect(firstPage.hasMore).toBe(true);
      expect(secondPage.jobs.map((job) => job.id)).toEqual(["paused-a", "paused-z"]);
      expect(secondPage.hasMore).toBe(false);
      expect(secondPage.snapshotRevision).toBe(firstPage.snapshotRevision);
    },
  );

  it("keeps unscheduled jobs after scheduled jobs in the unpaginated list", async () => {
    const jobs = [
      createBaseJob({ id: "paused-z", enabled: false, state: {} }),
      createBaseJob({ id: "later", state: { nextRunAtMs: 200 } }),
      createBaseJob({ id: "paused-a", enabled: false, state: {} }),
      createBaseJob({ id: "earlier", state: { nextRunAtMs: 100 } }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const unpaginated = await list(state, { includeDisabled: true });
    const page = await listPage(state, { enabled: "all", sortBy: "nextRunAtMs" });

    expect(unpaginated.map((job) => job.id)).toEqual(["earlier", "later", "paused-a", "paused-z"]);
    expect(unpaginated.map((job) => job.id)).toEqual(page.jobs.map((job) => job.id));
    expect(jobs.map((job) => job.id)).toEqual(["paused-z", "later", "paused-a", "earlier"]);
  });

  it("applies the same stable id tiebreaker to unpaginated cron jobs", async () => {
    const nextRunAtMs = Date.parse("2026-02-27T15:30:00.000Z");
    const jobs = [
      createBaseJob({ id: "scheduled-z", state: { nextRunAtMs } }),
      createBaseJob({ id: "scheduled-a", state: { nextRunAtMs } }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const unpaginated = await list(state);

    expect(unpaginated.map((job) => job.id)).toEqual(["scheduled-a", "scheduled-z"]);
  });

  it("matches the operator-visible display name when filtering cron jobs", async () => {
    const job = createBaseJob({
      id: "report-job",
      name: "internal-report-name",
      displayName: "Daily summary",
    });
    const state = createMockCronStateForJobs({ jobs: [job] });

    const page = await listPage(state, { query: "Daily summary" });

    expect(page.jobs.map((entry) => entry.id)).toEqual(["report-job"]);
  });

  it("preserves phrase searches across existing cron job fields", async () => {
    const job = createBaseJob({
      id: "report-job",
      name: "Daily report",
      description: "Quarterly summary",
      displayName: "Executive overview",
    });
    const state = createMockCronStateForJobs({ jobs: [job] });

    const page = await listPage(state, { query: "report Quarterly" });

    expect(page.jobs.map((entry) => entry.id)).toEqual(["report-job"]);
  });

  it("normalizes requested agent ids before filtering", async () => {
    const jobs = [
      createBaseJob({ id: "job-main", agentId: "main", name: "main" }),
      createBaseJob({ id: "job-ops", agentId: "ops", name: "ops" }),
      createBaseJob({ id: "job-unset", agentId: undefined, name: "unset" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { agentId: " Ops " });

    expect(page.jobs.map((job) => job.id)).toEqual(["job-ops"]);
  });

  it("matches omitted job agent ids to the configured default agent when filtering", async () => {
    const jobs = [
      createBaseJob({ id: "job-main", agentId: "main", name: "main" }),
      createBaseJob({ id: "job-ops", agentId: "ops", name: "ops" }),
      createBaseJob({ id: "job-unset", agentId: undefined, name: "unset" }),
    ];
    const state = createMockCronStateForJobs({ jobs });
    state.deps.defaultAgentId = " Ops ";

    const page = await listPage(state, { agentId: "ops" });

    expect(page.jobs.map((job) => job.id)).toEqual(["job-ops", "job-unset"]);
  });

  it("matches scoped session owners before the configured default", async () => {
    const jobs = [
      createBaseJob({
        id: "job-scoped",
        agentId: undefined,
        sessionKey: "agent:ops:main",
      }),
    ];
    const state = createMockCronStateForJobs({ jobs });
    state.deps.defaultAgentId = "main";

    const page = await listPage(state, { agentId: "ops" });

    expect(page.jobs.map((job) => job.id)).toEqual(["job-scoped"]);
  });

  it("matches omitted job agent ids to the prepared main default", async () => {
    const jobs = [
      createBaseJob({ id: "job-main", agentId: "main", name: "main" }),
      createBaseJob({ id: "job-ops", agentId: "ops", name: "ops" }),
      createBaseJob({ id: "job-unset", agentId: undefined, name: "unset" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { agentId: "main" });

    expect(page.jobs.map((job) => job.id)).toEqual(["job-main", "job-unset"]);
  });

  it("keeps listPage unfiltered when agent id is omitted", async () => {
    const jobs = [
      createBaseJob({ id: "job-main", agentId: "main", name: "main" }),
      createBaseJob({ id: "job-ops", agentId: "ops", name: "ops" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state);

    expect(page.jobs.map((job) => job.id)).toEqual(["job-main", "job-ops"]);
  });

  it("keeps one revision across pages and changes it for same-count store churn", async () => {
    const jobs = [
      createBaseJob({ id: "job-a", name: "alpha" }),
      createBaseJob({ id: "job-b", name: "beta" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const firstPage = await listPage(state, { limit: 1, offset: 0, sortBy: "name" });
    const secondPage = await listPage(state, { limit: 1, offset: 1, sortBy: "name" });
    expect(secondPage.snapshotRevision).toBe(firstPage.snapshotRevision);

    if (!state.store) {
      throw new Error("expected loaded cron store");
    }
    state.store.jobs = [jobs[1]!, createBaseJob({ id: "job-c", name: "gamma" })];
    const changedPage = await listPage(state, { limit: 1, offset: 0, sortBy: "name" });

    expect(changedPage.total).toBe(firstPage.total);
    expect(changedPage.snapshotRevision).not.toBe(firstPage.snapshotRevision);
  });

  it("detaches returned pages from later in-place store mutations", async () => {
    const job = createBaseJob({ id: "job-a", name: "alpha" });
    const state = createMockCronStateForJobs({ jobs: [job] });

    const page = await listPage(state);
    job.state.lastStatus = "ok";

    expect(page.jobs[0]).not.toBe(job);
    expect(page.jobs[0]?.state.lastStatus).toBeUndefined();
  });

  it("listPage does not clone the complete store, detaches only requested rows, and revisions cover off-page changes", async () => {
    const jobs = [
      createBaseJob({ id: "job-a", name: "alpha" }),
      createBaseJob({ id: "job-b", name: "beta" }),
      createBaseJob({ id: "job-c", name: "gamma" }),
    ];
    const state = createMockCronStateForJobs({ jobs });
    const clone = vi.spyOn(globalThis, "structuredClone");

    try {
      const options = { limit: 1, offset: 1, sortBy: "name" as const };
      const page = await listPage(state, options);
      const clonedArrays = clone.mock.calls.filter(([value]) => Array.isArray(value));

      expect(clone).not.toHaveBeenCalledWith(state.store);
      expect(clonedArrays).toHaveLength(1);
      expect(clonedArrays[0]?.[0]).toEqual([jobs[1]]);
      expect(page.jobs[0]).not.toBe(jobs[1]);

      jobs[2]!.state.lastStatus = "ok";
      const changed = await listPage(state, options);

      expect(changed.jobs.map((job) => job.id)).toEqual(["job-b"]);
      expect(changed.snapshotRevision).not.toBe(page.snapshotRevision);
    } finally {
      clone.mockRestore();
    }
  });

  it("matches job ids in listPage text search", async () => {
    const jobs = [
      createBaseJob({ id: "daily-report", name: "Morning report" }),
      createBaseJob({ id: "tax-digest", name: "Finance digest" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { query: "tax" });

    expect(page.jobs.map((job) => job.id)).toEqual(["tax-digest"]);
  });

  it("applies schedule, status, and trigger filters before paging", async () => {
    const nextRunAtMs = Date.parse("2030-02-27T15:30:00.000Z");
    const jobs = [
      createBaseJob({
        id: "at-unknown",
        schedule: { kind: "at", at: "2030-02-27T15:30:00.000Z" },
        state: { nextRunAtMs },
      }),
      createBaseJob({
        id: "cron-error",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        state: { nextRunAtMs, lastStatus: "error" },
      }),
      createBaseJob({
        id: "cron-unknown",
        schedule: { kind: "cron", expr: "0 10 * * *" },
        trigger: { script: "json({ fire: true })" },
        state: { nextRunAtMs },
      }),
      createBaseJob({
        id: "cron-unknown-plain",
        schedule: { kind: "cron", expr: "0 11 * * *" },
        state: { nextRunAtMs },
      }),
    ];
    const state = createMockCronStateForJobs({ jobs });
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-list-page-"));
    try {
      state.deps.storePath = path.join(storeDir, "jobs.json");

      const page = await listPage(state, {
        scheduleKind: "cron",
        lastRunStatus: "unknown",
        trigger: "conditional",
        limit: 1,
      });

      expect(page.jobs.map((job) => job.id)).toEqual(["cron-unknown"]);
      expect(page.total).toBe(1);
      expect(page.hasMore).toBe(false);
    } finally {
      await fs.rm(storeDir, { recursive: true, force: true });
    }
  });
});

describe("cron listPage slow diagnostics", () => {
  it.each([999, 1_000])(
    "warns only once elapsed reaches the threshold (%i ms)",
    async (duration) => {
      let now = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const state = createMockCronStateForJobs({ jobs: [createBaseJob()] });
      const warn = vi.fn();
      state.deps.log.warn = warn;
      state.deps.resolveDefaultAgentId = () => {
        now = duration;
        return "main";
      };
      try {
        const page = await listPage(state, { agentId: "main" });
        expect(page.jobs).toHaveLength(1);
        expect(warn).toHaveBeenCalledTimes(duration < 1_000 ? 0 : 1);
        if (duration >= 1_000) {
          expect(warn).toHaveBeenCalledWith(
            {
              operation: "cron.listPage",
              pid: process.pid,
              threadId,
              isMainThread,
              elapsedMs: 1_000,
              waitToCallbackMs: 0,
              callbackMs: 1_000,
              completionDelayMs: 0,
              sourceCount: 1,
              matchedCount: 1,
              returnedCount: 1,
              outcome: "ok",
              thresholdMs: 1_000,
            },
            "cron: slow list page",
          );
        }
      } finally {
        await state.op;
        clock.mockRestore();
      }
    },
  );

  it("separates a held predecessor from callback work without delaying another partition", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const state = createMockCronStateForJobs({
      jobs: [createBaseJob(), createBaseJob({ id: "disabled", enabled: false })],
    });
    const other = createMockCronStateForJobs({ jobs: [] });
    other.deps.storePath = "/mock/other-partition";
    const warn = vi.fn();
    state.deps.log.warn = warn;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const order: string[] = [];
    const predecessor = locked(state, async () => {
      order.push("predecessor");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    state.deps.resolveDefaultAgentId = () => {
      order.push("list");
      now = 1_750;
      return "main";
    };
    const pagePromise = listPage(state, { agentId: "main", limit: 1 });
    const successor = locked(state, async () => {
      order.push("successor");
    });
    try {
      expect((await listPage(other)).jobs).toEqual([]);
      expect(order).toEqual(["predecessor"]);
      expect(warn).not.toHaveBeenCalled();
      now = 1_400;
      release.resolve();
      const page = await pagePromise;
      await successor;
      expect(order).toEqual(["predecessor", "list", "successor"]);
      expect(page.jobs.map((job) => job.id)).toEqual(["job-1"]);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        {
          operation: "cron.listPage",
          pid: process.pid,
          threadId,
          isMainThread,
          elapsedMs: 1_750,
          waitToCallbackMs: 1_400,
          callbackMs: 350,
          completionDelayMs: 0,
          sourceCount: 2,
          matchedCount: 1,
          returnedCount: 1,
          outcome: "ok",
          thresholdMs: 1_000,
        },
        "cron: slow list page",
      );
    } finally {
      release.resolve();
      await Promise.allSettled([predecessor, pagePromise, successor, other.op]);
      clock.mockRestore();
    }
  });

  it.each([false, true])(
    "preserves callback failure and subsequent reads when logger throws=%s",
    async (loggerThrows) => {
      let now = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const state = createMockCronStateForJobs({ jobs: [createBaseJob()] });
      const failure = new Error("synthetic selected-row failure");
      const warn = vi.fn(() => {
        if (loggerThrows) {
          throw new Error("synthetic logger failure");
        }
      });
      state.deps.log.warn = warn;
      state.deps.resolveDefaultAgentId = () => {
        now = 1_200;
        throw failure;
      };
      try {
        await expect(listPage(state, { agentId: "main" })).rejects.toBe(failure);
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          {
            operation: "cron.listPage",
            pid: process.pid,
            threadId,
            isMainThread,
            elapsedMs: 1_200,
            waitToCallbackMs: 0,
            callbackMs: 1_200,
            completionDelayMs: 0,
            sourceCount: 1,
            matchedCount: undefined,
            returnedCount: undefined,
            outcome: "error",
            thresholdMs: 1_000,
          },
          "cron: slow list page",
        );
        expect((await listPage(state)).jobs.map((job) => job.id)).toEqual(["job-1"]);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        await state.op;
        clock.mockRestore();
      }
    },
  );

  it("preserves the detached page when the slow warning logger throws", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const job = createBaseJob();
    const state = createMockCronStateForJobs({ jobs: [job] });
    state.deps.log.warn = () => {
      throw new Error("synthetic logger failure");
    };
    state.deps.resolveDefaultAgentId = () => {
      now = 1_100;
      return "main";
    };
    try {
      const page = await listPage(state, { agentId: "main" });
      expect(page.jobs).toEqual([job]);
      expect(page.jobs[0]).not.toBe(job);
      expect((await listPage(state)).snapshotRevision).toBe(page.snapshotRevision);
    } finally {
      await state.op;
      clock.mockRestore();
    }
  });
});
