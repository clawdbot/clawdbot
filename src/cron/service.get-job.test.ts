import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-get-job-" });
installCronTestHooks({ logger });

function createCronService(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("CronService.getJob", () => {
  it("returns added jobs and undefined for missing ids", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const added = await cron.add({
        name: "lookup-test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ping" },
      });

      expect(cron.getJob(added.id)?.id).toBe(added.id);
      expect(cron.getJob("missing-job-id")).toBeUndefined();
    } finally {
      cron.stop();
    }
  });

  it("preserves webhook delivery on create", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const webhookJob = await cron.add({
        name: "webhook-job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ping" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      });
      expect(cron.getJob(webhookJob.id)?.delivery).toEqual({
        mode: "webhook",
        to: "https://example.invalid/cron",
      });
    } finally {
      cron.stop();
    }
  });
});
