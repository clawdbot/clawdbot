import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { CronService } from "../service.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import type { CronStoredJob } from "../types.js";
import { stop } from "./ops-lifecycle.js";
import { applyCronRuntimeRowsToState } from "./runtime-store.js";
import { createCronServiceState } from "./state.js";
import { armTimer } from "./timer.js";

const runtimeStoreFixtures = setupCronRegressionFixtures({ prefix: "cron-runtime-store-" });

describe("cron runtime row publication", () => {
  afterEach(() => vi.useRealTimers());

  it("hands persisted authority to the runner and records its revocation failure", async () => {
    resetTaskRegistryForTests();
    const store = runtimeStoreFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
    const job: CronStoredJob = createDueIsolatedJob({
      id: "manual-run-runtime-authority",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    job.schedule = { kind: "every", everyMs: 60_000, anchorMs: dueAt };
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { auth: { managedRequirementsFingerprint: "f".repeat(64) } },
    };
    job.runtimeAuthority = runtimeAuthority;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const error = "Scheduled runtime authority was revoked. Reauthorize this automation.";
    const runIsolatedAgentJob = vi.fn().mockRejectedValue(new AgentHarnessPreflightError(error));
    const onEvent = vi.fn();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      onEvent,
    });

    try {
      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id, runtimeAuthority }),
        }),
      );
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "finished", jobId: job.id, status: "error", error }),
      );
      expect(
        readCronTaskRunHistoryPage({
          storeKey: cronStoreKey(store.storePath),
          jobId: job.id,
          limit: 1,
        }).entries,
      ).toMatchObject([{ jobId: job.id, status: "error", error }]);
      expect((await loadCronStore(store.storePath)).jobs).toMatchObject([
        {
          id: job.id,
          enabled: true,
          runtimeAuthority,
          state: { lastRunStatus: "error", lastError: error },
        },
      ]);
    } finally {
      cron.stop();
      resetTaskRegistryForTests();
    }
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
