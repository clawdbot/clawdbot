import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { stop } from "./ops-lifecycle.js";
import { applyCronRuntimeRowsToState } from "./runtime-store.js";
import { createCronServiceState } from "./state.js";
import { armTimer } from "./timer.js";

describe("cron runtime row publication", () => {
  afterEach(() => vi.useRealTimers());

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
