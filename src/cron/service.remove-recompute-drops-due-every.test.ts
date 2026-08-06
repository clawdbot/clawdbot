import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { loadCronJobsStore } from "./store.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

const base = Date.parse("2025-12-13T00:00:00.000Z");

function dueEveryJob(): CronJob {
  return {
    id: "due-every",
    name: "due every 10s",
    enabled: true,
    createdAtMs: base - 3_600_000,
    updatedAtMs: base - 10_000,
    schedule: { kind: "every", everyMs: 10_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "tick" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: base - 5_000 },
  };
}

function missingNextRunJob(): CronJob {
  return {
    id: "missing-next",
    name: "enabled daily without next run",
    enabled: true,
    createdAtMs: base - 3_600_000,
    updatedAtMs: base - 10_000,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "daily" },
    delivery: { mode: "none" },
    state: {},
  };
}

function jobToRemove(): CronJob {
  return {
    id: "to-remove",
    name: "obsolete job",
    enabled: true,
    createdAtMs: base - 3_600_000,
    updatedAtMs: base - 10_000,
    schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "noop" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: base + 3_600_000 },
  };
}

describe("remove() must not drop a due every-job's pending run", () => {
  it("preserves a due sibling while backfilling another enabled sibling on cold-store remove", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [dueEveryJob(), missingNextRunJob(), jobToRemove()],
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const result = await cron.remove("to-remove");
    expect(result).toEqual({ ok: true, removed: true });

    const persisted = await loadCronJobsStore(store.storePath);
    const byId = new Map(persisted.jobs.map((job) => [job.id, job]));

    expect(byId.has("to-remove")).toBe(false);
    expect(byId.get("due-every")?.state.nextRunAtMs).toBe(base - 5_000);
    expect(byId.get("missing-next")?.state.nextRunAtMs).toBeGreaterThan(base);

    cron.stop();
  });
});
