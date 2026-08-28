import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { claimAgentRunContext, getAgentRunContext } from "../../../infra/agent-run-registry.js";
import type { CommandQueueEnqueueOptions } from "../../../process/command-queue.types.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type LaneParams = RunEmbeddedAgentParams & { sessionFile: string };

const completedResult: EmbeddedAgentRunResult = {
  payloads: [],
  meta: {
    durationMs: 0,
    agentMeta: { sessionId: "session-1", provider: "openai", model: "gpt-test" },
  },
};

function deferredTaskQueue() {
  let release: (() => void) | undefined;
  const enqueue = vi.fn(
    async <T>(task: () => Promise<T>, _options?: CommandQueueEnqueueOptions): Promise<T> =>
      await new Promise<T>((resolve, reject) => {
        release = () => {
          void task().then(resolve, reject);
        };
      }),
  );
  return {
    enqueue,
    release: () => {
      if (!release) {
        throw new Error("Expected queued task release callback");
      }
      release();
    },
  };
}

function createController(options: {
  lifecycleGeneration: string;
  initialQueuedLifecycleGeneration?: string;
  enqueue?: LaneParams["enqueue"];
  trigger?: LaneParams["trigger"];
  abortSignal?: AbortSignal;
  runId?: string;
  params?: Pick<LaneParams, "agentId" | "sessionKey">;
}) {
  let lifecycleGeneration = options.lifecycleGeneration;
  const runId = options.runId ?? "run-1";
  let params: LaneParams = {
    admittedRunContext: createTestAdmittedRunContext(runId),
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: "agent:main:session-1",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 30_000,
    runId,
    lifecycleGeneration,
    trigger: options.trigger,
    enqueue: options.enqueue,
    abortSignal: options.abortSignal,
    ...options.params,
  };
  const controller = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
    globalLane: "global-lane",
    initialQueuedLifecycleGeneration:
      options.initialQueuedLifecycleGeneration ?? lifecycleGeneration,
    sessionLane: "session:agent:main:session-1",
    setLifecycleGeneration: (next) => {
      lifecycleGeneration = next;
    },
    setParams: (next) => {
      params = next;
    },
  });
  return {
    controller,
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
  };
}

describe("createEmbeddedRunLaneController lifecycle admission", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  it.each([
    { trigger: "user" as const, expected: "foreground" },
    { trigger: "cron" as const, expected: "background" },
  ])("marks $trigger session work as $expected", async ({ trigger, expected }) => {
    const priorities: Array<CommandQueueEnqueueOptions["priority"]> = [];
    const enqueue: LaneParams["enqueue"] = async (task, options) => {
      priorities.push(options?.priority);
      return await task();
    };
    const generation = getAgentEventLifecycleGeneration();
    const { controller } = createController({ lifecycleGeneration: generation, enqueue, trigger });

    await controller.enqueueSession(async () => undefined);

    expect(priorities).toEqual([expected]);
  });

  it("preserves the selected agent for sessionless admitted runtime events", async () => {
    const runId = "sessionless-owned-run";
    const { controller } = createController({
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      enqueue: async (task) => await task(),
      runId,
      params: { agentId: "research", sessionKey: undefined },
    });
    const events: Array<{ agentId?: string; sessionKey?: string }> = [];
    const unsubscribe = onAgentRuntimeEvent((event) => events.push(event));

    try {
      await controller.enqueueGlobal(async () => {
        emitAgentEvent({ runId, stream: "assistant", data: { delta: "owned progress" } });
        return completedResult;
      });

      expect(getAgentRunContext(runId)).toMatchObject({ agentId: "research" });
      expect(getAgentRunContext(runId)?.sessionKey).toBeUndefined();
      expect(events).toMatchObject([{ agentId: "research", sessionKey: undefined }]);
    } finally {
      unsubscribe();
    }
  });

  it("rebinds foreground work that was queued before lifecycle rotation", async () => {
    const queue = deferredTaskQueue();
    const generation = getAgentEventLifecycleGeneration();
    const state = createController({
      lifecycleGeneration: generation,
      enqueue: queue.enqueue as LaneParams["enqueue"],
      trigger: "user",
      runId: "queued-across-restart",
    });
    const run = state.controller.enqueueGlobal(async () => completedResult);

    const currentGeneration = rotateAgentEventLifecycleGeneration();
    queue.release();
    await run;

    expect(state.getLifecycleGeneration()).toBe(currentGeneration);
    expect(state.getParams().lifecycleGeneration).toBe(currentGeneration);
    expect(getAgentRunContext("queued-across-restart")).toMatchObject({
      lifecycleGeneration: currentGeneration,
    });
  });

  it("rejects background work queued across lifecycle rotation", async () => {
    const queue = deferredTaskQueue();
    const generation = getAgentEventLifecycleGeneration();
    const { controller } = createController({
      lifecycleGeneration: generation,
      enqueue: queue.enqueue as LaneParams["enqueue"],
      trigger: "cron",
      runId: "background-across-restart",
    });
    const run = controller.enqueueGlobal(async () => completedResult);

    rotateAgentEventLifecycleGeneration();
    queue.release();

    await expect(run).rejects.toMatchObject({
      name: "AbortError",
      message: "Agent run belongs to a stale gateway lifecycle",
    });
    expect(getAgentRunContext("background-across-restart")).toBeUndefined();
  });

  it("does not claim a rebound generation after queued work was aborted", async () => {
    const queue = deferredTaskQueue();
    const abortController = new AbortController();
    const generation = getAgentEventLifecycleGeneration();
    const { controller } = createController({
      lifecycleGeneration: generation,
      enqueue: queue.enqueue as LaneParams["enqueue"],
      trigger: "user",
      runId: "aborted-across-restart",
      abortSignal: abortController.signal,
    });
    const run = controller.enqueueGlobal(async () => completedResult);

    rotateAgentEventLifecycleGeneration();
    abortController.abort();
    queue.release();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(getAgentRunContext("aborted-across-restart")).toBeUndefined();
  });

  it("rejects stale descendants admitted only after lifecycle rotation", async () => {
    const staleGeneration = getAgentEventLifecycleGeneration();
    const currentGeneration = rotateAgentEventLifecycleGeneration();
    const enqueue: LaneParams["enqueue"] = async (task) => await task();
    const { controller } = createController({
      lifecycleGeneration: staleGeneration,
      initialQueuedLifecycleGeneration: currentGeneration,
      enqueue,
      trigger: "user",
      runId: "stale-descendant",
    });

    await expect(controller.enqueueGlobal(async () => completedResult)).rejects.toMatchObject({
      name: "AbortError",
      message: "Agent run belongs to a stale gateway lifecycle",
    });
    expect(getAgentRunContext("stale-descendant")).toBeUndefined();
  });

  it("does not replace a newer same-id run context", async () => {
    const staleGeneration = getAgentEventLifecycleGeneration();
    const currentGeneration = rotateAgentEventLifecycleGeneration();
    claimAgentRunContext("shared-run", {
      sessionKey: "new-session-key",
      sessionId: "new-session",
      lifecycleGeneration: currentGeneration,
    });
    const enqueue: LaneParams["enqueue"] = async (task) => await task();
    const { controller } = createController({
      lifecycleGeneration: staleGeneration,
      initialQueuedLifecycleGeneration: staleGeneration,
      enqueue,
      trigger: "user",
      runId: "shared-run",
    });

    await expect(controller.enqueueGlobal(async () => completedResult)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(getAgentRunContext("shared-run")).toMatchObject({
      sessionKey: "new-session-key",
      sessionId: "new-session",
      lifecycleGeneration: currentGeneration,
    });
  });
});
