import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-main-heartbeat-target",
});

type RunHeartbeatOnce = NonNullable<
  ConstructorParameters<typeof CronService>[0]["runHeartbeatOnce"]
>;

describe("cron main job passes heartbeat target=last", () => {
  function createMainCronJob(params: {
    now: number;
    id: string;
    wakeMode: CronJob["wakeMode"];
  }): CronJob {
    return {
      id: params.id,
      name: params.id,
      enabled: true,
      createdAtMs: params.now - 10_000,
      updatedAtMs: params.now - 10_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: params.wakeMode,
      payload: { kind: "systemEvent", text: "Check in" },
      state: { nextRunAtMs: params.now - 1 },
    };
  }

  function createCronWithSpies(params: { storePath: string; runHeartbeatOnce: RunHeartbeatOnce }) {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const cron = new CronService({
      storePath: params.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce: params.runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    return { cron, requestHeartbeatNow };
  }

  async function runSingleTick(cron: CronService) {
    await cron.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    cron.stop();
  }

  it("should pass heartbeat.target=last to runHeartbeatOnce for wakeMode=now main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "test-main-delivery",
      wakeMode: "now",
    });

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron } = createCronWithSpies({
      storePath,
      runHeartbeatOnce,
    });

    await runSingleTick(cron);

    // runHeartbeatOnce should have been called
    expect(runHeartbeatOnce).toHaveBeenCalled();

    // The heartbeat config passed should include target: "last" so the
    // heartbeat runner delivers the response to the last active channel.
    const callArgs = runHeartbeatOnce.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.heartbeat).toBeDefined();
    expect(callArgs?.heartbeat?.target).toBe("last");
  });

  it("should preserve heartbeat.target=last when wakeMode=now falls back to requestHeartbeatNow", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "test-main-delivery-busy",
      wakeMode: "now",
    });

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      status: "skipped" as const,
      reason: "requests-in-flight",
    }));

    const { cron, requestHeartbeatNow } = createCronWithSpies({
      storePath,
      runHeartbeatOnce,
    });

    await runSingleTick(cron);

    expect(runHeartbeatOnce).toHaveBeenCalled();
    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "cron:test-main-delivery-busy",
        heartbeat: { target: "last" },
      }),
    );
  });

  it("should preserve heartbeat.target=last for wakeMode=next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "test-next-heartbeat",
      wakeMode: "next-heartbeat",
    });

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron, requestHeartbeatNow } = createCronWithSpies({
      storePath,
      runHeartbeatOnce,
    });

    await runSingleTick(cron);

    expect(requestHeartbeatNow).toHaveBeenCalled();
    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "cron:test-next-heartbeat",
        heartbeat: { target: "last" },
      }),
    );
    expect(runHeartbeatOnce).not.toHaveBeenCalled();
  });
});
