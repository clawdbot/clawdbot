import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type LaneTestParams = RunEmbeddedAgentParams & { sessionFile: string };

function createLaneController(params: {
  sessionLane: string;
  globalLane?: string;
  runId: string;
  enqueue?: CommandQueueEnqueueFn;
}) {
  let runParams: LaneTestParams = {
    sessionId: params.runId,
    sessionFile: `${params.runId}.jsonl`,
    workspaceDir: "/tmp/openclaw-lane-controller-test",
    prompt: "test",
    timeoutMs: 1,
    runId: params.runId,
    trigger: "user",
    ...(params.enqueue ? { enqueue: params.enqueue } : {}),
  };
  let lifecycleGeneration = getAgentEventLifecycleGeneration();

  return createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => runParams,
    globalLane: params.globalLane ?? "test:embedded-global",
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    sessionLane: params.sessionLane,
    setLifecycleGeneration: (generation) => {
      lifecycleGeneration = generation;
    },
    setParams: (nextParams) => {
      runParams = nextParams;
    },
  });
}

function expectLaneCounts(lane: string, activeCount: number, queuedCount: number) {
  expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount, queuedCount });
}

describe("embedded run session lane", () => {
  afterEach(() => {
    resetCommandQueueStateForTest();
  });

  it("passes the run deadline and lifecycle signals into injected session queues", async () => {
    let observedOptions: Parameters<CommandQueueEnqueueFn>[1];
    const enqueue: CommandQueueEnqueueFn = async (task, options) => {
      observedOptions = options;
      return await task();
    };
    const controller = createLaneController({
      sessionLane: "test:injected-session-deadline",
      runId: "injected-session-deadline",
      enqueue,
    });

    await expect(controller.enqueueSession(async () => "finished")).resolves.toBe("finished");
    expect(observedOptions).toMatchObject({
      priority: "foreground",
      taskTimeoutMs: 30_001,
      taskTimeoutAbortGraceMs: 30_000,
      taskTimeoutAbortSignal: controller.laneTaskAbortController.signal,
      taskTimeoutReleaseSignal: controller.laneTaskReleaseController.signal,
    });
    expect(observedOptions?.taskTimeoutProgressAtMs?.()).toEqual(expect.any(Number));
  });

  it.each(["deadline", "release"] as const)(
    "releases all queued session turns when the active turn reaches its %s",
    async (termination) => {
      const sessionLane = `test:session-stall-${termination}`;
      setCommandLaneConcurrency(sessionLane, 1);
      const stalledController = createLaneController({
        sessionLane,
        runId: `stalled-${termination}`,
      });
      const stalled = stalledController.enqueueSession(
        async () => await new Promise<never>(() => {}),
        { taskTimeoutMs: 25 },
      );
      const stalledFailure = expect(stalled).rejects.toMatchObject({
        name: "CommandLaneTaskTimeoutError",
      });
      const successorController = createLaneController({
        sessionLane,
        runId: `successor-${termination}`,
      });
      const successor = successorController.enqueueSession(async () => "finished");

      expectLaneCounts(sessionLane, 1, 1);

      if (termination === "release") {
        stalledController.laneTaskReleaseController.abort();
      }

      await stalledFailure;
      await expect(successor).resolves.toBe("finished");
      expectLaneCounts(sessionLane, 0, 0);
    },
  );

  it("keeps the session lease alive until every concurrent global admission settles", async () => {
    const sessionLane = "test:session-concurrent-global-admission";
    const globalLane = "test:concurrent-global-admission";
    setCommandLaneConcurrency(globalLane, 1);

    const interveningGlobalGate = createDeferred();
    const interveningGlobalTaskStarted = createDeferred();
    const controller = createLaneController({
      sessionLane,
      globalLane,
      runId: "healthy-concurrent-global-admission",
    });
    const run = controller.enqueueSession(
      async () => {
        const firstGlobalAdmission = controller.enqueueGlobal(async () => ({
          meta: { durationMs: 1 },
        }));
        const interveningGlobalTask = enqueueCommandInLane(
          globalLane,
          async () => {
            interveningGlobalTaskStarted.resolve();
            await interveningGlobalGate.promise;
          },
          { priority: "foreground" },
        );
        const secondGlobalAdmission = controller.enqueueGlobal(async () => ({
          meta: { durationMs: 2 },
        }));
        return await Promise.all([
          firstGlobalAdmission,
          interveningGlobalTask,
          secondGlobalAdmission,
        ]);
      },
      { taskTimeoutMs: 25 },
    );

    try {
      await interveningGlobalTaskStarted.promise;
      await delay(75);
      expectLaneCounts(sessionLane, 1, 0);
      expectLaneCounts(globalLane, 1, 1);

      interveningGlobalGate.resolve();
      await expect(run).resolves.toEqual([
        { meta: { durationMs: 1 } },
        undefined,
        { meta: { durationMs: 2 } },
      ]);
      expectLaneCounts(sessionLane, 0, 0);
    } finally {
      interveningGlobalGate.resolve();
    }
  });

  it("times out a stalled global task while another global admission keeps the session alive", async () => {
    const sessionLane = "test:session-stalled-global-with-successor";
    const globalLane = "test:stalled-global-with-successor";
    setCommandLaneConcurrency(globalLane, 1);

    const stalledGlobalTaskStarted = createDeferred();
    const controller = createLaneController({
      sessionLane,
      globalLane,
      runId: "stalled-global-with-successor",
    });
    const run = controller.enqueueSession(
      async () => {
        const stalledGlobalAdmission = controller.enqueueGlobal(
          async () => {
            stalledGlobalTaskStarted.resolve();
            return await new Promise<never>(() => {});
          },
          { taskTimeoutMs: 25 },
        );
        const stalledGlobalFailure = expect(stalledGlobalAdmission).rejects.toMatchObject({
          name: "CommandLaneTaskTimeoutError",
        });
        const successorGlobalAdmission = controller.enqueueGlobal(async () => ({
          meta: { durationMs: 1 },
        }));

        await stalledGlobalFailure;
        return await successorGlobalAdmission;
      },
      { taskTimeoutMs: 25 },
    );
    const completedRun = expect(run).resolves.toEqual({ meta: { durationMs: 1 } });

    await stalledGlobalTaskStarted.promise;
    expectLaneCounts(sessionLane, 1, 0);
    expectLaneCounts(globalLane, 1, 1);

    await completedRun;
    expectLaneCounts(sessionLane, 0, 0);
    expectLaneCounts(globalLane, 0, 0);
  });
});
