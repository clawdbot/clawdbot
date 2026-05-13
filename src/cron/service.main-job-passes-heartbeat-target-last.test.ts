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
    const requestHeartbeat = vi.fn();
    const cron = new CronService({
      storePath: params.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent,
      requestHeartbeat,
      runHeartbeatOnce: params.runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    return { cron, requestHeartbeat };
  }

  function requireRunHeartbeatOnceCall(
    runHeartbeatOnce: ReturnType<typeof vi.fn<RunHeartbeatOnce>>,
  ) {
    const callArgs = runHeartbeatOnce.mock.calls[0]?.[0];
    const heartbeat = callArgs?.heartbeat;
    if (!callArgs || !heartbeat) {
      throw new Error("expected runHeartbeatOnce call with heartbeat config");
    }
    return { ...callArgs, heartbeat };
  }

  function requireRequestHeartbeatCall(requestHeartbeat: ReturnType<typeof vi.fn>) {
    const callArgs = requestHeartbeat.mock.calls[0]?.[0];
    if (!callArgs) {
      throw new Error("expected requestHeartbeat call");
    }
    return callArgs as {
      source?: string;
      intent?: string;
      reason?: string;
      heartbeat?: unknown;
    };
  }

  async function runSingleTick(cron: CronService) {
    const startPromise = cron.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await startPromise;
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
    const callArgs = requireRunHeartbeatOnceCall(runHeartbeatOnce);
    expect(callArgs.heartbeat.target).toBe("last");
  });

  it("should preserve heartbeat.target=last when wakeMode=now falls back to requestHeartbeat", async () => {
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
      reason: "cron-in-progress",
    }));

    const { cron, requestHeartbeat } = createCronWithSpies({
      storePath,
      runHeartbeatOnce,
    });

    await runSingleTick(cron);

    expect(runHeartbeatOnce).toHaveBeenCalled();
    const heartbeatRequest = requireRequestHeartbeatCall(requestHeartbeat);
    expect(heartbeatRequest.source).toBe("cron");
    expect(heartbeatRequest.intent).toBe("immediate");
    expect(heartbeatRequest.reason).toBe("cron:test-main-delivery-busy");
    expect(heartbeatRequest.heartbeat).toEqual({ target: "last" });
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

    const { cron, requestHeartbeat } = createCronWithSpies({
      storePath,
      runHeartbeatOnce,
    });

    await runSingleTick(cron);

    expect(requestHeartbeat).toHaveBeenCalled();
    const heartbeatRequest = requireRequestHeartbeatCall(requestHeartbeat);
    expect(heartbeatRequest.source).toBe("cron");
    expect(heartbeatRequest.intent).toBe("event");
    expect(heartbeatRequest.reason).toBe("cron:test-next-heartbeat");
    expect(heartbeatRequest.heartbeat).toEqual({ target: "last" });
    expect(runHeartbeatOnce).not.toHaveBeenCalled();
  });
});
