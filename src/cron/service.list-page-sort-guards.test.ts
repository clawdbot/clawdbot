// Cron list pagination tests cover stable sorting and page boundary guards.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { listPage } from "./service/ops.js";
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

  it("matches job ids in listPage text search", async () => {
    const jobs = [
      createBaseJob({ id: "daily-report", name: "Morning report" }),
      createBaseJob({ id: "tax-digest", name: "Finance digest" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { query: "tax" });

    expect(page.jobs.map((job) => job.id)).toEqual(["tax-digest"]);
  });

  it("applies schedule and last-run status filters before paging", async () => {
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
