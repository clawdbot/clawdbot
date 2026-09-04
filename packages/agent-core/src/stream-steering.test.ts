import { setImmediate } from "node:timers/promises";
import type {
  AssistantMessage,
  Message,
  Model,
  StreamOptions,
  UserMessage,
} from "@openclaw/llm-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { Agent } from "./agent.js";
import { createAssistantMessageEventStream } from "./llm.js";
import type { AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "./types.js";

const model: Model = {
  id: "steerable-model",
  name: "Steerable model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 2,
  };
}

function createSteerableAgent(
  steer: (messages: readonly UserMessage[]) => Promise<boolean>,
  options: {
    steeringMode?: "one-at-a-time" | "all";
    convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
    transformContext?: AgentLoopConfig["transformContext"];
    tools?: AgentTool[];
    needsContinuation?: () => boolean;
  } = {},
) {
  const started = createDeferred();
  const requests: Message[][] = [];
  const firstResponse = createAssistantMessageEventStream();
  let disconnect: ReturnType<NonNullable<StreamOptions["onActiveResponse"]>>;
  const streamFn: StreamFn = (_model, context, streamOptions) => {
    requests.push([...context.messages]);
    if (requests.length === 1) {
      disconnect = streamOptions?.onActiveResponse?.({
        steer,
        needsContinuation: options.needsContinuation,
      });
      firstResponse.push({ type: "start", partial: assistant("") });
      started.resolve();
      return firstResponse;
    }
    const response = createAssistantMessageEventStream();
    response.push({ type: "done", reason: "stop", message: assistant("updated answer") });
    response.end();
    return response;
  };
  const agent = new Agent({ initialState: { model, tools: options.tools }, streamFn, ...options });
  return {
    agent,
    requests,
    firstResponse,
    started: started.promise,
    finish(message = assistant("original answer")) {
      disconnect?.();
      firstResponse.push({ type: "done", reason: "stop", message });
      firstResponse.end();
    },
    fail() {
      disconnect?.();
      firstResponse.push({
        type: "error",
        reason: "error",
        error: { ...assistant(""), stopReason: "error", errorMessage: "provider failed" },
      });
      firstResponse.end();
    },
  };
}

describe("active response steering", () => {
  it("projects live steering through the same context hook as the next request", async () => {
    const submitted = createDeferred();
    const steer = vi.fn(async () => {
      submitted.resolve();
      return true;
    });
    const harness = createSteerableAgent(steer, {
      transformContext: async (messages) =>
        messages.map((message) =>
          message.role === "user"
            ? { ...message, content: `Projected: ${JSON.stringify(message.content)}` }
            : message,
        ),
    });
    const run = harness.agent.prompt("original question");
    await harness.started;
    const update: UserMessage = { role: "user", content: "change direction", timestamp: 3 };
    harness.agent.steer(update);
    await submitted.promise;
    harness.finish();
    await run;
    expect(steer).toHaveBeenCalledWith([harness.requests[1]?.at(-1)]);
    expect(harness.requests[1]?.at(-1)).toMatchObject({
      role: "user",
      content: 'Projected: "change direction"',
    });
    expect(harness.agent.state.messages).toContain(update);
  });

  it("finishes an accepted batch before injecting later updates in all mode", async () => {
    const steer = vi.fn<(messages: readonly UserMessage[]) => Promise<boolean>>(async () => true);
    const harness = createSteerableAgent(steer, {
      steeringMode: "all",
      transformContext: async (messages) => {
        let userTurn = 0;
        return messages.map((message) =>
          message.role === "user"
            ? { ...message, content: `Turn ${++userTurn}: ${JSON.stringify(message.content)}` }
            : message,
        );
      },
    });
    const run = harness.agent.prompt("original question");
    await harness.started;
    harness.agent.steer({ role: "user", content: "first update", timestamp: 3 });
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    harness.agent.steer({ role: "user", content: "second update", timestamp: 4 });
    await setImmediate();
    harness.finish();
    await run;
    expect(steer).toHaveBeenCalledExactlyOnceWith([harness.requests[1]?.at(-1)]);
    expect(harness.requests[1]?.at(-1)).toMatchObject({ content: 'Turn 2: "first update"' });
    expect(harness.requests[2]?.at(-1)).toMatchObject({ content: 'Turn 3: "second update"' });
  });

  it.each([false, true])(
    "queues incompatible context after accepted input=%s",
    async (acceptedInput) => {
      const projected = createDeferred();
      const steer = vi.fn(async () => true);
      const update: UserMessage = { role: "user", content: "change direction", timestamp: 3 };
      const harness = createSteerableAgent(steer, {
        steeringMode: "all",
        transformContext: async (messages) => {
          if (messages.includes(update)) {
            projected.resolve();
            return messages.filter((message) => message === update);
          }
          return messages;
        },
      });
      const run = harness.agent.prompt("original question");
      await harness.started;
      const earlier: UserMessage = { role: "user", content: "accepted update", timestamp: 2 };
      if (acceptedInput) {
        harness.agent.steer(earlier);
        await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
      }
      harness.agent.steer(update);
      await setImmediate();
      harness.finish();
      await run;
      await projected.promise;
      expect(steer).toHaveBeenCalledTimes(acceptedInput ? 1 : 0);
      if (acceptedInput) {
        expect(harness.requests[1]?.at(-1)).toBe(earlier);
      }
      expect(harness.requests[acceptedInput ? 2 : 1]).toEqual([update]);
    },
  );

  it.each(["abort", "error"] as const)(
    "releases admitted input for cancellation after the run ends with %s",
    async (terminal) => {
      const admitted = createDeferred();
      const harness = createSteerableAgent(async () => {
        admitted.resolve();
        return true;
      });
      const run = harness.agent.prompt("original question");
      await harness.started;
      const update: UserMessage = { role: "user", content: "recoverable update", timestamp: 3 };
      harness.agent.steer(update);
      await admitted.promise;
      expect(harness.agent.cancelSteeringMessage((message) => message === update)).toBeUndefined();
      if (terminal === "abort") {
        harness.agent.abort();
        harness.finish();
      } else {
        harness.fail();
      }
      await run;
      expect(harness.agent.state.messages).not.toContain(update);
      expect(harness.agent.hasQueuedMessages()).toBe(true);
      expect(harness.agent.cancelSteeringMessage((message) => message === update)).toBe(update);
      expect(harness.agent.hasQueuedMessages()).toBe(false);
    },
  );
  it("continues after an automatic response when transport still owns deferred tool input", async () => {
    let deferredInput = false;
    const needsContinuation = vi.fn(() => deferredInput);
    const harness = createSteerableAgent(async () => true, { needsContinuation });
    const run = harness.agent.prompt("original question");
    await harness.started;
    deferredInput = true;
    harness.finish();
    await run;
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]?.at(-1)).toMatchObject({ role: "assistant" });
    expect(needsContinuation).toHaveBeenCalledOnce();
    expect(harness.agent.state.messages.at(-1)).toMatchObject({
      content: [{ type: "text", text: "updated answer" }],
    });
  });
  it.each(["one-at-a-time", "all"] as const)(
    "keeps a drained %s steering batch ahead of later input while an async call settles",
    async (steeringMode) => {
      const submitted = createDeferred();
      const skipped = createDeferred();
      const steer = vi.fn(async () => {
        submitted.resolve();
        return true;
      });
      const execute = vi.fn(async () => ({ content: [], details: {} }));
      const harness = createSteerableAgent(steer, {
        steeringMode,
        tools: [
          {
            name: "lookup",
            label: "Lookup",
            description: "Lookup",
            parameters: Type.Object({}),
            execute,
          },
        ],
      });
      harness.agent.subscribe((event) => {
        if (event.type === "tool_execution_end") {
          skipped.resolve();
        }
      });
      const run = harness.agent.prompt("original question");
      await harness.started;
      const first: UserMessage = { role: "user", content: "first update", timestamp: 3 };
      const second: UserMessage = { role: "user", content: "second update", timestamp: 4 };
      harness.agent.steer(first);
      await submitted.promise;
      const toolCall = {
        type: "toolCall" as const,
        id: "call_1",
        name: "lookup",
        arguments: {},
        async: true as const,
      };
      const partial = { ...assistant(""), content: [toolCall] };
      harness.firstResponse.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
      await skipped.promise;
      harness.agent.steer(second);
      await setImmediate();
      expect(steer).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      harness.finish({
        ...assistant("original answer"),
        content: [toolCall, { type: "text", text: "original answer" }],
      });
      await run;
      expect(harness.requests[1]?.at(-1)).toBe(first);
      expect(harness.requests[2]?.at(-1)).toBe(second);
    },
  );
  it("sends queued input before generation ends and commits it once at the normal boundary", async () => {
    const submitted = createDeferred();
    const steer = vi.fn(async () => {
      submitted.resolve();
      return true;
    });
    const harness = createSteerableAgent(steer);
    const run = harness.agent.prompt("original question");
    await harness.started;
    const update: UserMessage = { role: "user", content: "change direction", timestamp: 3 };
    const later: UserMessage = { role: "user", content: "later update", timestamp: 4 };
    harness.agent.steer(update);
    await submitted.promise;
    expect(steer).toHaveBeenCalledWith([update]);
    expect(harness.agent.state.messages).not.toContain(update);

    harness.agent.steer(later);
    await setImmediate();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(harness.agent.cancelSteeringMessage((message) => message === update)).toBeUndefined();
    harness.agent.clearSteeringQueue();
    harness.finish();
    await run;

    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]?.at(-1)).toBe(update);
    expect(harness.agent.state.messages.filter((message) => message === update)).toHaveLength(1);
    expect(harness.agent.state.messages).not.toContain(later);
    expect(harness.agent.hasQueuedMessages()).toBe(false);
    harness.agent.steer({ role: "user", content: "next run", timestamp: 5 });
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it("allows cancellation after definite rejection but fences cancellation during admission", async () => {
    const submitted = createDeferred();
    const decision = createDeferred<boolean>();
    const steer = vi.fn(async () => {
      submitted.resolve();
      return decision.promise;
    });
    const harness = createSteerableAgent(steer, { steeringMode: "all" });
    const run = harness.agent.prompt("original question");
    await harness.started;
    const update: UserMessage = { role: "user", content: "optional update", timestamp: 3 };
    harness.agent.steer(update);
    await submitted.promise;
    expect(harness.agent.cancelSteeringMessage((message) => message === update)).toBeUndefined();
    decision.resolve(false);
    await setImmediate();
    const later: UserMessage = { role: "user", content: "later update", timestamp: 4 };
    harness.agent.steer(later);
    await setImmediate();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(harness.agent.cancelSteeringMessage((message) => message === update)).toBe(update);
    harness.finish();
    await run;
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]?.at(-1)).toBe(later);
    expect(harness.agent.state.messages).not.toContain(update);
  });

  it("does not submit input after abort wins an awaited conversion", async () => {
    const converting = createDeferred();
    const converted = createDeferred<Message[]>();
    const steer = vi.fn(async () => true);
    const update: UserMessage = { role: "user", content: "late update", timestamp: 3 };
    const harness = createSteerableAgent(steer, {
      convertToLlm: (messages) => {
        if (messages.includes(update)) {
          converting.resolve();
          return converted.promise;
        }
        return messages as Message[];
      },
    });
    const run = harness.agent.prompt("original question");
    await harness.started;
    harness.agent.steer(update);
    await converting.promise;
    harness.agent.abort();
    converted.resolve([...harness.requests.flat(), update]);
    harness.finish();
    await run;
    expect(steer).not.toHaveBeenCalled();
    expect(harness.agent.cancelSteeringMessage((message) => message === update)).toBe(update);
  });
});
