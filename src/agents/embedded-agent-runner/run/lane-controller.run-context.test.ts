import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  registerAgentRunContext,
  resetAgentEventsForTest,
  sweepStaleRunContexts,
} from "../../../infra/agent-events.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type LaneParams = RunEmbeddedAgentParams & { sessionFile: string };

beforeEach(() => resetAgentEventsForTest());
afterEach(() => vi.restoreAllMocks());

test("keeps run context active until every overlapping enqueue is admitted", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  const runId = "overlapping-queued-run";
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
      queuedTasks.push(() => task().then(resolve, reject));
    });
  let params: LaneParams = {
    enqueue,
    prompt: "test",
    runId,
    sessionFile: `/tmp/${runId}.jsonl`,
    sessionId: `${runId}-session`,
    sessionKey,
    timeoutMs: 60_000,
    workspaceDir: "/tmp",
  };
  const controller = createEmbeddedRunLaneController({
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
