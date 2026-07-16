// Verifies the configured retry.backoffMs floor for a recurring job survives a
// real cron service run and is persisted to the SQLite-backed store, not just
// computed in memory by applyJobResult.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { run } from "./ops.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-backoff-config-readback",
});

function createDueRecurringJob(now: number): CronJob {
  return {
    id: "recurring-backoff-readback",
    name: "recurring backoff readback",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 1_000, anchorMs: now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "ping" },
    sessionKey: "agent:main:main",
    state: { nextRunAtMs: now - 1 },
  };
}

describe("recurring error backoff floor persistence", () => {
  it("persists the configured retry.backoffMs floor across a real run and SQLite readback", async () => {
    const now = Date.parse("2026-03-02T12:00:00.000Z");
    const { storePath } = await makeStorePath();
    const stateRoot = path.dirname(path.dirname(storePath));
    const job = createDueRecurringJob(now);

    let persistedJob: CronJob | undefined;
    resetTaskRegistryForTests();
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateRoot }, async () => {
        await writeCronStoreSnapshot({ storePath, jobs: [job] });

        const state = createCronServiceState({
          storePath,
          cronEnabled: true,
          log: logger,
          nowMs: () => now,
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          // Permanent (non-retryable) error -> recurring safety-net backoff
          // floor, the branch that must honor the configured backoffMs.
          runIsolatedAgentJob: vi.fn(async () => {
            throw new Error("permanent: bad request");
          }),
          cronConfig: { retry: { backoffMs: [300_000] } },
        });

        // mode "due" (not "force") keeps preserveSchedule false, so the error
        // path computes the safety-net backoff floor rather than preserving the
        // recurring anchor.
        await expect(run(state, job.id, "due")).resolves.toEqual({ ok: true, ran: true });

        const persisted = (await loadCronStore(storePath)) as { jobs: CronJob[] };
        persistedJob = persisted.jobs.find((entry) => entry.id === job.id);
      });
    } finally {
      resetTaskRegistryForTests();
    }

    // The floor read back from the SQLite-backed store must be endedAt(=now) +
    // the configured backoffMs[0], not the hardcoded 30000 default.
    expect(persistedJob?.state.nextRunAtMs).toBe(now + 300_000);
    expect(persistedJob?.state.lastStatus).toBe("error");
    expect(persistedJob?.state.consecutiveErrors).toBe(1);
  });
});
