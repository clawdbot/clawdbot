// Agent Core tests cover agent loop behavior.
import { EventStream } from "@openclaw/ai/event-stream";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue, runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import { Agent } from "./agent.js";
import { TRANSCRIPT_NOT_CONTINUABLE_ERROR_CODE, TranscriptNotContinuableError } from "./errors.js";
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
        stream.push({ type: "done", reason: message.stopReason, message });
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
        stream.push({ type: "done", reason: message.stopReason, message });
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

    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "run", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [tool] },
        {
          ...config,
          afterToolCall: async () => ({ details: { phase: "patched" }, terminate: true }),
        },
        undefined,
        streamFn,
      ),
    );
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
        config,
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
    });
  });

  it("stops after a tool result only when the finalized result explicitly terminates", async () => {
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
      },
      undefined,
      streamFn,
    );

    const events = await collectEvents(stream);

    expect(turn).toBe(1);
    expect(executed).toEqual(["message"]);
    expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
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

    await runAgentLoop(
      [{ role: "user", content: "abort during parallel tool preparation", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [makeTool("paid", executed), makeTool("gated", executed)],
      },
      {
        ...config,
        toolExecution: "parallel",
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
