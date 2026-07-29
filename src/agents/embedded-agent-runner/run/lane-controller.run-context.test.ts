import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  registerAgentRunContext,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
  sweepStaleRunContexts,
} from "../../../infra/agent-events.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type LaneParams = RunEmbeddedAgentParams & { sessionFile: string };

beforeEach(() => resetAgentEventsForTest());
afterEach(() => vi.restoreAllMocks());

function createQueuedLaneController(runId: string) {
  const sessionKey = `agent:main:${runId}`;
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  registerAgentRunContext(runId, {
    lifecycleGeneration,
    registeredAt: Date.now(),
    sessionKey,
  });

  const queuedTasks: Array<() => Promise<void>> = [];
  const enqueue: CommandQueueEnqueueFn = <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queuedTasks.push(() => Promise.resolve().then(task).then(resolve, reject));
    });
  let laneParams: LaneParams = {
    enqueue,
    prompt: "test",
    runId,
    sessionFile: `/tmp/${runId}.jsonl`,
    sessionId: `${runId}-session`,
    sessionKey,
    timeoutMs: 60_000,
    trigger: "cron",
    workspaceDir: "/tmp",
  };
  const controller = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => laneParams,
    globalLane: "subagent",
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    sessionLane: `session:${runId}`,
    setLifecycleGeneration: () => {},
    setParams: (nextParams) => {
      laneParams = nextParams;
    },
  });
  return { controller, queuedTasks };
}

test("keeps run context active until every overlapping enqueue is admitted", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  const { controller, queuedTasks } = createQueuedLaneController("overlapping-queued-run");
  const firstResult = { meta: { durationMs: 1 } };
  const secondResult = { meta: { durationMs: 2 } };
  const firstQueuedResult = controller.enqueueGlobal(async () => firstResult);
  const secondQueuedResult = controller.enqueueGlobal(async () => secondResult);

  now.mockReturnValue(1_000);
  expect(sweepStaleRunContexts(500)).toBe(0);

  const startFirstTask = queuedTasks.shift();
  expect(startFirstTask).toBeDefined();
  await startFirstTask?.();
  await expect(firstQueuedResult).resolves.toBe(firstResult);

  now.mockReturnValue(2_000);
  expect(sweepStaleRunContexts(500)).toBe(0);

  const startSecondTask = queuedTasks.shift();
  expect(startSecondTask).toBeDefined();
  await startSecondTask?.();
  await expect(secondQueuedResult).resolves.toBe(secondResult);

  now.mockReturnValue(2_499);
  expect(sweepStaleRunContexts(500)).toBe(0);
  now.mockReturnValue(2_501);
  expect(sweepStaleRunContexts(500)).toBe(1);
});

test.each(["global", "session"] as const)(
  "releases a non-resumable %s-lane wait after lifecycle rotation",
  async (lane) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    const runId = `rotated-${lane}-lane-run`;
    const { controller, queuedTasks } = createQueuedLaneController(runId);
    const queuedResult =
      lane === "global"
        ? controller.enqueueGlobal(async () => ({ meta: { durationMs: 1 } }))
        : controller.enqueueSession(async () => ({ meta: { durationMs: 1 } }));

    now.mockReturnValue(1_000);
    expect(sweepStaleRunContexts(500)).toBe(0);
    rotateAgentEventLifecycleGeneration();
    now.mockReturnValue(1_501);
    expect(sweepStaleRunContexts(500)).toBe(1);
    const rejection = queuedResult.catch((error: unknown) => error);
    await queuedTasks.shift()?.();
    await expect(rejection).resolves.toMatchObject({
      name: "AbortError",
      message: "Agent run belongs to a stale gateway lifecycle",
    });
  },
);
