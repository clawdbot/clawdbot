import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-heartbeat-ok-suppressed",
});
type CronServiceParams = ConstructorParameters<typeof CronService>[0];

function createDueIsolatedAnnounceJob(params: {
  id: string;
  message: string;
  now: number;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    createdAtMs: params.now - 10_000,
    updatedAtMs: params.now - 10_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: params.message },
    delivery: { mode: "announce" },
    state: { nextRunAtMs: params.now - 1 },
  };
}

function createCronServiceForSummary(params: {
  storePath: string;
  summary: string;
  enqueueSystemEvent: CronServiceParams["enqueueSystemEvent"];
  requestHeartbeat: CronServiceParams["requestHeartbeat"];
}) {
  return new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: params.enqueueSystemEvent,
    requestHeartbeat: params.requestHeartbeat,
    runHeartbeatOnce: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({
      status: "ok" as const,
      summary: params.summary,
      delivered: false,
      deliveryAttempted: false,
    })),
  });
}

async function runScheduledCron(cron: CronService): Promise<void> {
  await cron.start();
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(1_000);
  cron.stop();
}

describe("cron isolated job HEARTBEAT_OK summary suppression (#32013)", () => {
  it("does not enqueue HEARTBEAT_OK as a system event to the main session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createDueIsolatedAnnounceJob({
      id: "heartbeat-only-job",
      message: "Check if anything is new",
      now,
    });

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const cron = createCronServiceForSummary({
      storePath,
      summary: "HEARTBEAT_OK",
      enqueueSystemEvent,
      requestHeartbeat,
    });

    await runScheduledCron(cron);

    // HEARTBEAT_OK should NOT leak into the main session as a system event.
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("does not revive legacy main-session relay for real cron summaries", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createDueIsolatedAnnounceJob({
      id: "real-summary-job",
      message: "Check weather",
      now,
    });

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const cron = createCronServiceForSummary({
      storePath,
      summary: "Weather update: sunny, 72°F",
      enqueueSystemEvent,
      requestHeartbeat,
    });

    await runScheduledCron(cron);

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });
});
