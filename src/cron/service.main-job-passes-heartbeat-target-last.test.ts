// Main job heartbeat tests cover target ordering for heartbeat delivery.
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-main-heartbeat-target",
});

type RequestHeartbeatAndWait = NonNullable<
  ConstructorParameters<typeof CronService>[0]["requestHeartbeatAndWait"]
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

  function createCronWithSpies(params: {
    storePath: string;
    requestHeartbeatAndWait: RequestHeartbeatAndWait;
  }) {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const cron = new CronService({
      storePath: params.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent,
      requestHeartbeat,
      requestHeartbeatAndWait: params.requestHeartbeatAndWait,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    return { cron, enqueueSystemEvent, requestHeartbeat };
  }

  function requireRequestHeartbeatAndWaitCall(
    requestHeartbeatAndWait: ReturnType<typeof vi.fn<RequestHeartbeatAndWait>>,
  ) {
    const callArgs = requestHeartbeatAndWait.mock.calls[0]?.[0];
    const heartbeat = callArgs?.heartbeat;
    if (!callArgs || !heartbeat) {
      throw new Error("expected requestHeartbeatAndWait call with heartbeat config");
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
      agentId?: string;
      sessionKey?: string;
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

  it("should pass heartbeat.target=last to requestHeartbeatAndWait for wakeMode=now main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "test-main-delivery",
      wakeMode: "now",
    });

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const requestHeartbeatAndWait = vi.fn<RequestHeartbeatAndWait>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron } = createCronWithSpies({
      storePath,
      requestHeartbeatAndWait,
    });

    await runSingleTick(cron);

    // requestHeartbeatAndWait should have been called
    expect(requestHeartbeatAndWait).toHaveBeenCalled();

    // The heartbeat config passed should include target: "last" so the
    // heartbeat runner delivers the response to the last active channel.
    const callArgs = requireRequestHeartbeatAndWaitCall(requestHeartbeatAndWait);
    expect(callArgs.heartbeat.target).toBe("last");
    expect(callArgs.agentId).toBe("main");
    expect(callArgs.sessionKey).toBeUndefined();
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

    const requestHeartbeatAndWait = vi.fn<RequestHeartbeatAndWait>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron, enqueueSystemEvent, requestHeartbeat } = createCronWithSpies({
      storePath,
      requestHeartbeatAndWait,
    });

    await runSingleTick(cron);

    expect(requestHeartbeat).toHaveBeenCalled();
    const heartbeatRequest = requireRequestHeartbeatCall(requestHeartbeat);
    expect(heartbeatRequest.source).toBe("cron");
    expect(heartbeatRequest.intent).toBe("event");
    expect(heartbeatRequest.reason).toBe("cron:test-next-heartbeat");
    expect(heartbeatRequest.agentId).toBe("main");
    expect(heartbeatRequest.sessionKey).toBeUndefined();
    expect(heartbeatRequest.heartbeat).toEqual({ target: "last" });
    expect(requestHeartbeatAndWait).not.toHaveBeenCalled();
    const enqueueOptions = enqueueSystemEvent.mock.calls[0]?.[1] as {
      agentId?: string;
      sessionKey?: string;
    };
    expect(enqueueOptions.agentId).toBe("main");
    expect(enqueueOptions.sessionKey).toBeUndefined();
  });
});
