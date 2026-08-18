// Agent Core tests cover agent loop behavior.
import { EventStream } from "@openclaw/ai/event-stream";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { agentLoop, agentLoopContinue, runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import { Agent } from "./agent.js";
import { TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE, TranscriptNotContinuableError } from "./errors.js";
import {
  attachInternalSyncSteeringGetter,
  attachInternalToolBatchLifecycle,
  attachInternalToolExecutionPreparer,
  setInternalBeforeToolBatch,
  takeInternalToolBatchLifecycle,
} from "./internal-hooks.js";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
} from "./llm.js";
import {
  getAgentToolExecutionContext,
  type AgentToolExecutionContext,
} from "./tool-execution-context.js";
import type {
  AfterToolOutcomeContext,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const config: AgentLoopConfig = {
  model,
  convertToLlm: (messages) => messages as Message[],
};

const TEST_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const failingStreamFn: StreamFn = async () => {
  throw new Error("provider exploded");
};

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function expectTerminalFailure(events: AgentEvent[], result: AgentMessage[]): void {
  expect(events.map((event) => event.type)).toContain("agent_end");
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    role: "assistant",
    stopReason: "error",
    errorMessage: "provider exploded",
  });
}

describe("internal tool batch lifecycle", () => {
  it("binds lifecycle state to one exact admission result and consumes it once", () => {
    const result = {};
    const lifecycle = {
      commitReadyCalls: vi.fn(),
      releaseSkippedCalls: vi.fn(),
    };

    expect(attachInternalToolBatchLifecycle(result, lifecycle)).toBe(result);
    expect(takeInternalToolBatchLifecycle(result)).toBe(lifecycle);
    expect(takeInternalToolBatchLifecycle(result)).toBeUndefined();
    expect(takeInternalToolBatchLifecycle({})).toBeUndefined();
  });
});

describe("agentLoop EventStream failures", () => {
  it("ends the public stream when a new prompt run rejects", async () => {
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      undefined,
      failingStreamFn,
    );
    expect(stream).toBeInstanceOf(EventStream);

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });

  it("ends the public stream when a continue run rejects", async () => {
    const context: AgentContext = {
      systemPrompt: "",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    const stream = agentLoopContinue(context, config, undefined, failingStreamFn);

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });

  it("persists and replays interruption guidance after Agent aborts a rejected run", async () => {
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const agent = new Agent({
      initialState: { model },
      convertToLlm: (messages) =>
        messages.filter(
          (message): message is Message =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult",
        ),
      streamFn: async (_model, _context, options) => {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("provider aborted")), {
            once: true,
          });
        });
        throw new Error("unreachable");
      },
    });

    const interrupted = agent.prompt("perform side effect");
    await started;
    agent.abort();
    await interrupted;

    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "custom",
      customType: "openclaw:turn-aborted",
    });

    let replayedMessages: Message[] = [];
    let transformedMessages: AgentMessage[] = [];
    agent.transformContext = async (messages) => {
      transformedMessages = messages;
      return messages;
    };
    agent.streamFn = async (_model, context) => {
      replayedMessages = context.messages;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "continued safely" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: TEST_USAGE,
            stopReason: "stop",
            timestamp: 2,
          },
        });
        stream.end();
      });
      return stream;
    };
    await agent.prompt("continue");

    expect(transformedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "custom",
          customType: "openclaw:turn-aborted",
        }),
      ]),
    );
    expect(replayedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("may have partially executed"),
            }),
          ]),
        }),
      ]),
    );
  });
});

describe("agentLoop continuation guards", () => {
  const assistantTailContext: AgentContext = {
    systemPrompt: "",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: TEST_USAGE,
        stopReason: "stop",
        timestamp: 1,
      },
    ],
  };

  it("throws a coded error from the public continue stream guard", () => {
    expect(() => agentLoopContinue(assistantTailContext, config)).toThrowError(
      TranscriptNotContinuableError,
    );
    try {
      agentLoopContinue(assistantTailContext, config);
    } catch (error) {
      expect(error).toMatchObject({
        code: TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE,
        role: "assistant",
      });
    }
  });

  it("throws a coded error from the async continue runner guard", async () => {
    await expect(
      runAgentLoopContinue(assistantTailContext, config, async () => undefined),
    ).rejects.toMatchObject({
      code: TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE,
      role: "assistant",
    });
  });

  it("throws a coded error from Agent.continue", async () => {
    const agent = new Agent({
      initialState: { messages: assistantTailContext.messages },
      streamFn: failingStreamFn,
    });

    await expect(agent.continue()).rejects.toMatchObject({
      code: TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE,
      role: "assistant",
    });
  });

  it("delivers a queued follow-up before continuing from a tool result", async () => {
    let requestContext: Context | undefined;
    const streamFn: StreamFn = (activeModel, context) => {
      requestContext = context;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: activeModel.api,
            provider: activeModel.provider,
            model: activeModel.id,
            usage: TEST_USAGE,
            stopReason: "stop",
            timestamp: 3,
          },
        });
        stream.end();
      });
      return stream;
    };
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: "",
        tools: [],
        messages: [
          {
            role: "toolResult",
            toolCallId: "call-finish",
            toolName: "finish",
            content: [{ type: "text", text: "finished" }],
            details: {},
            isError: false,
            timestamp: 1,
          },
        ],
      },
      convertToLlm: (messages) => messages as Message[],
      streamFn,
    });
    agent.followUp({ role: "user", content: "queued after end", timestamp: 2 });

    await agent.continue();

    expect(requestContext?.messages.at(-1)).toMatchObject({
      role: "user",
      content: "queued after end",
    });
  });

  it("keeps a queued follow-up behind a trailing user continuation", async () => {
    const requestContexts: Context[] = [];
    const streamFn: StreamFn = (activeModel, context) => {
      requestContexts.push(context);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `answer ${requestContexts.length}` }],
            api: activeModel.api,
            provider: activeModel.provider,
            model: activeModel.id,
            usage: TEST_USAGE,
            stopReason: "stop",
            timestamp: requestContexts.length + 1,
          },
        });
        stream.end();
      });
      return stream;
    };
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: "",
        tools: [],
        messages: [{ role: "user", content: "retry this turn", timestamp: 1 }],
      },
      convertToLlm: (messages) => messages as Message[],
      streamFn,
    });
    agent.followUp({ role: "user", content: "queued after retry", timestamp: 2 });

    await agent.continue();

    expect(requestContexts).toHaveLength(2);
    expect(requestContexts[0]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: "retry this turn",
    });
    expect(requestContexts[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: "queued after retry",
    });
  });
});

describe("agentLoop streaming updates", () => {
  it("rebuilds assistant message snapshots for text deltas without partial snapshots", async () => {
    const streamFn: StreamFn = async () => {
      const stream = createAssistantMessageEventStream();
      const startMessage: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      };
      const textStartMessage: AssistantMessage = { ...startMessage, content: [] };
      const finalMessage: AssistantMessage = {
        ...startMessage,
        content: [{ type: "text", text: "Hello world" }],
      };

      queueMicrotask(() => {
        stream.push({ type: "start", partial: startMessage });
        stream.push({ type: "text_start", contentIndex: 0, partial: textStartMessage });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello" });
        stream.push({ type: "text_delta", contentIndex: 0, delta: " world" });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: "Hello world",
          partial: finalMessage,
        });
        stream.push({ type: "done", reason: "stop", message: finalMessage });
      });

      return stream;
    };

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      undefined,
      streamFn,
    );
    const events = await collectEvents(stream);

    const deltaUpdates = events.filter(
      (event): event is Extract<AgentEvent, { type: "message_update" }> =>
        event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
    );
    expect(deltaUpdates).toHaveLength(2);
    expect(deltaUpdates.map((event) => event.message)).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    ]);
    for (const update of deltaUpdates) {
      expect(update.assistantMessageEvent).not.toHaveProperty("partial");
    }
  });

  it("does not execute tool calls from a max-token-truncated assistant turn", async () => {
    const execute = vi.fn(
      async (): Promise<AgentToolResult<unknown>> => ({
        content: [{ type: "text", text: "should not run" }],
        details: {},
      }),
    );
    const contexts: Context[] = [];
    let streamCalls = 0;
    const streamFn: StreamFn = async (_model, context) => {
      contexts.push(context);
      streamCalls += 1;
      const stream = createAssistantMessageEventStream();
      if (streamCalls > 1) {
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "continued" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: TEST_USAGE,
          stopReason: "stop",
          timestamp: 2,
        };
        queueMicrotask(() => {
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      }
      const toolCall = {
        type: "toolCall" as const,
        id: "call-truncated-spawn",
        name: "sessions_spawn",
        arguments: {},
      };
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "spawning" }, toolCall],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: TEST_USAGE,
        stopReason: "length",
        timestamp: 1,
      };

      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
        stream.push({
          type: "toolcall_end",
          contentIndex: 1,
          toolCall,
          partial: message,
        });
        stream.push({ type: "done", reason: "length", message });
      });

      return stream;
    };

    const stream = agentLoop(
      [{ role: "user", content: "spawn specialists", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            name: "sessions_spawn",
            label: "sessions_spawn",
            description: "Spawn a child session",
            parameters: Type.Object({}, { additionalProperties: false }),
            execute,
          },
        ],
      },
      {
        ...config,
        getFollowUpMessages: async () =>
          streamCalls === 1 ? [{ role: "user", content: "continue", timestamp: 2 }] : [],
      },
      undefined,
      streamFn,
    );

    const events = await collectEvents(stream);
    const messages = await stream.result();
    const truncatedMessageEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "message_end" }> =>
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "length",
    );
    const replayedTruncatedMessage = contexts[1]?.messages[1];

    if (!truncatedMessageEnd || !replayedTruncatedMessage) {
      throw new Error("expected the truncated assistant message to be emitted and replayed");
    }

    expect(execute).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "length" });
    expect(messages[1]).not.toMatchObject({
      content: expect.arrayContaining([expect.objectContaining({ type: "toolCall" })]),
    });
    expect(truncatedMessageEnd.message).not.toMatchObject({
      content: expect.arrayContaining([expect.objectContaining({ type: "toolCall" })]),
    });
    expect(replayedTruncatedMessage).toMatchObject({ role: "assistant", stopReason: "length" });
    expect(replayedTruncatedMessage).not.toMatchObject({
      content: expect.arrayContaining([expect.objectContaining({ type: "toolCall" })]),
    });
  });
});

describe("runAgentLoop deferred tool hydration", () => {
  it("hydrates an authorized deferred tool for execution and the continuation", async () => {
    const execute = vi.fn(
      async (): Promise<AgentToolResult<unknown>> => ({
        content: [{ type: "text", text: "hidden ok" }],
        details: { ok: true },
      }),
    );
    const hiddenTool: AgentTool = {
      name: "hidden_search",
      label: "hidden_search",
      description: "Hidden search tool",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      execute,
    };
    const contexts: Context[] = [];
    let streamCalls = 0;
    const streamFn: StreamFn = (_model, context) => {
      contexts.push({ ...context, tools: context.tools?.slice() });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        streamCalls += 1;
        const message =
          streamCalls === 1
            ? {
                role: "assistant" as const,
                content: [
                  {
                    type: "toolCall" as const,
                    id: "call-hidden",
                    name: "hidden_search",
                    arguments: { query: "penguin" },
                  },
                ],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "toolUse" as const,
                timestamp: Date.now(),
              }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "done" }],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "stop" as const,
                timestamp: Date.now(),
              };
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
      });
      return stream;
    };
    const resolveDeferredTool = vi.fn(() => hiddenTool);

    const messages = await runAgentLoop(
      [{ role: "user", content: "search penguin", timestamp: Date.now() }],
      { systemPrompt: "test", messages: [], tools: [] },
      {
        model,
        convertToLlm: (agentMessages: AgentMessage[]) => agentMessages as never,
        resolveDeferredTool,
      },
      (_event: AgentEvent) => {},
      undefined,
      streamFn,
    );

    expect(resolveDeferredTool).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      "call-hidden",
      { query: "penguin" },
      undefined,
      expect.any(Function),
    );
    expect(contexts.map((context) => context.tools?.map((tool) => tool.name) ?? [])).toEqual([
      [],
      ["hidden_search"],
    ]);
    expect(messages.some((message) => message.role === "toolResult")).toBe(true);
  });

  it("resolves a missing deferred tool once across pre-scan and preparation", async () => {
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        streamCalls += 1;
        const message =
          streamCalls === 1
            ? {
                role: "assistant" as const,
                content: [
                  {
                    type: "toolCall" as const,
                    id: "call-missing",
                    name: "missing_deferred",
                    arguments: {},
                  },
                ],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "toolUse" as const,
                timestamp: Date.now(),
              }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "done" }],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "stop" as const,
                timestamp: Date.now(),
              };
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
      });
      return stream;
    };
    const resolveDeferredTool = vi.fn(() => undefined);

    const messages = await runAgentLoop(
      [{ role: "user", content: "call missing tool", timestamp: Date.now() }],
      { systemPrompt: "test", messages: [], tools: [] },
      {
        model,
        convertToLlm: (agentMessages: AgentMessage[]) => agentMessages as never,
        resolveDeferredTool,
      },
      (_event: AgentEvent) => {},
      undefined,
      streamFn,
    );

    expect(resolveDeferredTool).toHaveBeenCalledTimes(1);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "missing_deferred",
        isError: true,
      }),
    );
  });

  it("converts deferred resolver failures into one error tool result", async () => {
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        streamCalls += 1;
        const message =
          streamCalls === 1
            ? {
                role: "assistant" as const,
                content: [
                  {
                    type: "toolCall" as const,
                    id: "call-failing-deferred",
                    name: "failing_deferred",
                    arguments: {},
                  },
                ],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "toolUse" as const,
                timestamp: Date.now(),
              }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "done" }],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "stop" as const,
                timestamp: Date.now(),
              };
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
      });
      return stream;
    };
    const resolveDeferredTool = vi.fn(async () => {
      throw new Error("deferred hydration failed");
    });

    const messages = await runAgentLoop(
      [{ role: "user", content: "call failing tool", timestamp: Date.now() }],
      { systemPrompt: "test", messages: [], tools: [] },
      {
        model,
        convertToLlm: (agentMessages: AgentMessage[]) => agentMessages as never,
        resolveDeferredTool,
      },
      (_event: AgentEvent) => {},
      undefined,
      streamFn,
    );

    expect(resolveDeferredTool).toHaveBeenCalledTimes(1);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "failing_deferred",
        isError: true,
        content: [{ type: "text", text: "deferred hydration failed" }],
      }),
    );
  });

  it("rejects deferred tools whose names differ from the requested call", async () => {
    const execute = vi.fn(
      async (): Promise<AgentToolResult<unknown>> => ({
        content: [{ type: "text", text: "wrong tool ran" }],
        details: { ok: true },
      }),
    );
    const mismatchedTool: AgentTool = {
      name: "other_deferred",
      label: "other_deferred",
      description: "Different deferred tool",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute,
    };
    const contexts: Context[] = [];
    let streamCalls = 0;
    const streamFn: StreamFn = (_model, context) => {
      contexts.push({ ...context, tools: context.tools?.slice() });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        streamCalls += 1;
        const message =
          streamCalls === 1
            ? {
                role: "assistant" as const,
                content: [
                  {
                    type: "toolCall" as const,
                    id: "call-requested-deferred",
                    name: "requested_deferred",
                    arguments: {},
                  },
                ],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "toolUse" as const,
                timestamp: Date.now(),
              }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "done" }],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "stop" as const,
                timestamp: Date.now(),
              };
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
      });
      return stream;
    };

    const messages = await runAgentLoop(
      [{ role: "user", content: "call requested tool", timestamp: Date.now() }],
      { systemPrompt: "test", messages: [], tools: [] },
      {
        model,
        convertToLlm: (agentMessages: AgentMessage[]) => agentMessages as never,
        resolveDeferredTool: () => mismatchedTool,
      },
      (_event: AgentEvent) => {},
      undefined,
      streamFn,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(contexts.map((context) => context.tools?.map((tool) => tool.name) ?? [])).toEqual([
      [],
      [],
    ]);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "requested_deferred",
        isError: true,
        content: [
          {
            type: "text",
            text: 'Deferred tool resolver returned "other_deferred" for requested "requested_deferred"',
          },
        ],
      }),
    );
  });

  it("hydrates sequential deferred tools before choosing the executor", async () => {
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    const execute = vi.fn(async (): Promise<AgentToolResult<unknown>> => {
      activeExecutions += 1;
      maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      activeExecutions -= 1;
      return {
        content: [{ type: "text", text: "hidden ok" }],
        details: { ok: true },
      };
    });
    const hiddenTool: AgentTool = {
      name: "hidden_serial",
      label: "hidden_serial",
      description: "Hidden sequential tool",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      executionMode: "sequential",
      execute,
    };
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        streamCalls += 1;
        const message =
          streamCalls === 1
            ? {
                role: "assistant" as const,
                content: [
                  {
                    type: "toolCall" as const,
                    id: "call-hidden-1",
                    name: "hidden_serial",
                    arguments: { query: "one" },
                  },
                  {
                    type: "toolCall" as const,
                    id: "call-hidden-2",
                    name: "hidden_serial",
                    arguments: { query: "two" },
                  },
                ],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "toolUse" as const,
                timestamp: Date.now(),
              }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "done" }],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "stop" as const,
                timestamp: Date.now(),
              };
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    };
    const resolveDeferredTool = vi.fn(() => hiddenTool);

    await runAgentLoop(
      [{ role: "user", content: "search twice", timestamp: Date.now() }],
      { systemPrompt: "test", messages: [], tools: [] },
      {
        model,
        convertToLlm: (agentMessages: AgentMessage[]) => agentMessages as never,
        resolveDeferredTool,
      },
      (_event: AgentEvent) => {},
      undefined,
      streamFn,
    );

    expect(resolveDeferredTool).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(maxActiveExecutions).toBe(1);
  });
});

describe("agentLoop tool termination", () => {
  function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
    return {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
      timestamp: 1,
    };
  }

  function makeTool(name: string, executed: string[]): AgentTool {
    return {
      name,
      label: name,
      description: name,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        executed.push(name);
        return {
          content: [{ type: "text", text: `${name} result` }],
          details: { name },
        };
      },
    };
  }

  function criticalLoopFor(toolCall: { id: string; name: string }) {
    return {
      kind: "critical-tool-loop" as const,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      actionKey: `${toolCall.name}:same-action`,
      detector: "generic_repeat",
      count: 20,
      reason: `CRITICAL: ${toolCall.name} is looping`,
    };
  }

  function createTurnSequenceStream(
    turns: AssistantMessage["content"][],
    requestMessages: Message[][],
  ): StreamFn {
    let turnIndex = 0;
    return (_activeModel, context) => {
      requestMessages.push(context.messages.slice());
      const content = turns[turnIndex];
      turnIndex += 1;
      if (!content) {
        throw new Error(`unexpected provider request ${turnIndex}`);
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage(content);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };
  }

  it("makes a queued steer visible before the next sequential tool starts", async () => {
    const firstReleased = createDeferred();
    const firstStarted = createDeferred();
    const firstExecute = vi.fn(async () => {
      firstStarted.resolve();
      await firstReleased.promise;
      return { content: [{ type: "text" as const, text: "first result" }], details: {} };
    });
    const secondExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "second result" }],
      details: {},
    }));
    const requestMessages: Message[][] = [];
    const streamFn = createTurnSequenceStream(
      [
        [
          { type: "toolCall", id: "call-first", name: "first", arguments: {} },
          { type: "toolCall", id: "call-second", name: "second", arguments: {} },
        ],
        [{ type: "text", text: "handled steer 1" }],
        [{ type: "text", text: "handled steer 2" }],
      ],
      requestMessages,
    );
    const afterToolOutcome = vi.fn(async (_context: AfterToolOutcomeContext) => undefined);
    const commitReadyCalls = vi.fn();
    const releaseSkippedCalls = vi.fn();
    const events: AgentEvent[] = [];
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            ...makeTool("first", []),
            execute: firstExecute,
          },
          {
            ...makeTool("second", []),
            execute: secondExecute,
            resultContentSource: "network",
          },
        ],
      },
      streamFn,
      toolExecution: "sequential",
      afterToolOutcome,
    });
    setInternalBeforeToolBatch(agent, async () =>
      attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls }),
    );
    agent.subscribe((event) => {
      events.push(event);
    });
    const firstSteer = { role: "user" as const, content: "steer one", timestamp: 2 };
    const secondSteer = { role: "user" as const, content: "steer two", timestamp: 3 };

    const run = agent.prompt("start");
    await firstStarted.promise;
    agent.steer(firstSteer);
    agent.steer(secondSteer);
    firstReleased.resolve();
    await run;

    expect(firstExecute).toHaveBeenCalledOnce();
    expect(secondExecute).not.toHaveBeenCalled();
    expect(commitReadyCalls).toHaveBeenCalledExactlyOnceWith([
      { toolCallId: "call-first", args: {} },
    ]);
    expect(releaseSkippedCalls).toHaveBeenCalledWith(["call-second"]);
    expect(requestMessages).toHaveLength(3);
    expect(agent.state.messages.slice(1, 5)).toMatchObject([
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "call-first", isError: false },
      { role: "toolResult", toolCallId: "call-second", isError: true },
      firstSteer,
    ]);
    expect(requestMessages[1]?.slice(-4)).toMatchObject([
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "call-first", isError: false },
      {
        role: "toolResult",
        toolCallId: "call-second",
        isError: true,
        content: [{ type: "text", text: "Skipped due to queued user message." }],
        details: { status: "skipped", deniedReason: "steering" },
      },
      firstSteer,
    ]);
    expect(requestMessages[1]?.at(-1)).toBe(firstSteer);
    expect(requestMessages[1]).not.toContain(secondSteer);
    expect(requestMessages[2]?.at(-1)).toBe(secondSteer);
    const queuedMessageStarts = events.filter(
      (event): event is Extract<AgentEvent, { type: "message_start" }> =>
        event.type === "message_start" && event.message.role === "user",
    );
    expect(queuedMessageStarts.at(-2)?.message).toBe(firstSteer);
    expect(queuedMessageStarts.at(-1)?.message).toBe(secondSteer);
    expect(
      requestMessages[1]?.find((message) => message.role === "toolResult" && message.isError),
    ).not.toHaveProperty("__openclaw");
    expect(afterToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ id: "call-second" }),
        isError: true,
        executionStarted: false,
        result: expect.objectContaining({
          details: { status: "skipped", deniedReason: "steering" },
        }),
      }),
      expect.any(AbortSignal),
    );
    const skippedOutcome = afterToolOutcome.mock.calls.find(
      ([outcome]) => outcome.toolCall.id === "call-second",
    )?.[0];
    expect(skippedOutcome).not.toHaveProperty("errorKind");
    expect(
      events
        .filter((event) => event.type === "tool_execution_start")
        .map((event) => event.toolCallId),
    ).toEqual(["call-first", "call-second"]);
    expect(
      events
        .filter((event) => event.type === "tool_execution_end")
        .map((event) => ({ id: event.toolCallId, started: event.executionStarted })),
    ).toEqual([
      { id: "call-first", started: true },
      { id: "call-second", started: false },
    ]);
    const skippedEnd = events.find(
      (event) => event.type === "tool_execution_end" && event.toolCallId === "call-second",
    );
    expect(skippedEnd).toMatchObject({
      result: { details: { status: "skipped", deniedReason: "steering" } },
    });
    expect(skippedEnd).not.toHaveProperty("errorKind");
  });

  it("uses a private synchronous steer at the scheduler without invoking the public fallback", async () => {
    const steer = { role: "user" as const, content: "redirect", timestamp: 2 };
    let steerReady = false;
    let steerDrained = false;
    const firstExecute = vi.fn(async () => {
      steerReady = true;
      return { content: [], details: {} };
    });
    const secondExecute = vi.fn(async () => ({ content: [], details: {} }));
    const publicGetter = vi.fn(async (): Promise<AgentMessage[]> => {
      throw new Error("public steering fallback should not run");
    });
    const syncGetter = vi.fn((): AgentMessage[] => {
      if (!steerReady || steerDrained) {
        return [];
      }
      steerDrained = true;
      return [steer];
    });
    const getSteeringMessages = attachInternalSyncSteeringGetter(publicGetter, syncGetter);
    const requestMessages: Message[][] = [];

    await runAgentLoop(
      [{ role: "user", content: "start", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          { ...makeTool("first", []), execute: firstExecute },
          { ...makeTool("second", []), execute: secondExecute },
        ],
      },
      { ...config, getSteeringMessages, toolExecution: "sequential" },
      () => {},
      undefined,
      createTurnSequenceStream(
        [
          [
            { type: "toolCall", id: "sync-first", name: "first", arguments: {} },
            { type: "toolCall", id: "sync-second", name: "second", arguments: {} },
          ],
          [{ type: "text", text: "done" }],
        ],
        requestMessages,
      ),
    );

    expect(firstExecute).toHaveBeenCalledOnce();
    expect(secondExecute).not.toHaveBeenCalled();
    expect(requestMessages[1]?.at(-1)).toBe(steer);
    expect(syncGetter).toHaveBeenCalled();
    expect(publicGetter).not.toHaveBeenCalled();
  });

  it("preserves the config receiver for public steering callbacks", async () => {
    const steer = { role: "user" as const, content: "method steer", timestamp: 2 };
    const requestMessages: Message[][] = [];
    const methodConfig = {
      ...config,
      queuedSteering: [steer] as AgentMessage[],
      async getSteeringMessages() {
        return this.queuedSteering.splice(0, 1);
      },
    } satisfies AgentLoopConfig & { queuedSteering: AgentMessage[] };

    await runAgentLoop(
      [{ role: "user", content: "start", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      methodConfig,
      () => {},
      undefined,
      createTurnSequenceStream([[{ type: "text", text: "done" }]], requestMessages),
    );

    expect(requestMessages[0]?.at(-1)).toBe(steer);
    expect(methodConfig.queuedSteering).toEqual([]);
  });

  it("suppresses a tool when steering arrives during private execution preflight", async () => {
    const preflightStarted = createDeferred();
    const releasePreflight = createDeferred();
    const execute = vi.fn(async () => ({ content: [], details: { executed: true } }));
    const dispose = vi.fn();
    const tool = attachInternalToolExecutionPreparer(
      { ...makeTool("delayed", []), execute },
      async () => {
        preflightStarted.resolve();
        await releasePreflight.promise;
        const finalArgs = { rewritten: true };
        return {
          kind: "ready",
          args: finalArgs,
          execute: async (onImplementationStart) => {
            onImplementationStart?.();
            return await execute();
          },
          dispose,
        };
      },
    );
    const requestMessages: Message[][] = [];
    const afterToolOutcome = vi.fn(async () => undefined);
    const commitReadyCalls = vi.fn();
    const releaseSkippedCalls = vi.fn();
    const agent = new Agent({
      initialState: { model, tools: [tool] },
      streamFn: createTurnSequenceStream(
        [
          [{ type: "toolCall", id: "delayed-call", name: "delayed", arguments: {} }],
          [{ type: "text", text: "redirected" }],
        ],
        requestMessages,
      ),
      toolExecution: "sequential",
      afterToolOutcome,
    });
    setInternalBeforeToolBatch(agent, async () =>
      attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls }),
    );
    const steer = { role: "user" as const, content: "redirect", timestamp: 2 };

    const run = agent.prompt("start");
    await preflightStarted.promise;
    agent.steer(steer);
    releasePreflight.resolve();
    await run;

    expect(execute).not.toHaveBeenCalled();
    expect(commitReadyCalls).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(requestMessages[1]?.slice(-3)).toMatchObject([
      { role: "assistant", stopReason: "toolUse" },
      {
        role: "toolResult",
        toolCallId: "delayed-call",
        isError: true,
        details: { status: "skipped", deniedReason: "steering" },
      },
      steer,
    ]);
    expect(afterToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ id: "delayed-call" }),
        args: { rewritten: true },
        executionStarted: false,
      }),
      expect.any(AbortSignal),
    );
  });

  it.each(["sequential", "parallel"] as const)(
    "uses private final args for %s launch facts and hooks",
    async (toolExecution) => {
      const finalArgs = { rewritten: true };
      const execute = vi.fn(async () => ({ content: [], details: { executed: true } }));
      const tool = attachInternalToolExecutionPreparer(
        { ...makeTool("rewritten", []), execute },
        async () => ({
          kind: "ready",
          args: finalArgs,
          execute: async (start) => {
            start?.();
            return await execute();
          },
          dispose: vi.fn(),
        }),
      );
      const afterToolCall = vi.fn(async () => undefined);
      const afterToolOutcome = vi.fn(async () => undefined);
      const commitReadyCalls = vi.fn();
      const agent = new Agent({
        initialState: { model, tools: [tool] },
        streamFn: createTurnSequenceStream(
          [
            [{ type: "toolCall", id: "rewritten-call", name: "rewritten", arguments: {} }],
            [{ type: "text", text: "done" }],
          ],
          [],
        ),
        toolExecution,
        afterToolCall,
        afterToolOutcome,
      });
      setInternalBeforeToolBatch(agent, async () =>
        attachInternalToolBatchLifecycle(
          {},
          {
            commitReadyCalls,
            releaseSkippedCalls: vi.fn(),
          },
        ),
      );

      await agent.prompt("start");

      expect(commitReadyCalls).toHaveBeenCalledExactlyOnceWith([
        { toolCallId: "rewritten-call", args: finalArgs },
      ]);
      expect(afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ args: finalArgs }),
        expect.any(AbortSignal),
      );
      expect(afterToolOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ args: finalArgs, executionStarted: true }),
        expect.any(AbortSignal),
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(
        agent.state.messages.find(
          (message) => message.role === "assistant" && message.stopReason === "toolUse",
        ),
      ).toMatchObject({
        content: [expect.objectContaining({ id: "rewritten-call", arguments: {} })],
      });
    },
  );

  it("disposes private preflight when the steering checkpoint throws", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const dispose = vi.fn();
    const tool = attachInternalToolExecutionPreparer(
      { ...makeTool("cleanup", []), execute },
      async ({ args }) => ({
        kind: "ready",
        args,
        execute: async (onImplementationStart) => {
          onImplementationStart?.();
          return await execute();
        },
        dispose,
      }),
    );
    const getSteeringMessages = vi
      .fn<() => Promise<AgentMessage[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("steering checkpoint failed"));

    await expect(
      runAgentLoop(
        [{ role: "user", content: "start", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [tool] },
        { ...config, toolExecution: "sequential", getSteeringMessages },
        () => {},
        undefined,
        createTurnSequenceStream(
          [[{ type: "toolCall", id: "cleanup-call", name: "cleanup", arguments: {} }]],
          [],
        ),
      ),
    ).rejects.toThrow("steering checkpoint failed");
    expect(execute).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("delivers async steering between tools before shouldStopAfterTurn", async () => {
    const steer = { role: "user" as const, content: "keep going", timestamp: 2 };
    const queued: AgentMessage[] = [];
    const secondExecute = vi.fn(async () => ({ content: [], details: {} }));
    const requestMessages: Message[][] = [];
    const streamFn = createTurnSequenceStream(
      [
        [
          { type: "toolCall", id: "stop-first", name: "first", arguments: {} },
          { type: "toolCall", id: "stop-second", name: "second", arguments: {} },
        ],
        [{ type: "text", text: "continued" }],
      ],
      requestMessages,
    );
    const shouldStopAfterTurn = vi.fn(() => true);

    const getSteeringMessages = vi.fn(async () => queued.splice(0, 1));
    await runAgentLoop(
      [{ role: "user", content: "start", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            ...makeTool("first", []),
            execute: async () => {
              queued.push(steer);
              return { content: [{ type: "text", text: "first result" }], details: {} };
            },
          },
          { ...makeTool("second", []), execute: secondExecute },
        ],
      },
      {
        ...config,
        toolExecution: "sequential",
        getSteeringMessages,
        shouldStopAfterTurn,
      },
      () => {},
      undefined,
      streamFn,
    );

    expect(requestMessages).toHaveLength(2);
    expect(requestMessages[1]?.at(-1)).toBe(steer);
    expect(secondExecute).not.toHaveBeenCalled();
    expect(shouldStopAfterTurn).toHaveBeenCalledOnce();
    expect(getSteeringMessages).toHaveBeenCalled();
  });

  it("delivers steering admitted while the final follow-up drain is pending", async () => {
    const followUpDrainStarted = createDeferred();
    const releaseFollowUpDrain = createDeferred();
    const steer = { role: "user" as const, content: "one more thing", timestamp: 2 };
    const queued: AgentMessage[] = [];
    const requestMessages: Message[][] = [];
    const run = runAgentLoop(
      [{ role: "user", content: "start", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      {
        ...config,
        getSteeringMessages: async () => queued.splice(0, 1),
        getFollowUpMessages: async () => {
          followUpDrainStarted.resolve();
          await releaseFollowUpDrain.promise;
          return [];
        },
      },
      () => {},
      undefined,
      createTurnSequenceStream(
        [[{ type: "text", text: "initial response" }], [{ type: "text", text: "steer response" }]],
        requestMessages,
      ),
    );

    await followUpDrainStarted.promise;
    queued.push(steer);
    releaseFollowUpDrain.resolve();
    await run;

    expect(requestMessages).toHaveLength(2);
    expect(requestMessages[1]?.at(-1)).toBe(steer);
    expect(queued).toEqual([]);
  });

  it("suppresses sequential tools when steering arrives from awaited message_end", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const requestMessages: Message[][] = [];
    const streamFn = createTurnSequenceStream(
      [
        [
          { type: "toolCall", id: "before-first", name: "first", arguments: {} },
          { type: "toolCall", id: "before-second", name: "second", arguments: {} },
        ],
        [{ type: "text", text: "steer handled" }],
      ],
      requestMessages,
    );
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          { ...makeTool("first", []), execute },
          { ...makeTool("second", []), execute },
        ],
      },
      streamFn,
      toolExecution: "sequential",
    });
    const commitReadyCalls = vi.fn();
    const releaseSkippedCalls = vi.fn();
    setInternalBeforeToolBatch(agent, async () =>
      attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls }),
    );
    const events: AgentEvent[] = [];
    const steer = { role: "user" as const, content: "before tools", timestamp: 2 };
    agent.subscribe(async (event) => {
      events.push(event);
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason === "toolUse") {
          await Promise.resolve();
          agent.steer(steer);
        }
      }
    });

    await agent.prompt("start");

    expect(execute).not.toHaveBeenCalled();
    expect(commitReadyCalls).not.toHaveBeenCalled();
    expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith(["before-first", "before-second"]);
    expect(requestMessages[1]?.slice(-4)).toMatchObject([
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "before-first", isError: true },
      { role: "toolResult", toolCallId: "before-second", isError: true },
      steer,
    ]);
    expect(requestMessages[1]?.at(-1)).toBe(steer);
    expect(
      events
        .filter((event) => event.type === "tool_execution_end")
        .map((event) => ({ id: event.toolCallId, started: event.executionStarted })),
    ).toEqual([
      { id: "before-first", started: false },
      { id: "before-second", started: false },
    ]);
  });

  it("releases only admitted sequential calls when steering suppresses a mixed tail", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const requestMessages: Message[][] = [];
    const streamFn = createTurnSequenceStream(
      [
        [
          { type: "toolCall", id: "invalid-tail", name: "required", arguments: {} },
          { type: "toolCall", id: "valid-tail", name: "valid", arguments: {} },
        ],
        [{ type: "text", text: "steer handled" }],
      ],
      requestMessages,
    );
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            name: "required",
            label: "required",
            description: "requires input",
            parameters: Type.Object({ value: Type.String() }),
            execute,
          },
          { ...makeTool("valid", []), execute },
        ],
      },
      streamFn,
      toolExecution: "sequential",
    });
    const commitReadyCalls = vi.fn();
    const releaseSkippedCalls = vi.fn();
    setInternalBeforeToolBatch(agent, async ({ calls }) => {
      expect(calls.map((call) => call.toolCall.id)).toEqual(["valid-tail"]);
      return attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls });
    });
    agent.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "toolUse"
      ) {
        agent.steer({ role: "user", content: "redirect", timestamp: 2 });
      }
    });

    await agent.prompt("start");

    expect(execute).not.toHaveBeenCalled();
    expect(commitReadyCalls).not.toHaveBeenCalled();
    expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith(["valid-tail"]);
  });

  it("checks steering once before launching a prepared parallel batch", async () => {
    const preparationReleased = createDeferred();
    const preparationBlocked = createDeferred();
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const requestMessages: Message[][] = [];
    const streamFn = createTurnSequenceStream(
      [
        [
          { type: "toolCall", id: "invalid", name: "required", arguments: {} },
          { type: "toolCall", id: "prepared", name: "parallel", arguments: {} },
        ],
        [{ type: "text", text: "steer handled" }],
      ],
      requestMessages,
    );
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            name: "required",
            label: "required",
            description: "requires input",
            parameters: Type.Object({ value: Type.String() }),
            execute,
          },
          { ...makeTool("parallel", []), execute },
        ],
      },
      streamFn,
      toolExecution: "parallel",
      beforeToolCall: async ({ toolCall }) => {
        if (toolCall.id === "prepared") {
          preparationBlocked.resolve();
          await preparationReleased.promise;
        }
        return undefined;
      },
    });
    const commitReadyCalls = vi.fn();
    const releaseSkippedCalls = vi.fn();
    setInternalBeforeToolBatch(agent, async ({ calls }) => {
      expect(calls.map((call) => call.toolCall.id)).toEqual(["prepared"]);
      return attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls });
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });
    const steer = { role: "user" as const, content: "before launch", timestamp: 2 };

    const run = agent.prompt("start");
    await preparationBlocked.promise;
    agent.steer(steer);
    preparationReleased.resolve();
    await run;

    expect(execute).not.toHaveBeenCalled();
    expect(commitReadyCalls).not.toHaveBeenCalled();
    expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith(["prepared"]);
    expect(requestMessages[1]?.slice(-4)).toMatchObject([
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "invalid", isError: true },
      {
        role: "toolResult",
        toolCallId: "prepared",
        isError: true,
        content: [{ type: "text", text: "Skipped due to queued user message." }],
        details: { status: "skipped", deniedReason: "steering" },
      },
      steer,
    ]);
    expect(
      events
        .filter((event) => event.type === "tool_execution_end")
        .map((event) => ({ id: event.toolCallId, kind: event.errorKind })),
    ).toEqual([
      { id: "invalid", kind: "argument-validation" },
      { id: "prepared", kind: undefined },
    ]);
  });

  it("commits prepared parallel calls in assistant order at launch", async () => {
    const order: string[] = [];
    const requestMessages: Message[][] = [];
    const streamFn = createTurnSequenceStream(
      [
        [
          { type: "toolCall", id: "parallel-first", name: "first", arguments: {} },
          { type: "toolCall", id: "parallel-second", name: "second", arguments: {} },
        ],
        [{ type: "text", text: "done" }],
      ],
      requestMessages,
    );
    const commitReadyCalls = vi.fn((calls: readonly { toolCallId: string; args: unknown }[]) => {
      order.push(`commit:${calls.map((call) => call.toolCallId).join(",")}`);
    });
    const releaseSkippedCalls = vi.fn();

    await runAgentLoop(
      [{ role: "user", content: "run in parallel", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            ...makeTool("first", []),
            execute: async () => {
              order.push("execute:parallel-first");
              await Promise.resolve();
              order.push("gap:parallel-first");
              return { content: [], details: {} };
            },
          },
          {
            ...makeTool("second", []),
            execute: async () => {
              order.push("execute:parallel-second");
              await Promise.resolve();
              order.push("gap:parallel-second");
              return { content: [], details: {} };
            },
          },
        ],
      },
      {
        ...config,
        toolExecution: "parallel",
        beforeToolBatch: async () =>
          attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls }),
      },
      () => {},
      undefined,
      streamFn,
    );

    expect(order).toEqual([
      "commit:parallel-first",
      "execute:parallel-first",
      "commit:parallel-second",
      "execute:parallel-second",
      "gap:parallel-first",
      "gap:parallel-second",
    ]);
    expect(releaseSkippedCalls).not.toHaveBeenCalled();
  });

  it("does not launch prepared tools when the admission commit fails", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const streamFn = createTurnSequenceStream(
      [[{ type: "toolCall", id: "commit-failure", name: "side-effect", arguments: {} }]],
      [],
    );
    const commitError = new Error("admission commit failed");
    const releaseSkippedCalls = vi.fn();

    await expect(
      runAgentLoop(
        [{ role: "user", content: "run", timestamp: 1 }],
        {
          systemPrompt: "",
          messages: [],
          tools: [{ ...makeTool("side-effect", []), execute }],
        },
        {
          ...config,
          toolExecution: "parallel",
          beforeToolBatch: async () =>
            attachInternalToolBatchLifecycle(
              {},
              {
                commitReadyCalls: () => {
                  throw commitError;
                },
                releaseSkippedCalls,
              },
            ),
        },
        () => {},
        undefined,
        streamFn,
      ),
    ).rejects.toBe(commitError);
    expect(execute).not.toHaveBeenCalled();
    expect(releaseSkippedCalls).not.toHaveBeenCalled();
  });

  it("gives the model one recovery turn with the normal tool catalog", async () => {
    const executed: string[] = [];
    const providerToolNames: string[][] = [];
    let turn = 0;
    const streamFn: StreamFn = (_activeModel, context) => {
      providerToolNames.push(context.tools?.map((tool) => tool.name) ?? []);
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "loop-1", name: "read", arguments: {} },
              ])
            : makeAssistantMessage([{ type: "text", text: "recovered" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };
    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "run", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [makeTool("read", executed)] },
        {
          ...config,
          beforeToolBatch: async ({ calls }) => {
            const first = calls[0];
            expect(first?.tool?.name).toBe("read");
            return first ? { intervention: criticalLoopFor(first.toolCall) } : undefined;
          },
        },
        undefined,
        streamFn,
      ),
    );

    expect(turn).toBe(2);
    expect(providerToolNames).toEqual([["read"], ["read"]]);
    expect(executed).toEqual([]);
    expect(
      events.find(
        (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
          event.type === "tool_execution_end",
      ),
    ).toMatchObject({ executionStarted: false, isError: true });
    expect(
      events.find(
        (
          event,
        ): event is Extract<AgentEvent, { type: "message_end" }> & {
          message: { role: "toolResult" };
        } => event.type === "message_end" && event.message.role === "toolResult",
      )?.message,
    ).toMatchObject({
      details: { status: "blocked", deniedReason: "tool-loop" },
    });
  });

  it("does not taint the recovery turn with an unexecuted network tool source", async () => {
    const executed: string[] = [];
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "loop-1", name: "fetch", arguments: {} },
              ])
            : makeAssistantMessage([{ type: "text", text: "recovered" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };
    const networkTool: AgentTool = {
      ...makeTool("fetch", executed),
      resultContentSource: "network",
    };
    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "run", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [networkTool] },
        {
          ...config,
          beforeToolBatch: async ({ calls }) => {
            const first = calls[0];
            return first ? { intervention: criticalLoopFor(first.toolCall) } : undefined;
          },
        },
        undefined,
        streamFn,
      ),
    );

    expect(turn).toBe(2);
    expect(executed).toEqual([]);
    const readTaint = (message: unknown) =>
      (message as Record<string, unknown>)["__openclaw"] as
        | { resultContentSource?: string; turnTainted?: boolean }
        | undefined;
    const toolResultMessage = events.find(
      (
        event,
      ): event is Extract<AgentEvent, { type: "message_end" }> & {
        message: { role: "toolResult" };
      } => event.type === "message_end" && event.message.role === "toolResult",
    )?.message;
    // The rejected call never executed, so it carries no network source metadata.
    expect(readTaint(toolResultMessage)?.resultContentSource).toBeUndefined();
    const recoveryAssistantMessage = events.findLast(
      (
        event,
      ): event is Extract<AgentEvent, { type: "message_end" }> & {
        message: { role: "assistant" };
      } => event.type === "message_end" && event.message.role === "assistant",
    )?.message;
    expect(recoveryAssistantMessage).toMatchObject({ stopReason: "stop" });
    expect(readTaint(recoveryAssistantMessage)?.turnTainted).not.toBe(true);
  });

  it("honors outcome-hook termination during the first recovery turn", async () => {
    const executed: string[] = [];
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      streamCalls += 1;
      if (streamCalls > 1) {
        throw new Error("model was called after outcome-hook termination");
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage([
          { type: "toolCall", id: "loop-1", name: "read", arguments: {} },
        ]);
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };
    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "run", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [makeTool("read", executed)] },
        {
          ...config,
          beforeToolBatch: async ({ calls }) => {
            const first = calls[0];
            return first ? { intervention: criticalLoopFor(first.toolCall) } : undefined;
          },
          afterToolOutcome: async () => ({ terminate: true }),
        },
        undefined,
        streamFn,
      ),
    );

    expect(streamCalls).toBe(1);
    expect(executed).toEqual([]);
    // The run ends normally after the terminated batch: no forced
    // tool-loop-recovery failure message, which is reserved for later loops.
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
    expect(
      events.find(
        (
          event,
        ): event is Extract<AgentEvent, { type: "message_end" }> & {
          message: { role: "assistant" };
        } =>
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.stopReason === "error",
      ),
    ).toBeUndefined();
  });

  it("stops pre-admission validation after cancellation and aborts the untouched tail", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const resolverCalls: string[] = [];
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      streamCalls += 1;
      if (streamCalls > 1) {
        throw new Error("model was called after abort");
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage([
          { type: "toolCall", id: "d-first", name: "d_first_tool", arguments: {} },
          { type: "toolCall", id: "d-second", name: "d_second_tool", arguments: {} },
          { type: "toolCall", id: "d-third", name: "d_third_tool", arguments: {} },
        ]);
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };
    const deferredTool = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        executed.push(name);
        return {
          content: [{ type: "text", text: `${name} result` }],
          details: { name },
        };
      },
    });
    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "abort mid-admission", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [] },
        {
          ...config,
          resolveDeferredTool: async ({ toolCall }) => {
            resolverCalls.push(toolCall.name);
            if (toolCall.name === "d_first_tool") {
              // The run is cancelled while the first async resolver is in
              // flight; later resolvers must never be awaited.
              controller.abort(new Error("user aborted"));
            }
            return deferredTool(toolCall.name);
          },
          beforeToolBatch: async () => undefined,
        },
        controller.signal,
        streamFn,
      ),
    );

    expect(streamCalls).toBe(1);
    expect(resolverCalls).toEqual(["d_first_tool"]);
    expect(executed).toEqual([]);
    const toolResults = events
      .filter(
        (
          event,
        ): event is Extract<AgentEvent, { type: "message_end" }> & {
          message: { role: "toolResult" };
        } => event.type === "message_end" && event.message.role === "toolResult",
      )
      .map((event) => event.message);
    expect(toolResults).toHaveLength(3);
    for (const toolResult of toolResults) {
      expect(toolResult).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Operation aborted" }],
      });
    }
  });

  it("executes a different recovery action and keeps the one-shot budget spent", async () => {
    const executed: string[] = [];
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "loop-1", name: "read", arguments: {} },
              ])
            : turn === 2
              ? makeAssistantMessage([
                  { type: "toolCall", id: "safe-1", name: "list", arguments: {} },
                ])
              : makeAssistantMessage([
                  { type: "toolCall", id: "loop-2", name: "read", arguments: {} },
                ]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };
    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "run", timestamp: 1 }],
        {
          systemPrompt: "",
          messages: [],
          tools: [makeTool("read", executed), makeTool("list", executed)],
        },
        {
          ...config,
          beforeToolBatch: async ({ calls }) => {
            const repeated = calls.find((call) => call.toolCall.name === "read");
            return repeated ? { intervention: criticalLoopFor(repeated.toolCall) } : undefined;
          },
        },
        undefined,
        streamFn,
      ),
    );

    expect(turn).toBe(3);
    expect(executed).toEqual(["list"]);
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
    const toolEnds = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end",
    );
    expect(toolEnds.map((event) => event.executionStarted)).toEqual([false, true, false]);
    expect(toolEnds.at(-1)?.result).toMatchObject({ terminate: true });
    expect(
      events.find(
        (event) =>
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.stopReason === "error",
      ),
    ).toMatchObject({
      message: {
        content: [
          {
            type: "text",
            text: expect.stringContaining("tool-loop recovery encountered another critical loop"),
          },
        ],
      },
    });
  });

  it.each(["parallel", "sequential"] as const)(
    "rejects the entire recovery batch before any $toolExecution sibling executes",
    async (toolExecution) => {
      const executed: string[] = [];
      let turn = 0;
      const streamFn: StreamFn = () => {
        turn += 1;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message =
            turn === 1
              ? makeAssistantMessage([
                  { type: "toolCall", id: "loop-1", name: "read", arguments: {} },
                ])
              : makeAssistantMessage([
                  { type: "toolCall", id: "safe-1", name: "write", arguments: {} },
                  { type: "toolCall", id: "loop-2", name: "read", arguments: {} },
                ]);
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
          stream.end();
        });
        return stream;
      };
      const events = await collectEvents(
        agentLoop(
          [{ role: "user", content: "run", timestamp: 1 }],
          {
            systemPrompt: "",
            messages: [],
            tools: [makeTool("read", executed), makeTool("write", executed)],
          },
          {
            ...config,
            toolExecution,
            beforeToolBatch: async ({ calls }) => {
              const repeated = calls.find((call) => call.toolCall.name === "read");
              return repeated ? { intervention: criticalLoopFor(repeated.toolCall) } : undefined;
            },
          },
          undefined,
          streamFn,
        ),
      );

      expect(turn).toBe(2);
      expect(executed).toEqual([]);
      expect(
        events
          .filter(
            (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
              event.type === "tool_execution_end",
          )
          .map((event) => event.executionStarted),
      ).toEqual([false, false, false]);
      expect(events.at(-2)).toMatchObject({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "error",
          content: [
            {
              type: "text",
              text: expect.stringContaining("tool-loop recovery encountered another critical loop"),
            },
          ],
        },
      });
    },
  );

  it("preserves the recovery budget across continue retries and resets it for a new prompt", async () => {
    let phase: "initial" | "retry" | "new-prompt" = "initial";
    let phaseCalls = 0;
    const streamFn: StreamFn = () => {
      phaseCalls += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          phase === "initial" && phaseCalls === 2
            ? {
                ...makeAssistantMessage([]),
                stopReason: "error" as const,
                errorMessage: "retryable provider failure",
              }
            : phase === "new-prompt" && phaseCalls === 2
              ? makeAssistantMessage([{ type: "text", text: "recovered on the new run" }])
              : makeAssistantMessage([
                  {
                    type: "toolCall",
                    id: `${phase}-${phaseCalls}`,
                    name: "read",
                    arguments: {},
                  },
                ]);
        if (message.stopReason === "error") {
          stream.push({ type: "error", reason: "error", error: message });
        } else {
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
        }
        stream.end();
      });
      return stream;
    };
    const agent = new Agent({
      initialState: { model, systemPrompt: "", tools: [makeTool("read", [])] },
      streamFn,
    });
    setInternalBeforeToolBatch(agent, async ({ calls }) => {
      const first = calls[0];
      return first ? { intervention: criticalLoopFor(first.toolCall) } : undefined;
    });

    await agent.prompt("run");
    expect(phaseCalls).toBe(2);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "retryable provider failure",
    });

    agent.state.messages = agent.state.messages.slice(0, -1);
    phase = "retry";
    phaseCalls = 0;
    await agent.continue();

    expect(phaseCalls).toBe(1);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      content: [
        {
          type: "text",
          text: expect.stringContaining("tool-loop recovery encountered another critical loop"),
        },
      ],
    });

    phase = "new-prompt";
    phaseCalls = 0;
    await agent.prompt("new run");

    expect(phaseCalls).toBe(2);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "recovered on the new run" }],
    });
  });

  it.each([
    { resultSource: "network" as const, toolSource: undefined, tainted: true },
    { resultSource: undefined, toolSource: "network" as const, tainted: true },
    { resultSource: undefined, toolSource: undefined, tainted: false },
  ])(
    "persists per-invocation $resultSource and static $toolSource tool-result taint through the assistant turn",
    async ({ resultSource, toolSource, tainted }) => {
      let turn = 0;
      const tool: AgentTool = {
        ...makeTool("fetch", []),
        ...(toolSource ? { resultContentSource: toolSource } : {}),
        execute: async () => ({
          content: [{ type: "text", text: "fetch result" }],
          details: { name: "fetch" },
          ...(resultSource ? { resultContentSource: resultSource } : {}),
        }),
      };
      const streamFn: StreamFn = () => {
        turn += 1;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message =
            turn === 1
              ? makeAssistantMessage([
                  { type: "toolCall", id: "call-fetch", name: tool.name, arguments: {} },
                ])
              : makeAssistantMessage([{ type: "text", text: "stored result" }]);
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
          stream.end();
        });
        return stream;
      };

      const stream = agentLoop(
        [{ role: "user", content: "fetch", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [tool] },
        config,
        undefined,
        streamFn,
      );
      await collectEvents(stream);
      const messages = await stream.result();
      const toolResult = messages.find((message) => message.role === "toolResult");
      const assistant = messages.findLast(
        (message): message is AssistantMessage => message.role === "assistant",
      );
      const metadata = (message: AgentMessage | undefined) =>
        message ? (message as unknown as Record<string, unknown>)["__openclaw"] : undefined;

      expect(metadata(toolResult)).toEqual(
        tainted ? { resultContentSource: "network" } : undefined,
      );
      expect(metadata(assistant)).toEqual(tainted ? { turnTainted: true } : undefined);
    },
  );

  it.each([
    ["sequential", "invalid arguments"],
    ["sequential", "policy blocked"],
    ["parallel", "invalid arguments"],
    ["parallel", "policy blocked"],
  ] as const)(
    "never stamps external provenance on %s %s calls that did not execute",
    async (toolExecution, failure) => {
      let turn = 0;
      const executed: string[] = [];
      const tool: AgentTool = {
        ...makeTool("network_probe", executed),
        resultContentSource: "network",
        ...(failure === "invalid arguments"
          ? { parameters: Type.Object({ query: Type.String() }) }
          : {}),
      };
      const streamFn: StreamFn = () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          turn += 1;
          const message =
            turn === 1
              ? makeAssistantMessage([
                  { type: "toolCall", id: "network-preflight", name: tool.name, arguments: {} },
                ])
              : makeAssistantMessage([{ type: "text", text: "local outcome" }]);
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
          stream.end();
        });
        return stream;
      };
      const stream = agentLoop(
        [{ role: "user", content: "network preflight", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [tool] },
        {
          ...config,
          toolExecution,
          ...(failure === "policy blocked"
            ? { beforeToolCall: async () => ({ block: true, reason: "local policy" }) }
            : {}),
        },
        undefined,
        streamFn,
      );

      const events = await collectEvents(stream);
      const messages = await stream.result();
      const toolResult = messages.find((message) => message.role === "toolResult");
      const assistant = messages.findLast((message) => message.role === "assistant");

      expect(executed).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "tool_execution_end", executionStarted: false }),
      );
      expect((toolResult as unknown as { __openclaw?: unknown })?.["__openclaw"]).toBeUndefined();
      expect((assistant as unknown as { __openclaw?: unknown })?.["__openclaw"]).toBeUndefined();
    },
  );

  it.each([
    ["sequential", "caller cancellation", false],
    ["sequential", "remote failure after cancellation", true],
    ["parallel", "caller cancellation", false],
    ["parallel", "remote failure after cancellation", true],
  ] as const)(
    "preserves %s provenance for %s after execution begins",
    async (toolExecution, failure, tainted) => {
      const controller = new AbortController();
      const cancelReason = new Error("operator cancelled");
      const afterToolCall = vi.fn(async () => undefined);
      const tool: AgentTool = {
        ...makeTool("network_cancel", []),
        resultContentSource: "network",
        execute: async () => {
          controller.abort(cancelReason);
          throw tainted ? new Error("remote failure after cancellation") : cancelReason;
        },
      };
      const streamFn: StreamFn = () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = makeAssistantMessage([
            { type: "toolCall", id: "network-cancel", name: tool.name, arguments: {} },
          ]);
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
          stream.end();
        });
        return stream;
      };
      const stream = agentLoop(
        [{ role: "user", content: failure, timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [tool] },
        { ...config, toolExecution, afterToolCall },
        controller.signal,
        streamFn,
      );

      const events = await collectEvents(stream);
      const messages = await stream.result();
      const toolResult = messages.find((message) => message.role === "toolResult");

      expect(afterToolCall).toHaveBeenCalledOnce();
      expect(events).toContainEqual(
        expect.objectContaining({ type: "tool_execution_end", executionStarted: true }),
      );
      expect((toolResult as unknown as { __openclaw?: unknown })?.["__openclaw"]).toEqual(
        tainted ? { resultContentSource: "network" } : undefined,
      );
    },
  );

  it("persists and passes a local turn id when the provider omits one", async () => {
    let turn = 0;
    const toolCall = { type: "toolCall" as const, id: "call_0", name: "exec", arguments: {} };
    const assistantMessage = { ...makeAssistantMessage([toolCall]), responseId: " " };
    const executionContexts: AgentToolExecutionContext[] = [];
    const persistedAssistantMessages: AssistantMessage[] = [];
    const execTool: AgentTool = {
      ...makeTool("exec", []),
      execute: async () => {
        const executionContext = getAgentToolExecutionContext();
        if (executionContext) {
          executionContexts.push(executionContext);
        }
        return { content: [{ type: "text", text: "ok" }], details: { ok: true } };
      },
    };
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1 ? assistantMessage : makeAssistantMessage([{ type: "text", text: "done" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };

    await runAgentLoop(
      [{ role: "user", content: "run", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [execTool] },
      config,
      (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          persistedAssistantMessages.push(event.message);
        }
      },
      undefined,
      streamFn,
    );

    const toolTurnId = executionContexts[0]?.assistantMessage.turnId;
    expect(toolTurnId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(executionContexts[0]?.toolCall).toBe(toolCall);
    expect(persistedAssistantMessages[0]?.turnId).toBe(toolTurnId);
  });

  it("marks lifecycle events from the concrete hidden tool instance", async () => {
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "call-wait", name: "wait", arguments: {} },
              ])
            : makeAssistantMessage([{ type: "text", text: "done" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };
    const hiddenTool: AgentTool = {
      ...makeTool("wait", []),
      hideFromChannelProgress: true,
      execute: async (_toolCallId, _args, _signal, onUpdate) => {
        onUpdate?.({
          content: [{ type: "text", text: "still waiting" }],
          details: { status: "waiting" },
        });
        return {
          content: [{ type: "text", text: "resumed" }],
          details: { status: "completed" },
        };
      },
    };

    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "resume", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [hiddenTool] },
        { ...config, toolExecution: "sequential" },
        undefined,
        streamFn,
      ),
    );
    const lifecycleEvents = events.filter((event) => event.type.startsWith("tool_execution_"));

    expect(lifecycleEvents.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
    expect(
      lifecycleEvents.every(
        (event) => "hideFromChannelProgress" in event && event.hideFromChannelProgress === true,
      ),
    ).toBe(true);
  });

  it("ignores progress updates after a tool execution settles", async () => {
    let delayedUpdate: ((result: AgentToolResult<unknown>) => void) | undefined;
    const tool: AgentTool = {
      name: "delayed_tool",
      label: "delayed_tool",
      description: "captures progress callbacks",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_toolCallId, _args, _signal, onUpdate) => {
        delayedUpdate = onUpdate;
        onUpdate?.({
          content: [{ type: "text", text: "running" }],
          details: { status: "running" },
        });
        return {
          content: [{ type: "text", text: "done" }],
          details: { status: "done" },
          terminate: true,
        };
      },
    };
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage([
          { type: "toolCall", id: "call-delayed", name: tool.name, arguments: {} },
        ]);
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };

    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "run", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [tool] },
        { ...config, toolExecution: "sequential" },
        undefined,
        streamFn,
      ),
    );
    const countAfterRun = events.length;
    delayedUpdate?.({
      content: [{ type: "text", text: "late" }],
      details: { status: "late" },
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(events).toHaveLength(countAfterRun);
    expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(1);
  });

  it("continues after a side-effect tool result when afterToolCall records it without terminate", async () => {
    const executed: string[] = [];
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "call-message", name: "message", arguments: {} },
              ])
            : turn === 2
              ? makeAssistantMessage([
                  { type: "toolCall", id: "call-exec", name: "exec", arguments: {} },
                ])
              : makeAssistantMessage([{ type: "text", text: "done" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };
    let recordedSideEffect = false;

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [makeTool("message", executed), makeTool("exec", executed)],
      },
      {
        ...config,
        afterToolCall: async ({ toolCall }) => {
          if (toolCall.name === "message") {
            recordedSideEffect = true;
          }
          return undefined;
        },
      },
      undefined,
      streamFn,
    );

    const events = await collectEvents(stream);

    expect(recordedSideEffect).toBe(true);
    expect(turn).toBe(3);
    expect(executed).toEqual(["message", "exec"]);
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(2);
    expect(
      events
        .filter(
          (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
            event.type === "tool_execution_end",
        )
        .map((event) => event.executionStarted),
    ).toEqual([true, true]);
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
  });

  it("normalizes a tool result with missing content before the next model turn", async () => {
    const contexts: Context[] = [];
    let turn = 0;
    const streamFn: StreamFn = (_activeModel, context) => {
      contexts.push(context);
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "call-empty", name: "empty", arguments: {} },
              ])
            : makeAssistantMessage([{ type: "text", text: "done" }]);
        stream.push({ type: "done", reason: turn === 1 ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    };
    const tool: AgentTool = {
      name: "empty",
      label: "empty",
      description: "returns no display content",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => ({ details: { ok: true } }) as AgentToolResult<unknown>,
    };

    await collectEvents(
      agentLoop(
        [{ role: "user", content: "run", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [tool] },
        config,
        undefined,
        streamFn,
      ),
    );

    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "empty",
        content: [],
      }),
    );
  });

  it("preserves extra tool result fields when an after hook patches the result", async () => {
    const extra = { deliveryId: "delivery-1" };
    const originalResult = {
      content: [{ type: "text" as const, text: "sent" }],
      details: { phase: "original" },
      extra,
      resultContentSource: "network" as const,
    };
    const tool: AgentTool = {
      name: "patched",
      label: "patched",
      description: "returns extended result metadata",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => originalResult,
    };
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage([
          { type: "toolCall", id: "call-patched", name: tool.name, arguments: {} },
        ]);
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };

    const stream = agentLoop(
      [{ role: "user", content: "run", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [tool] },
      {
        ...config,
        afterToolCall: async () => ({ details: { phase: "patched" }, terminate: true }),
      },
      undefined,
      streamFn,
    );
    const events = await collectEvents(stream);
    const messages = await stream.result();
    const endEvent = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end",
    );

    expect(endEvent?.result).toMatchObject({
      content: originalResult.content,
      details: { phase: "patched" },
      extra,
      terminate: true,
    });
    expect(
      (
        messages.find((message) => message.role === "toolResult") as unknown as Record<
          string,
          unknown
        >
      )["__openclaw"],
    ).toEqual({ resultContentSource: "network" });
  });

  it("marks policy-blocked tool calls as not executed", async () => {
    const executed: string[] = [];
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "call-cron", name: "cron", arguments: {} },
              ])
            : makeAssistantMessage([{ type: "text", text: "done" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [makeTool("cron", executed)],
      },
      {
        ...config,
        beforeToolCall: async () => ({ block: true, reason: "blocked" }),
      },
      undefined,
      streamFn,
    );

    const events = await collectEvents(stream);
    const endEvent = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end",
    );

    expect(executed).toEqual([]);
    expect(endEvent?.executionStarted).toBe(false);
  });

  it("marks argument validation failures with typed provenance", async () => {
    const executed: string[] = [];
    const afterToolOutcome = vi.fn(async () => ({
      details: { observed: "pre-execution" },
    }));
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "call-edit", name: "edit", arguments: {} },
              ])
            : makeAssistantMessage([{ type: "text", text: "done" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };
    const tool: AgentTool = {
      ...makeTool("edit", executed),
      parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
    };

    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "hello", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [tool] },
        { ...config, afterToolOutcome },
        undefined,
        streamFn,
      ),
    );
    const endEvent = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end",
    );

    expect(executed).toEqual([]);
    expect(endEvent).toMatchObject({
      executionStarted: false,
      errorKind: "argument-validation",
      result: {
        details: { observed: "pre-execution" },
      },
    });
    expect(afterToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        args: {},
        executionStarted: false,
        errorKind: "argument-validation",
        isError: true,
        toolCall: expect.objectContaining({ name: "edit" }),
      }),
      undefined,
    );
  });

  it("runs the finalized-outcome hook after the executed-only hook", async () => {
    const executed: string[] = [];
    const order: string[] = [];
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "call-read", name: "read", arguments: {} },
              ])
            : makeAssistantMessage([{ type: "text", text: "done" }]);
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };

    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "hello", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [makeTool("read", executed)] },
        {
          ...config,
          afterToolCall: async () => {
            order.push("afterToolCall");
            return { details: { phase: "executed" } };
          },
          afterToolOutcome: async ({ result, executionStarted }) => {
            order.push("afterToolOutcome");
            expect(result.details).toEqual({ phase: "executed" });
            expect(executionStarted).toBe(true);
            return { details: { phase: "finalized" } };
          },
        },
        undefined,
        streamFn,
      ),
    );
    const endEvent = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end",
    );

    expect(executed).toEqual(["read"]);
    expect(order).toEqual(["afterToolCall", "afterToolOutcome"]);
    expect(endEvent?.result).toMatchObject({ details: { phase: "finalized" } });
  });

  it("preserves a terminal result when the finalized-outcome hook throws", async () => {
    const executed: string[] = [];
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? makeAssistantMessage([
                { type: "toolCall", id: "call-message", name: "message", arguments: {} },
              ])
            : makeAssistantMessage([
                { type: "toolCall", id: "call-exec", name: "exec", arguments: {} },
              ]);
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [makeTool("message", executed), makeTool("exec", executed)],
      },
      {
        ...config,
        afterToolCall: async ({ toolCall }) =>
          toolCall.name === "message" ? { terminate: true } : undefined,
        afterToolOutcome: async () => {
          throw new Error("finalized hook failed");
        },
      },
      undefined,
      streamFn,
    );

    const events = await collectEvents(stream);

    expect(turn).toBe(1);
    expect(executed).toEqual(["message"]);
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
    expect(events.find((event) => event.type === "tool_execution_end")?.result).toMatchObject({
      content: [{ type: "text", text: "finalized hook failed" }],
      terminate: true,
    });
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
  });

  it("does not request another model turn after a tool aborts the run", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      streamCalls += 1;
      if (streamCalls > 1) {
        throw new Error("model was called after abort");
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage([
          { type: "toolCall", id: "call-abort", name: "abort_tool", arguments: {} },
        ]);
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };
    const abortTool: AgentTool = {
      name: "abort_tool",
      label: "abort_tool",
      description: "Abort the active run",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        controller.abort(new Error("user aborted"));
        return {
          content: [{ type: "text", text: "aborted" }],
          details: { aborted: true },
        };
      },
    };
    const events: AgentEvent[] = [];

    const messages = await runAgentLoop(
      [{ role: "user", content: "abort during tool", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [abortTool],
      },
      config,
      (event) => {
        events.push(event);
      },
      controller.signal,
      streamFn,
    );

    expect(streamCalls).toBe(1);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "custom",
    ]);
    expect(messages.at(-2)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(messages.at(-1)).toMatchObject({
      role: "custom",
      customType: "openclaw:turn-aborted",
      display: false,
      content: expect.stringContaining("may have partially executed"),
    });
    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_end",
      "turn_end",
      "message_start",
      "message_end",
      "agent_end",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
  });

  it("emits aborted tool results for skipped tool calls on sequential abort (#116379)", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      streamCalls += 1;
      if (streamCalls > 1) {
        throw new Error("model was called after abort");
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage([
          { type: "toolCall", id: "call-first", name: "first_tool", arguments: {} },
          { type: "toolCall", id: "call-second", name: "second_tool", arguments: {} },
          { type: "toolCall", id: "call-third", name: "third_tool", arguments: {} },
        ]);
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };
    const firstTool: AgentTool = {
      name: "first_tool",
      label: "first_tool",
      description: "Aborts the run mid-batch",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async () => {
        controller.abort(new Error("user aborted"));
        return {
          content: [{ type: "text", text: "first ran" }],
          details: { aborted: true },
        };
      },
    };
    const skippedTool: AgentTool = {
      name: "second_tool",
      label: "second_tool",
      description: "Should be skipped by abort",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: "sequential",
      hideFromChannelProgress: true,
      execute: async () => {
        throw new Error("second_tool should never execute");
      },
    };
    const thirdTool: AgentTool = {
      ...skippedTool,
      name: "third_tool",
      label: "third_tool",
    };

    // afterToolOutcome must observe every committed tool call, including the
    // aborted tail the dispatch loop skipped — otherwise audit/redaction hooks
    // silently miss the repaired calls (#116379).
    const afterToolOutcome = vi.fn(async () => undefined);
    const events: AgentEvent[] = [];
    const messages = await runAgentLoop(
      [{ role: "user", content: "abort mid-batch", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [firstTool, skippedTool, thirdTool],
      },
      { ...config, toolExecution: "sequential", afterToolOutcome },
      (event) => {
        events.push(event);
      },
      controller.signal,
      streamFn,
    );

    // The assistant turn committed three tool_use blocks; every one must have a
    // matching tool_result so the history has no orphaned tool_use.
    const toolResultMessages = messages.filter((message) => message.role === "toolResult");
    const toolResultIds = toolResultMessages.map(
      (message) => (message as Extract<AgentMessage, { role: "toolResult" }>).toolCallId,
    );
    expect(toolResultIds).toEqual(["call-first", "call-second", "call-third"]);
    // The first tool produced a real result; the skipped tail got aborted results.
    expect(toolResultMessages[0]).toMatchObject({ toolCallId: "call-first", isError: false });
    expect(toolResultMessages[1]).toMatchObject({ toolCallId: "call-second", isError: true });
    expect(toolResultMessages[2]).toMatchObject({ toolCallId: "call-third", isError: true });
    expect(
      (toolResultMessages[1] as Extract<AgentMessage, { role: "toolResult" }>).content,
    ).toContainEqual({ type: "text", text: "Operation aborted" });
    // The outcome hook observed all three calls, including the two skipped tail
    // calls, with the aborted marker.
    expect(afterToolOutcome).toHaveBeenCalledTimes(3);
    expect(afterToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ id: "call-second" }),
        isError: true,
        executionStarted: false,
      }),
      controller.signal,
    );
    expect(afterToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ id: "call-third" }),
        isError: true,
        executionStarted: false,
      }),
      controller.signal,
    );
    // Every skipped tail call emits a tool_execution_start before its
    // tool_execution_end, preserving the lifecycle pairing every dispatched
    // call already has — otherwise channel/client subscribers receive an end
    // event for an unknown tool-call id (#116379).
    for (const skippedId of ["call-second", "call-third"]) {
      const startIdx = events.findIndex(
        (event) =>
          event.type === "tool_execution_start" &&
          (event as Extract<AgentEvent, { type: "tool_execution_start" }>).toolCallId === skippedId,
      );
      const endIdx = events.findIndex(
        (event) =>
          event.type === "tool_execution_end" &&
          (event as Extract<AgentEvent, { type: "tool_execution_end" }>).toolCallId === skippedId,
      );
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
      expect(
        (events[endIdx] as Extract<AgentEvent, { type: "tool_execution_end" }>).executionStarted,
      ).toBe(false);
      expect(events[startIdx]).toMatchObject({ hideFromChannelProgress: true });
      expect(events[endIdx]).toMatchObject({ hideFromChannelProgress: true });
    }
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(3);
    expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(3);
  });

  it("emits aborted tool results for skipped tool calls on parallel abort (#116379)", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      streamCalls += 1;
      if (streamCalls > 1) {
        throw new Error("model was called after abort");
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage([
          { type: "toolCall", id: "p-first", name: "p_first_tool", arguments: {} },
          { type: "toolCall", id: "p-second", name: "p_second_tool", arguments: {} },
          { type: "toolCall", id: "p-third", name: "p_third_tool", arguments: {} },
        ]);
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };
    const firstTool: AgentTool = {
      name: "p_first_tool",
      label: "p_first_tool",
      description: "Aborts the run mid-batch",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        controller.abort(new Error("user aborted"));
        return {
          content: [{ type: "text", text: "first ran" }],
          details: { aborted: true },
        };
      },
    };
    const skippedTool: AgentTool = {
      name: "p_second_tool",
      label: "p_second_tool",
      description: "Should be skipped by abort",
      parameters: Type.Object({}, { additionalProperties: false }),
      hideFromChannelProgress: true,
      execute: async () => {
        throw new Error("p_second_tool should never execute");
      },
    };
    const thirdTool: AgentTool = {
      ...skippedTool,
      name: "p_third_tool",
      label: "p_third_tool",
    };

    // afterToolOutcome must observe every committed tool call, including the
    // aborted tail the dispatch loop skipped — otherwise audit/redaction hooks
    // silently miss the repaired calls (#116379).
    const afterToolOutcome = vi.fn(async () => undefined);
    const events: AgentEvent[] = [];
    const messages = await runAgentLoop(
      [{ role: "user", content: "abort mid-batch parallel", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [firstTool, skippedTool, thirdTool],
      },
      { ...config, toolExecution: "parallel", afterToolOutcome },
      (event) => {
        events.push(event);
      },
      controller.signal,
      streamFn,
    );

    const toolResultMessages = messages.filter((message) => message.role === "toolResult");
    const toolResultIds = toolResultMessages.map(
      (message) => (message as Extract<AgentMessage, { role: "toolResult" }>).toolCallId,
    );
    expect(toolResultIds.toSorted()).toEqual(["p-first", "p-second", "p-third"]);
    // Every tool_use is paired with a tool_result — no orphaned tool_use.
    expect(toolResultMessages).toHaveLength(3);
    // The outcome hook observed all three calls, including the two skipped tail
    // calls, with the aborted marker.
    expect(afterToolOutcome).toHaveBeenCalledTimes(3);
    expect(afterToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ id: "p-second" }),
        isError: true,
        executionStarted: false,
      }),
      controller.signal,
    );
    expect(afterToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ id: "p-third" }),
        isError: true,
        executionStarted: false,
      }),
      controller.signal,
    );
    // Every tool call — dispatched or skipped — emits a tool_execution_start
    // before its tool_execution_end, so channel/client subscribers never see an
    // end event for an unknown tool-call id (#116379).
    for (const toolCallId of ["p-first", "p-second", "p-third"]) {
      const startIdx = events.findIndex(
        (event) =>
          event.type === "tool_execution_start" &&
          (event as Extract<AgentEvent, { type: "tool_execution_start" }>).toolCallId ===
            toolCallId,
      );
      const endIdx = events.findIndex(
        (event) =>
          event.type === "tool_execution_end" &&
          (event as Extract<AgentEvent, { type: "tool_execution_end" }>).toolCallId === toolCallId,
      );
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
      if (toolCallId !== "p-first") {
        expect(events[startIdx]).toMatchObject({ hideFromChannelProgress: true });
        expect(events[endIdx]).toMatchObject({ hideFromChannelProgress: true });
      }
    }
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(3);
    expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(3);
  });

  it("skips interrupted-turn guidance when the abort reason marks a turn handoff", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      streamCalls += 1;
      if (streamCalls > 1) {
        throw new Error("model was called after abort");
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage([
          { type: "toolCall", id: "call-yield", name: "yield_tool", arguments: {} },
        ]);
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };
    const yieldTool: AgentTool = {
      name: "yield_tool",
      label: "yield_tool",
      description: "Yield the active run as a clean handoff",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        controller.abort({ code: "sessions_yield", turnHandoff: true });
        return {
          content: [{ type: "text", text: "yielded" }],
          details: { yielded: true },
        };
      },
    };

    const messages = await runAgentLoop(
      [{ role: "user", content: "yield during tool", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [yieldTool],
      },
      config,
      () => {},
      controller.signal,
      streamFn,
    );

    expect(streamCalls).toBe(1);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(messages.some((message) => message.role === "custom")).toBe(false);
  });

  it("does not start prepared parallel tools after the run aborts mid-batch", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const afterToolCall = vi.fn(async () => undefined);
    const commitReadyCalls = vi.fn();
    const releaseSkippedCalls = vi.fn();
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "toolUse",
          message: makeAssistantMessage([
            { type: "toolCall", id: "call-paid", name: "paid", arguments: {} },
            { type: "toolCall", id: "call-gated", name: "gated", arguments: {} },
          ]),
        });
        stream.end();
      });
      return stream;
    };
    const events: AgentEvent[] = [];

    const abortedMessages = await runAgentLoop(
      [{ role: "user", content: "abort during parallel tool preparation", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          { ...makeTool("paid", executed), resultContentSource: "network" },
          { ...makeTool("gated", executed), resultContentSource: "network" },
        ],
      },
      {
        ...config,
        toolExecution: "parallel",
        beforeToolBatch: async () =>
          attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls }),
        beforeToolCall: async ({ toolCall }) => {
          if (toolCall.name === "gated") {
            await Promise.resolve();
            controller.abort(new Error("user aborted"));
          }
          return undefined;
        },
        afterToolCall,
      },
      (event) => {
        events.push(event);
      },
      controller.signal,
      streamFn,
    );

    const endEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end",
    );

    expect(executed).toEqual([]);
    expect(afterToolCall).not.toHaveBeenCalled();
    expect(commitReadyCalls).not.toHaveBeenCalled();
    expect(releaseSkippedCalls).not.toHaveBeenCalled();
    expect(
      abortedMessages
        .filter((message) => message.role === "toolResult")
        .every((message) => !(message as unknown as { __openclaw?: unknown })["__openclaw"]),
    ).toBe(true);
    expect(endEvents).toHaveLength(2);
    expect(endEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "paid",
          isError: true,
          executionStarted: false,
          result: expect.objectContaining({
            content: [{ type: "text", text: "Operation aborted" }],
          }),
        }),
        expect.objectContaining({
          toolName: "gated",
          isError: true,
          executionStarted: false,
          result: expect.objectContaining({
            content: [{ type: "text", text: "Operation aborted" }],
          }),
        }),
      ]),
    );
  });

  it("does not request another model turn when an async turn hook aborts the run", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      streamCalls += 1;
      if (streamCalls > 1) {
        throw new Error("model was called after abort");
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage([
          { type: "toolCall", id: "call-hook-abort", name: "hook_abort", arguments: {} },
        ]);
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
      });
      return stream;
    };
    const events: AgentEvent[] = [];

    const messages = await runAgentLoop(
      [{ role: "user", content: "abort from hook", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [makeTool("hook_abort", [])],
      },
      {
        ...config,
        prepareNextTurn: async () => {
          await Promise.resolve();
          controller.abort(new Error("user aborted"));
          return undefined;
        },
      },
      (event) => {
        events.push(event);
      },
      controller.signal,
      streamFn,
    );

    expect(streamCalls).toBe(1);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "custom",
    ]);
    expect(messages.at(-2)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(messages.at(-1)).toMatchObject({
      role: "custom",
      customType: "openclaw:turn-aborted",
    });
    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_end",
      "turn_end",
      "message_start",
      "message_end",
      "agent_end",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "agent_end" });
  });
});

describe("Agent next-turn preparation", () => {
  it("forwards completed-turn context and applies its update to the following request", async () => {
    const nextModel = { ...model, id: "next-model" };
    const requests: Array<{ model: string; systemPrompt: string; tools: string[] }> = [];
    let turn = 0;
    const streamFn: StreamFn = (activeModel, context) => {
      requests.push({
        model: activeModel.id,
        systemPrompt: context.systemPrompt ?? "",
        tools: context.tools?.map((tool) => tool.name) ?? [],
      });
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content: AssistantMessage["content"] =
          turn === 1
            ? [{ type: "toolCall", id: "call-refresh", name: "refresh", arguments: {} }]
            : [{ type: "text", text: "done" }];
        stream.push({
          type: "done",
          reason: turn === 1 ? "toolUse" : "stop",
          message: {
            role: "assistant",
            content,
            api: activeModel.api,
            provider: activeModel.provider,
            model: activeModel.id,
            usage: TEST_USAGE,
            stopReason: turn === 1 ? "toolUse" : "stop",
            timestamp: turn,
          },
        });
        stream.end();
      });
      return stream;
    };
    const tool: AgentTool = {
      name: "refresh",
      label: "refresh",
      description: "refresh turn state",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => ({ content: [{ type: "text", text: "refreshed" }], details: {} }),
    };
    const prepareNextTurnWithContext = vi.fn(({ context }) => ({
      context: { ...context, systemPrompt: "refreshed prompt", tools: [] },
      model: nextModel,
    }));
    const prepareNextTurn = vi.fn(() => ({
      context: { systemPrompt: "legacy prompt", messages: [], tools: [tool] },
    }));
    const agent = new Agent({
      initialState: { model, systemPrompt: "initial prompt", tools: [tool] },
      convertToLlm: (messages) => messages as Message[],
      streamFn,
      prepareNextTurn,
      prepareNextTurnWithContext,
    });

    await agent.prompt("start");

    expect(prepareNextTurnWithContext).toHaveBeenCalled();
    expect(prepareNextTurn).not.toHaveBeenCalled();
    expect(prepareNextTurnWithContext.mock.calls[0]?.[0]).toMatchObject({
      message: { role: "assistant", stopReason: "toolUse" },
      toolResults: [{ role: "toolResult", toolName: "refresh" }],
    });
    expect(requests).toEqual([
      { model: model.id, systemPrompt: "initial prompt", tools: ["refresh"] },
      { model: nextModel.id, systemPrompt: "refreshed prompt", tools: [] },
    ]);
  });
});

describe("agentLoop thinking state", () => {
  function makeAssistantMessage(
    activeModel: Model,
    content: AssistantMessage["content"],
  ): AssistantMessage {
    return {
      role: "assistant",
      content,
      api: activeModel.api,
      provider: activeModel.provider,
      model: activeModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
      timestamp: 1,
    };
  }

  it.each([
    {
      name: "disables reasoning after leaving Fable",
      initialModel: { ...model, id: "claude-fable-5", thinkingLevelMap: { off: "low" } },
      nextModel: model,
      expected: ["low", undefined],
    },
    {
      name: "uses Fable's low fallback after entering Fable",
      initialModel: model,
      nextModel: { ...model, id: "claude-fable-5", thinkingLevelMap: { off: "low" } },
      expected: [undefined, "low"],
    },
  ])("$name", async ({ initialModel, nextModel, expected }) => {
    const observedReasoning: Array<string | undefined> = [];
    let callCount = 0;
    const streamFn: StreamFn = (activeModel, _context, options) => {
      observedReasoning.push(options?.reasoning);
      callCount += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content: AssistantMessage["content"] =
          callCount === 1
            ? [{ type: "toolCall", id: "tool-1", name: "missing_tool", arguments: {} }]
            : [{ type: "text", text: "done" }];
        stream.push({
          type: "done",
          reason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
          message: makeAssistantMessage(activeModel, content),
        });
        stream.end();
      });
      return stream;
    };
    let prepared = false;
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      {
        ...config,
        model: initialModel,
        thinkingLevel: "off",
        reasoning: initialModel.thinkingLevelMap?.off === "low" ? "low" : undefined,
        prepareNextTurn: () => {
          if (prepared) {
            return undefined;
          }
          prepared = true;
          return { model: nextModel };
        },
      },
      undefined,
      streamFn,
    );

    await collectEvents(stream);

    expect(observedReasoning).toEqual(expected);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
