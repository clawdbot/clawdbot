import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  withCronServiceForTest,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();

async function waitForFirstJob(
  cron: CronService,
  predicate: (job: CronJob | undefined) => boolean,
) {
  let latest: CronJob | undefined;
  for (let i = 0; i < 30; i++) {
    const jobs = await cron.list({ includeDisabled: true });
    latest = jobs[0];
    if (predicate(latest)) {
      return latest;
    }
    await vi.runOnlyPendingTimersAsync();
  }
  return latest;
}

async function withCronService(
  cronEnabled: boolean,
  run: (params: {
    cron: CronService;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeat: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
) {
  await withCronServiceForTest(
    {
      makeStorePath,
      logger: noopLogger,
      cronEnabled,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    },
    run,
  );
}

describe("CronService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips main jobs with empty systemEvent text", async () => {
    await withCronService(true, async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
      const atMs = Date.parse("2025-12-13T00:00:01.000Z");
      await cron.add({
        name: "empty systemEvent test",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "   " },
      });

      vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
      await vi.runOnlyPendingTimersAsync();

      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();

      const job = await waitForFirstJob(cron, (current) => current?.state.lastStatus === "skipped");
      expect(job?.state.lastStatus).toBe("skipped");
      expect(job?.state.lastError).toMatch(/non-empty/i);
    });
  });

  it("does not schedule timers when cron is disabled", async () => {
    await withCronService(false, async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
      const atMs = Date.parse("2025-12-13T00:00:01.000Z");
      await cron.add({
        name: "disabled cron job",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "hello" },
      });

      const status = await cron.status();
      expect(status.enabled).toBe(false);
      expect(status.nextWakeAtMs).toBeNull();

      vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
      await vi.runOnlyPendingTimersAsync();

      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
      expect(noopLogger.warn).toHaveBeenCalled();
    });
  });

  it("status reports next wake when enabled", async () => {
    await withCronService(true, async ({ cron }) => {
      const atMs = Date.parse("2025-12-13T00:00:05.000Z");
      await cron.add({
        name: "status next wake",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });

      const status = await cron.status();
      expect(status.enabled).toBe(true);
      expect(status.jobs).toBe(1);
      expect(status.nextWakeAtMs).toBe(atMs);
    });
  });
});
