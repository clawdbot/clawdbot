import { beforeEach, expect, test, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  getAgentRunContext,
  registerAgentRunContext,
  resetAgentEventsForTest,
  sweepStaleRunContexts,
} from "../../../infra/agent-events.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type LaneParams = RunEmbeddedAgentParams & { sessionFile: string };

beforeEach(() => {
  resetAgentEventsForTest();
});

function createDeferredEnqueue() {
  const queuedTasks: Array<() => Promise<void>> = [];
  const enqueue: CommandQueueEnqueueFn = <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queuedTasks.push(async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  return { enqueue, queuedTasks };
}

function createController(
  runId: string,
  lifecycleGeneration: string,
  enqueue: CommandQueueEnqueueFn,
) {
  let params: LaneParams = {
    enqueue,
    prompt: "test",
    runId,
    sessionFile: `/tmp/${runId}.jsonl`,
    sessionId: `${runId}-session`,
    sessionKey: `session-${runId}`,
    timeoutMs: 60_000,
    workspaceDir: "/tmp",
  };
  return createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
    globalLane: "subagent",
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    sessionLane: `session:${runId}`,
    setLifecycleGeneration: () => {},
    setParams: (nextParams) => {
      params = nextParams;
    },
  });
}

test("does not count command-lane queue wait against run-context inactivity", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  const runId = "queued-run";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  registerAgentRunContext(runId, {
    lifecycleGeneration,
    registeredAt: Date.now(),
    sessionKey: "session-queued-run",
  });

  const { enqueue, queuedTasks } = createDeferredEnqueue();
  const controller = createController(runId, lifecycleGeneration, enqueue);
  const result: EmbeddedAgentRunResult = { meta: { durationMs: 0 } };
  const queuedResult = controller.enqueueGlobal(async () => result);

  now.mockReturnValue(1_000);
  expect(sweepStaleRunContexts(500)).toBe(0);
  expect(getAgentRunContext(runId)).toBeDefined();

  const startQueuedTask = queuedTasks.shift();
  expect(startQueuedTask).toBeDefined();
  await startQueuedTask?.();
  await expect(queuedResult).resolves.toBe(result);

  now.mockReturnValue(1_499);
  expect(sweepStaleRunContexts(500)).toBe(0);
  now.mockReturnValue(1_501);
  expect(sweepStaleRunContexts(500)).toBe(1);
  now.mockRestore();
});

test("keeps run context active until every overlapping enqueue is admitted", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  const runId = "overlapping-queued-run";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  registerAgentRunContext(runId, {
    lifecycleGeneration,
    registeredAt: Date.now(),
    sessionKey: "session-overlapping-queued-run",
  });

  const { enqueue, queuedTasks } = createDeferredEnqueue();
  const controller = createController(runId, lifecycleGeneration, enqueue);
  const firstResult: EmbeddedAgentRunResult = { meta: { durationMs: 1 } };
  const secondResult: EmbeddedAgentRunResult = { meta: { durationMs: 2 } };
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
  expect(getAgentRunContext(runId)).toBeDefined();

  const startSecondTask = queuedTasks.shift();
  expect(startSecondTask).toBeDefined();
  await startSecondTask?.();
  await expect(secondQueuedResult).resolves.toBe(secondResult);

  now.mockReturnValue(2_499);
  expect(sweepStaleRunContexts(500)).toBe(0);
  now.mockReturnValue(2_501);
  expect(sweepStaleRunContexts(500)).toBe(1);
  now.mockRestore();
});
