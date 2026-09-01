import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { saveCronStore } from "../store.js";
import type { CronStoredJob } from "../types.js";
import { stop } from "./ops-lifecycle.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import { createCronServiceState } from "./state.js";
import { armTimer } from "./timer.js";

const runtimeStoreFixtures = setupCronRegressionFixtures({ prefix: "cron-runtime-store-" });

describe("cron runtime row publication", () => {
  afterEach(() => vi.useRealTimers());

  it("hydrates private runtime authority in runtime row transactions", async () => {
    const store = runtimeStoreFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
    const job: CronStoredJob = createDueIsolatedJob({
      id: "manual-run-runtime-authority",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { auth: { managedRequirementsFingerprint: "f".repeat(64) } },
    };
    job.runtimeAuthority = runtimeAuthority;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const committedJob = commitCronRuntimeRows({
      state,
      jobIds: [job.id],
      operationLabel: "test runtime authority hydration",
      mutate: ({ jobs }) => ({ value: jobs.get(job.id) }),
    });

    expect(committedJob?.runtimeAuthority).toEqual(runtimeAuthority);
  });

  it("adds a sibling-imported row to memory before arming its timer", () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-13T18:00:00.000Z");
    vi.setSystemTime(now);
    const resident = createDueIsolatedJob({
      id: "resident-job",
      nowMs: now,
      nextRunAtMs: now + 120_000,
    });
    resident.enabled = false;
    const imported = createDueIsolatedJob({
      id: "sibling-imported-job",
      nowMs: now,
      nextRunAtMs: now + 60_000,
    });
    const state = createCronServiceState({
      storePath: "/tmp/runtime-store-import.json",
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    state.store = { version: 1, jobs: [resident] };

    applyCronRuntimeRowsToState(state, [imported]);
    armTimer(state);

    expect(state.store.jobs.map((job) => job.id)).toEqual([resident.id, imported.id]);
    expect(state.timer).not.toBeNull();
    stop(state);
  });
});
