import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { claimAgentRunContext, getAgentRunContext } from "../../../infra/agent-run-registry.js";
import type { CommandQueueEnqueueOptions } from "../../../process/command-queue.types.js";
import { createAgentExecutionAttribution } from "../../agent-execution-attribution.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import {
  bindEmbeddedRunAccountingObservers,
  resolveEmbeddedRunAccountingObservers,
} from "./accounting-observers.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./internal-params.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";

type LaneParams = RunEmbeddedAgentParamsWithSessionFile;

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
  attribution?: LaneParams["attribution"];
  runId?: string;
}) {
  let lifecycleGeneration = options.lifecycleGeneration;
  let params: LaneParams = {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: "agent:main:session-1",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 30_000,
    runId: options.runId ?? "run-1",
    lifecycleGeneration,
    attribution: options.attribution,
    trigger: options.trigger,
    enqueue: options.enqueue,
    abortSignal: options.abortSignal,
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

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("rebinds foreground work that was queued before lifecycle rotation", async () => {
    const queue = deferredTaskQueue();
    const generation = getAgentEventLifecycleGeneration();
    const attribution = createAgentExecutionAttribution({
      runId: "queued-across-restart",
      lifecycleGeneration: generation,
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      agentId: "main",
    });
    const state = createController({
      lifecycleGeneration: generation,
      enqueue: queue.enqueue as LaneParams["enqueue"],
      trigger: "user",
      runId: "queued-across-restart",
      attribution,
    });
    const observers = { onAgentSubmission: () => ({ settle: () => {} }) };
    bindEmbeddedRunAccountingObservers(state.getParams(), observers);
    const run = state.controller.enqueueGlobal(async () => completedResult);

    const currentGeneration = rotateAgentEventLifecycleGeneration();
    queue.release();
    await run;

    expect(state.getLifecycleGeneration()).toBe(currentGeneration);
    expect(state.getParams().lifecycleGeneration).toBe(currentGeneration);
    expect(resolveEmbeddedRunAccountingObservers(state.getParams())).toBe(observers);
    expect(state.getParams().attribution).toEqual({
      ...attribution,
      lifecycleGeneration: currentGeneration,
    });
    expect(state.getParams().attribution).not.toBe(attribution);
    expect(Object.isFrozen(state.getParams().attribution)).toBe(true);
    expect(getAgentRunContext("queued-across-restart")).toMatchObject({
      attribution: state.getParams().attribution,
      lifecycleGeneration: currentGeneration,
    });
  });

  it("rejects registry attribution recovery without explicit internal attribution", async () => {
    const queue = deferredTaskQueue();
    const generation = getAgentEventLifecycleGeneration();
    const attribution = createAgentExecutionAttribution({
      runId: "attributed-across-restart",
      lifecycleGeneration: generation,
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      agentId: "main",
    });
    claimAgentRunContext(attribution.runId, {
      attribution,
      ...(attribution.sessionKey ? { sessionKey: attribution.sessionKey } : {}),
      ...(attribution.sessionId ? { sessionId: attribution.sessionId } : {}),
      ...(attribution.agentId ? { agentId: attribution.agentId } : {}),
      lifecycleGeneration: generation,
    });
    const state = createController({
      lifecycleGeneration: generation,
      enqueue: queue.enqueue as LaneParams["enqueue"],
      trigger: "user",
      runId: attribution.runId,
    });
    const run = state.controller.enqueueGlobal(async () => completedResult);

    queue.release();

    await expect(run).rejects.toThrow(
      "Agent run ID is already bound to host-owned execution attribution.",
    );
    expect(state.getParams().attribution).toBeUndefined();
    expect(getAgentRunContext(attribution.runId)).toMatchObject({
      attribution,
      lifecycleGeneration: generation,
    });
  });

  it("rejects different explicit attribution for a live run ID", async () => {
    const generation = getAgentEventLifecycleGeneration();
    const existingAttribution = createAgentExecutionAttribution({
      runId: "attribution-mismatch",
      lifecycleGeneration: generation,
    });
    const replacementAttribution = createAgentExecutionAttribution({
      runId: existingAttribution.runId,
      lifecycleGeneration: generation,
    });
    claimAgentRunContext(existingAttribution.runId, {
      attribution: existingAttribution,
      lifecycleGeneration: generation,
    });
    const state = createController({
      lifecycleGeneration: generation,
      trigger: "user",
      runId: existingAttribution.runId,
      attribution: replacementAttribution,
    });

    await expect(state.controller.enqueueGlobal(async () => completedResult)).rejects.toThrow(
      "Agent run ID is already bound to different execution attribution.",
    );
    expect(getAgentRunContext(existingAttribution.runId)?.attribution).toBe(existingAttribution);
  });

  it("preserves absent attribution identity when queued foreground work rebinds", async () => {
    const queue = deferredTaskQueue();
    const generation = getAgentEventLifecycleGeneration();
    const attribution = createAgentExecutionAttribution({
      runId: "queued-sparse-attribution",
      lifecycleGeneration: generation,
    });
    const state = createController({
      lifecycleGeneration: generation,
      enqueue: queue.enqueue as LaneParams["enqueue"],
      trigger: "user",
      runId: "queued-sparse-attribution",
      attribution,
    });
    const run = state.controller.enqueueGlobal(async () => completedResult);

    const currentGeneration = rotateAgentEventLifecycleGeneration();
    queue.release();
    await run;

    expect(state.getParams().attribution).toEqual({
      ...attribution,
      lifecycleGeneration: currentGeneration,
    });
    expect(state.getParams().attribution?.executionId).toBe(attribution.executionId);
    expect(state.getParams().attribution?.contextId).toBe(attribution.contextId);
    expect(state.getParams().attribution).not.toHaveProperty("sessionKey");
    expect(state.getParams().attribution).not.toHaveProperty("sessionId");
    expect(state.getParams().attribution).not.toHaveProperty("agentId");
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
