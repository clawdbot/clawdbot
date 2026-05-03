import { describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../channels/plugins/types.js";
import { CronService, type CronServiceDeps } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  withCronServiceForTest,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-delivery-" });

type DeliveryMode = "none" | "announce";

type DeliveryOverride = {
  mode: DeliveryMode;
  channel?: ChannelId;
  to?: string;
};

async function withCronService(
  params: {
    runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  },
  run: (context: {
    cron: CronService;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeat: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
) {
  await withCronServiceForTest(
    {
      makeStorePath,
      logger: noopLogger,
      cronEnabled: false,
      runIsolatedAgentJob: params.runIsolatedAgentJob,
    },
    run,
  );
}

async function addIsolatedAgentTurnJob(
  cron: CronService,
  params: {
    name: string;
    wakeMode: "next-heartbeat" | "now";
    delivery?: DeliveryOverride;
  },
) {
  return cron.add({
    name: params.name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
    sessionTarget: "isolated",
    wakeMode: params.wakeMode,
    payload: {
      kind: "agentTurn",
      message: "hello",
    } as unknown as { kind: "agentTurn"; message: string },
    ...(params.delivery
      ? {
          delivery: params.delivery as unknown as {
            mode: DeliveryMode;
            channel?: string;
            to?: string;
          },
        }
      : {}),
  });
}

describe("CronService delivery plan consistency", () => {
  it("does not post isolated summary when delivery.mode=none", async () => {
    await withCronService({}, async ({ cron, enqueueSystemEvent }) => {
      const job = await addIsolatedAgentTurnJob(cron, {
        name: "delivery-off",
        wakeMode: "next-heartbeat",
        delivery: { mode: "none" },
      });

      const result = await cron.run(job.id, "force");
      expect(result).toEqual({ ok: true, ran: true });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    });
  });

  it("treats delivery object without mode as announce without reviving legacy relay fallback", async () => {
    await withCronService({}, async ({ cron, enqueueSystemEvent }) => {
      const job = await addIsolatedAgentTurnJob(cron, {
        name: "partial-delivery",
        wakeMode: "next-heartbeat",
        delivery: { channel: "telegram", to: "123" } as DeliveryOverride,
      });

      const result = await cron.run(job.id, "force");
      expect(result).toEqual({ ok: true, ran: true });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(cron.getJob(job.id)?.state.lastDeliveryStatus).toBe("unknown");
    });
  });

  it("does not enqueue duplicate relay when isolated run marks delivery handled", async () => {
    await withCronService(
      {
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "ok" as const,
          summary: "done",
          delivered: true,
        })),
      },
      async ({ cron, enqueueSystemEvent, requestHeartbeat }) => {
        const job = await addIsolatedAgentTurnJob(cron, {
          name: "announce-delivered",
          wakeMode: "now",
          delivery: { channel: "telegram", to: "123" } as DeliveryOverride,
        });

        const result = await cron.run(job.id, "force");
        expect(result).toEqual({ ok: true, ran: true });
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeat).not.toHaveBeenCalled();
      },
    );
  });
});
