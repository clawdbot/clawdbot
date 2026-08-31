import { describe, expect, it, vi } from "vitest";
import { CronService, type CronEvent } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-webhook-empty-",
  baseTimeIso: "2026-08-01T00:00:00Z",
});

describe("cron webhook optional output", () => {
  it.each([
    { status: "ok", summary: undefined },
    { status: "ok", summary: "" },
    { status: "ok", summary: " \n " },
    { status: "error", summary: undefined },
  ] as const)(
    "records $status with summary $summary without false delivery",
    async ({ status, summary }) => {
      const store = await makeStorePath();
      const sendCronWebhook = vi.fn(async () => {});
      const events: CronEvent[] = [];
      const cron = new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({
          status,
          summary,
          ...(status === "error" ? { error: "execution failed" } : {}),
        })),
        sendCronWebhook,
        onEvent: (event) => {
          events.push(event);
        },
      });
      try {
        await cron.start();
        const job = await cron.add({
          name: "optional webhook output",
          enabled: true,
          schedule: { kind: "at", at: new Date(Date.now()).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "notify only when needed" },
          delivery: { mode: "webhook", to: "https://example.invalid/hook" },
        });
        await cron.run(job.id, "force");
        const failed = status === "error";
        expect(sendCronWebhook).toHaveBeenCalledTimes(failed ? 1 : 0);
        expect(events.find((event) => event.action === "finished")).toMatchObject({
          status,
          completionStatus: failed ? "failed" : "succeeded",
          deliveryStatus: failed ? "delivered" : "not-delivered",
          deliverySuppressionReason: failed ? undefined : "empty",
          deliveryError: undefined,
        });
        if (!failed) {
          expect(cron.getJob(job.id)).toBeUndefined();
        }
      } finally {
        cron.stop();
      }
    },
  );
});
