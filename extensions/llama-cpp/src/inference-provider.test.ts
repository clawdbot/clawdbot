import os from "node:os";
import path from "node:path";
import type { AssistantMessageEvent, Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const generateResponse = vi.fn();
  const resolveModelFile = vi.fn(
    async (source: string) => `/models/${source.replaceAll("/", "_")}`,
  );
  const contextDispose = vi.fn(async () => {});
  const modelDispose = vi.fn(async () => {});
  const llamaDispose = vi.fn(async () => {});
  const diff = vi.fn(() => ({ usedInputTokens: 7, usedOutputTokens: 2 }));
  const getState = vi.fn(() => ({ usedInputTokens: 0, usedOutputTokens: 0 }));
  const sequence = { tokenMeter: { getState, diff } };
  const context = {
    getSequence: vi.fn(() => sequence),
    dispose: contextDispose,
  };
  const model = {
    createContext: vi.fn(async () => context),
    dispose: modelDispose,
  };
  const llama = {
    loadModel: vi.fn(async () => model),
    createGrammarForJsonSchema: vi.fn(async (schema: unknown) => ({ schema })),
    getGrammarFor: vi.fn(async (type: string) => ({ type })),
    dispose: llamaDispose,
  };
  return {
    generateResponse,
    resolveModelFile,
    contextDispose,
    modelDispose,
    llamaDispose,
    getState,
    diff,
    sequence,
    context,
    model,
    llama,
    getLlama: vi.fn(async () => llama),
  };
});

vi.mock("node-llama-cpp", () => ({
  getLlama: mocks.getLlama,
  resolveModelFile: mocks.resolveModelFile,
  createModelDownloader: vi.fn(),
  LlamaChat: class {
    generateResponse = mocks.generateResponse;
    dispose = vi.fn();
  },
}));

import { createLlamaCppStreamFn } from "./inference-provider.js";

const {
  clearLlamaCppInferenceCacheForTests,
  mapContextToLlamaChatHistory,
  mapToolsToLlamaFunctions,
} = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.llamaCppInferenceTestApi")
] as {
  clearLlamaCppInferenceCacheForTests: () => Promise<void>;
  mapContextToLlamaChatHistory: (context: Context) => unknown[];
  mapToolsToLlamaFunctions: (context: Context) => Record<string, unknown> | undefined;
};

const model: Model = {
  id: "test.gguf",
  name: "test",
  api: "openai-completions",
  provider: "llama-cpp",
  baseUrl: "local://llama-cpp",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  contextTokens: 8192,
  maxTokens: 2048,
  params: { modelPath: "test.gguf" },
};

async function collectEvents(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

beforeEach(async () => {
  await clearLlamaCppInferenceCacheForTests();
  vi.clearAllMocks();
  mocks.generateResponse.mockResolvedValue({
    response: "",
    functionCalls: undefined,
    metadata: { stopReason: "eogToken" },
  });
});

afterEach(async () => {
  await clearLlamaCppInferenceCacheForTests();
});

describe("llama.cpp inference provider", () => {
  it("maps OpenClaw history and tool results into the model chat template history", () => {
    const context = {
      systemPrompt: "Be concise.",
      messages: [
        { role: "user" as const, content: "weather?", timestamp: 1 },
        {
          role: "assistant" as const,
          api: "openai-completions",
          provider: "test",
          model: "test",
          stopReason: "toolUse" as const,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: 2,
          content: [
            { type: "text" as const, text: "Checking." },
            {
              type: "toolCall" as const,
              id: "call-1",
              name: "weather",
              arguments: { city: "Berlin" },
            },
          ],
        },
        {
          role: "toolResult" as const,
          toolCallId: "call-1",
          toolName: "weather",
          content: [{ type: "text" as const, text: "Sunny" }],
          isError: false,
          timestamp: 3,
        },
        { role: "user" as const, content: "thanks", timestamp: 4 },
      ],
    };

    expect(mapContextToLlamaChatHistory(context)).toEqual([
      { type: "system", text: "Be concise." },
      { type: "user", text: "weather?" },
      {
        type: "model",
        response: [
          "Checking.",
          {
            type: "functionCall",
            name: "weather",
            params: { city: "Berlin" },
            result: "Sunny",
          },
        ],
      },
      { type: "user", text: "thanks" },
    ]);
  });

  it("maps JSON-schema tools to native node-llama-cpp function definitions", () => {
    expect(
      mapToolsToLlamaFunctions({
        messages: [],
        tools: [
          {
            name: "weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      }),
    ).toEqual({
      weather: {
        description: "Get weather",
        params: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    });
  });

  it("streams text deltas and reports native token-meter usage", async () => {
    mocks.generateResponse.mockImplementationOnce(async (_history, options) => {
      options.onTextChunk("Hel");
      options.onTextChunk("lo");
      return {
        response: "Hello",
        functionCalls: undefined,
        metadata: { stopReason: "eogToken" },
      };
    });
    const stream = await createLlamaCppStreamFn({})(
      model,
      { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      { stop: ["END"] },
    );

    const events = await collectEvents(stream);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "stop",
      message: {
        content: [{ type: "text", text: "Hello" }],
        usage: { input: 7, output: 2, totalTokens: 9 },
      },
    });
    expect(mocks.generateResponse.mock.calls[0]?.[1]).toMatchObject({
      maxTokens: 2048,
      customStopTriggers: ["END"],
    });
    expect(mocks.generateResponse.mock.calls[0]?.[1]).not.toHaveProperty("onResponseChunk");
  });

  it("streams reasoning and text before a result-only native tool call", async () => {
    mocks.generateResponse.mockImplementationOnce(async (_history, options) => {
      options.onResponseChunk({
        type: "segment",
        segmentType: "thought",
        text: "First ",
        tokens: [1],
      });
      options.onResponseChunk({
        type: "segment",
        segmentType: "thought",
        text: "reason.",
        tokens: [2],
      });
      options.onTextChunk("Answer.");
      return {
        response: "Answer.",
        functionCalls: [{ functionName: "weather", params: { city: "Paris" }, raw: [] }],
        metadata: { stopReason: "functionCalls" },
      };
    });

    const events = await collectEvents(
      await createLlamaCppStreamFn({})(
        { ...model, reasoning: true },
        {
          messages: [{ role: "user", content: "Why?", timestamp: 1 }],
          tools: [{ name: "weather", description: "Weather", parameters: { type: "object" } }],
        },
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: {
        content: [
          { type: "thinking", thinking: "First reason." },
          { type: "text", text: "Answer." },
          { type: "toolCall", name: "weather", arguments: { city: "Paris" } },
        ],
      },
    });
    expect(events.find((event) => event.type === "thinking_delta")).toMatchObject({
      contentIndex: 0,
      partial: { content: [{ type: "thinking", thinking: "First " }] },
    });
    expect(events.find((event) => event.type === "toolcall_start")).toMatchObject({
      contentIndex: 2,
    });
  });

  it("closes native reasoning before streaming a completed tool call", async () => {
    mocks.generateResponse.mockImplementationOnce(async (_history, options) => {
      options.onResponseChunk({
        type: "segment",
        segmentType: "thought",
        text: "Need current weather.",
        tokens: [1],
      });
      options.onFunctionCallParamsChunk({
        callIndex: 0,
        functionName: "weather",
        paramsChunk: '{"city":"Paris"}',
        done: true,
      });
      return {
        response: "",
        functionCalls: [{ functionName: "weather", params: { city: "Paris" }, raw: [] }],
        metadata: { stopReason: "functionCalls" },
      };
    });

    const events = await collectEvents(
      await createLlamaCppStreamFn({})(
        { ...model, reasoning: true },
        {
          messages: [{ role: "user", content: "Weather?", timestamp: 1 }],
          tools: [{ name: "weather", description: "Weather", parameters: { type: "object" } }],
        },
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(events.find((event) => event.type === "toolcall_start")).toMatchObject({
      contentIndex: 1,
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "toolUse",
      message: {
        content: [
          { type: "thinking", thinking: "Need current weather." },
          { type: "toolCall", name: "weather", arguments: { city: "Paris" } },
        ],
      },
    });
  });

  it("opens a new indexed block for every thought segment after visible text", async () => {
    mocks.generateResponse.mockImplementationOnce(async (_history, options) => {
      options.onResponseChunk({
        type: "segment",
        segmentType: "thought",
        text: "First thought.",
        tokens: [1],
        segmentEndTime: new Date(1),
      });
      options.onTextChunk("First answer.");
      options.onResponseChunk({
        type: "segment",
        segmentType: "thought",
        text: "Second thought.",
        tokens: [2],
        segmentEndTime: new Date(2),
      });
      options.onTextChunk("Second answer.");
      return {
        response: "First answer.Second answer.",
        functionCalls: undefined,
        metadata: { stopReason: "eogToken" },
      };
    });

    const events = await collectEvents(
      await createLlamaCppStreamFn({})(
        { ...model, reasoning: true },
        { messages: [{ role: "user", content: "Reason twice", timestamp: 1 }] },
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(
      events
        .filter((event) => event.type === "thinking_start" || event.type === "text_start")
        .map((event) => event.contentIndex),
    ).toEqual([0, 1, 2, 3]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: {
        content: [
          { type: "thinking", thinking: "First thought." },
          { type: "text", text: "First answer." },
          { type: "thinking", thinking: "Second thought." },
          { type: "text", text: "Second answer." },
        ],
      },
    });
  });

  it("builds a JSON Schema grammar for tool-free responseFormat requests", async () => {
    const schema = {
      type: "object",
      properties: { reply: { type: "string" } },
      required: ["reply"],
      additionalProperties: false,
    };
    const stream = await createLlamaCppStreamFn({})(
      model,
      { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      { responseFormat: schema },
    );

    await collectEvents(stream);

    expect(mocks.llama.createGrammarForJsonSchema).toHaveBeenCalledWith(schema);
    expect(mocks.generateResponse.mock.calls[0]?.[1]).toMatchObject({
      grammar: { schema },
    });
    expect(mocks.generateResponse.mock.calls[0]?.[1]).not.toHaveProperty("functions");
  });

  it("unwraps provider-shaped json_schema response formats", async () => {
    const schema = {
      type: "object",
      properties: { reply: { type: "string" } },
      required: ["reply"],
      additionalProperties: false,
    };
    const stream = await createLlamaCppStreamFn({})(
      model,
      { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      {
        responseFormat: {
          type: "json_schema",
          json_schema: { name: "planner", schema },
        },
      },
    );

    await collectEvents(stream);

    expect(mocks.llama.createGrammarForJsonSchema).toHaveBeenCalledWith(schema);
    expect(mocks.generateResponse.mock.calls[0]?.[1]).toMatchObject({ grammar: { schema } });
  });

  it("maps provider-shaped json_object response formats to the JSON grammar", async () => {
    const stream = await createLlamaCppStreamFn({})(
      model,
      { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      { responseFormat: { type: "json_object" } },
    );

    await collectEvents(stream);

    expect(mocks.llama.getGrammarFor).toHaveBeenCalledWith("json");
    expect(mocks.generateResponse.mock.calls[0]?.[1]).toMatchObject({
      grammar: { type: "json" },
    });
  });

  it("maps an empty JSON Schema to the generic JSON grammar", async () => {
    const stream = await createLlamaCppStreamFn({})(
      model,
      { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      { responseFormat: {} },
    );

    await collectEvents(stream);

    expect(mocks.llama.getGrammarFor).toHaveBeenCalledWith("json");
    expect(mocks.generateResponse.mock.calls[0]?.[1]).toMatchObject({
      grammar: { type: "json" },
    });
  });

  it("keeps provider-shaped text response formats unconstrained", async () => {
    const stream = await createLlamaCppStreamFn({})(
      model,
      { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      { responseFormat: { type: "text" } },
    );

    await collectEvents(stream);

    expect(mocks.llama.getGrammarFor).not.toHaveBeenCalled();
    expect(mocks.llama.createGrammarForJsonSchema).not.toHaveBeenCalled();
    expect(mocks.generateResponse.mock.calls[0]?.[1]).not.toHaveProperty("grammar");
  });

  it("streams the complete lifecycle for native function calls", async () => {
    mocks.generateResponse.mockResolvedValueOnce({
      response: "",
      functionCalls: [{ functionName: "weather", params: { city: "Paris" }, raw: [] }],
      metadata: { stopReason: "functionCalls" },
    });
    const stream = await createLlamaCppStreamFn({})(model, {
      messages: [{ role: "user", content: "Weather?", timestamp: 1 }],
      tools: [
        {
          name: "weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });

    const events = await collectEvents(stream);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const toolCallStart = events[1];
    const toolCallDelta = events[2];
    const toolCallEnd = events[3];
    expect(toolCallStart).toMatchObject({
      type: "toolcall_start",
      contentIndex: 0,
      partial: { content: [{ type: "toolCall", name: "weather", arguments: {} }] },
    });
    expect(toolCallDelta).toMatchObject({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"city":"Paris"}',
    });
    expect(toolCallEnd).toMatchObject({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { name: "weather", arguments: { city: "Paris" } },
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "toolUse",
      message: {
        content: [
          {
            type: "toolCall",
            id: expect.stringMatching(/^llama_cpp_call_/),
            name: "weather",
            arguments: { city: "Paris" },
          },
        ],
      },
    });
    expect(mocks.llama.createGrammarForJsonSchema).not.toHaveBeenCalled();
  });

  it("streams split native arguments with stable ids after mixed text", async () => {
    mocks.generateResponse.mockImplementationOnce(async (_history, options) => {
      options.onTextChunk("Checking both.");
      options.onFunctionCallParamsChunk({
        callIndex: 0,
        functionName: "weather",
        paramsChunk: '{"city":',
        done: false,
      });
      options.onFunctionCallParamsChunk({
        callIndex: 0,
        functionName: "weather",
        paramsChunk: '"Paris"}',
        done: true,
      });
      options.onFunctionCallParamsChunk({
        callIndex: 1,
        functionName: "calendar",
        paramsChunk: '{"day":"today"}',
        done: true,
      });
      return {
        response: "Checking both.",
        functionCalls: [
          { functionName: "weather", params: { city: "Paris" }, raw: [] },
          { functionName: "calendar", params: { day: "today" }, raw: [] },
        ],
        metadata: { stopReason: "functionCalls" },
      };
    });

    const stream = await createLlamaCppStreamFn({})(model, {
      messages: [{ role: "user", content: "Check both", timestamp: 1 }],
      tools: [
        { name: "weather", description: "Weather", parameters: { type: "object" } },
        { name: "calendar", description: "Calendar", parameters: { type: "object" } },
      ],
    });
    const events = await collectEvents(stream);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "toolcall_end",
      "done",
    ]);
    const toolDeltas = events.filter((event) => event.type === "toolcall_delta");
    expect(
      events.find((event) => event.type === "toolcall_start")?.partial.content[1],
    ).toMatchObject({
      arguments: {},
    });
    expect(toolDeltas).toMatchObject([
      { contentIndex: 1, delta: '{"city":', partial: { content: [{}, { arguments: {} }] } },
      {
        contentIndex: 1,
        delta: '"Paris"}',
        partial: { content: [{}, { arguments: { city: "Paris" } }] },
      },
      {
        contentIndex: 2,
        delta: '{"day":"today"}',
        partial: { content: [{}, {}, { arguments: { day: "today" } }] },
      },
    ]);
    const toolEnds = events.filter((event) => event.type === "toolcall_end");
    expect(toolEnds).toMatchObject([
      { contentIndex: 1, toolCall: { name: "weather", arguments: { city: "Paris" } } },
      { contentIndex: 2, toolCall: { name: "calendar", arguments: { day: "today" } } },
    ]);
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: "done",
      reason: "toolUse",
      message: {
        content: [
          { type: "text", text: "Checking both." },
          { type: "toolCall", name: "weather", arguments: { city: "Paris" } },
          { type: "toolCall", name: "calendar", arguments: { day: "today" } },
        ],
      },
    });
    if (done?.type === "done") {
      expect(toolEnds.map((event) => event.toolCall.id)).toEqual(
        done.message.content
          .filter((content) => content.type === "toolCall")
          .map((content) => content.id),
      );
    }
  });

  it("never completes or executes an interrupted native call at the token limit", async () => {
    mocks.generateResponse.mockImplementationOnce(async (_history, options) => {
      options.onFunctionCallParamsChunk({
        callIndex: 0,
        functionName: "weather",
        paramsChunk: '{"city":',
        done: false,
      });
      return {
        response: "",
        functionCalls: undefined,
        metadata: { stopReason: "maxTokens" },
      };
    });

    const events = await collectEvents(
      await createLlamaCppStreamFn({})(model, {
        messages: [{ role: "user", content: "Weather?", timestamp: 1 }],
        tools: [{ name: "weather", description: "Weather", parameters: { type: "object" } }],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "length",
      message: { content: [], stopReason: "length" },
    });
  });

  it("never completes a native call when its final argument reaches the token limit", async () => {
    mocks.generateResponse.mockImplementationOnce(async (_history, options) => {
      options.onFunctionCallParamsChunk({
        callIndex: 0,
        functionName: "weather",
        paramsChunk: '{"city":"Paris"}',
        done: true,
      });
      return {
        response: "",
        functionCalls: undefined,
        metadata: { stopReason: "maxTokens" },
      };
    });

    const events = await collectEvents(
      await createLlamaCppStreamFn({})(model, {
        messages: [{ role: "user", content: "Weather?", timestamp: 1 }],
        tools: [{ name: "weather", description: "Weather", parameters: { type: "object" } }],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "length",
      message: { content: [], stopReason: "length" },
    });
  });

  it("never lets completed native calls override the authoritative token-limit terminal", async () => {
    mocks.generateResponse.mockImplementationOnce(async (_history, options) => {
      options.onFunctionCallParamsChunk({
        callIndex: 0,
        functionName: "weather",
        paramsChunk: '{"city":"Paris"}',
        done: true,
      });
      options.onFunctionCallParamsChunk({
        callIndex: 1,
        functionName: "calendar",
        paramsChunk: '{"day":',
        done: false,
      });
      return {
        response: "",
        functionCalls: [{ functionName: "weather", params: { city: "Paris" }, raw: [] }],
        metadata: { stopReason: "maxTokens" },
      };
    });

    const events = await collectEvents(
      await createLlamaCppStreamFn({})(model, {
        messages: [{ role: "user", content: "Check both", timestamp: 1 }],
        tools: [
          { name: "weather", description: "Weather", parameters: { type: "object" } },
          { name: "calendar", description: "Calendar", parameters: { type: "object" } },
        ],
      }),
    );

    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "length",
      message: {
        stopReason: "length",
        content: [],
      },
    });
  });

  it.each([
    {
      format: "Harmony",
      text: '<|channel|>commentary to=weather code<|message|>{"city":"Paris"}<|call|>',
    },
    {
      format: "bracketed",
      text: '[weather]\n{"city":"Paris"}\n[END_TOOL_REQUEST]',
    },
  ])("promotes $format plaintext tool calls into native tool events", async ({ text }) => {
    mocks.generateResponse.mockImplementationOnce(async (_history, options) => {
      options.onTextChunk(text.slice(0, 12));
      options.onTextChunk(text.slice(12));
      return {
        response: text,
        functionCalls: undefined,
        metadata: { stopReason: "eogToken" },
      };
    });

    const stream = await createLlamaCppStreamFn({})(model, {
      messages: [{ role: "user", content: "Weather?", timestamp: 1 }],
      tools: [
        {
          name: "weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });

    const events = await collectEvents(stream);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "toolUse",
      message: {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            name: "weather",
            arguments: { city: "Paris" },
          },
        ],
      },
    });
  });

  it("preserves plaintext calls for tools that are not registered", async () => {
    const text = '[tool:calendar] {"city":"Paris"}';
    mocks.generateResponse.mockImplementationOnce(async (_history, options) => {
      options.onTextChunk(text);
      return {
        response: text,
        functionCalls: undefined,
        metadata: { stopReason: "eogToken" },
      };
    });

    const stream = await createLlamaCppStreamFn({})(model, {
      messages: [{ role: "user", content: "Weather?", timestamp: 1 }],
      tools: [
        {
          name: "weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });

    const events = await collectEvents(stream);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "stop",
      message: { content: [{ type: "text", text }] },
    });
  });

  it("lets tools win when responseFormat is also present", async () => {
    const stream = await createLlamaCppStreamFn({})(
      model,
      {
        messages: [{ role: "user", content: "Weather?", timestamp: 1 }],
        tools: [
          {
            name: "weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
      },
      {
        responseFormat: {
          type: "object",
          properties: { reply: { type: "string" } },
          required: ["reply"],
          additionalProperties: false,
        },
      },
    );

    await collectEvents(stream);

    expect(mocks.llama.createGrammarForJsonSchema).not.toHaveBeenCalled();
    expect(mocks.generateResponse.mock.calls[0]?.[1]).toMatchObject({
      functions: { weather: expect.any(Object) },
      documentFunctionParams: true,
    });
    expect(mocks.generateResponse.mock.calls[0]?.[1]).not.toHaveProperty("grammar");
  });

  it("disposes the previous model and context when the model changes", async () => {
    const streamFn = createLlamaCppStreamFn({});
    await collectEvents(
      await streamFn(model, { messages: [{ role: "user", content: "one", timestamp: 1 }] }),
    );
    await collectEvents(
      await streamFn(
        { ...model, id: "other.gguf", params: { modelPath: "other.gguf" } },
        { messages: [{ role: "user", content: "two", timestamp: 2 }] },
      ),
    );

    expect(mocks.contextDispose).toHaveBeenCalledTimes(1);
    expect(mocks.modelDispose).toHaveBeenCalledTimes(1);
    expect(mocks.llama.loadModel).toHaveBeenCalledTimes(2);
  });

  it("reuses one context sequence across serialized requests for the same model", async () => {
    const streamFn = createLlamaCppStreamFn({});
    await collectEvents(
      await streamFn(model, { messages: [{ role: "user", content: "one", timestamp: 1 }] }),
    );
    await collectEvents(
      await streamFn(model, { messages: [{ role: "user", content: "two", timestamp: 2 }] }),
    );

    expect(mocks.context.getSequence).toHaveBeenCalledTimes(1);
    expect(mocks.llama.loadModel).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      scenario: "a smaller advertised model window",
      model: { ...model, contextWindow: 4096, contextTokens: undefined },
      expectedContextSize: { max: 4096 },
      expectedGpuFit: 4096,
    },
    {
      scenario: "the safe default below a larger advertised window",
      model: { ...model, contextWindow: 32_768, contextTokens: undefined },
      expectedContextSize: { max: 8192 },
      expectedGpuFit: 8192,
    },
    {
      scenario: "an explicit practical runtime cap",
      model: { ...model, contextWindow: 8192, contextTokens: 3072 },
      expectedContextSize: { max: 3072 },
      expectedGpuFit: 3072,
    },
    {
      scenario: "an explicitly configured native context size",
      model: { ...model, contextTokens: 4096, params: { ...model.params, contextSize: 2048 } },
      expectedContextSize: 2048,
      expectedGpuFit: 2048,
    },
  ])("bounds native context and GPU allocation by $scenario", async (scenario) => {
    await collectEvents(
      await createLlamaCppStreamFn({})(scenario.model, {
        messages: [{ role: "user", content: "Hi", timestamp: 1 }],
      }),
    );
    expect(mocks.model.createContext).toHaveBeenCalledWith(
      expect.objectContaining({ contextSize: scenario.expectedContextSize }),
    );
    expect(mocks.llama.loadModel).toHaveBeenCalledWith(
      expect.objectContaining({
        gpuLayers: { fitContext: { contextSize: scenario.expectedGpuFit } },
      }),
    );
  });

  it("expands home-relative local model paths before resolving the file", async () => {
    const stream = await createLlamaCppStreamFn({})(
      { ...model, params: { modelPath: "~/Models/test.gguf" } },
      { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
    );

    await collectEvents(stream);

    expect(mocks.resolveModelFile).toHaveBeenCalledWith(
      path.join(os.homedir(), "Models", "test.gguf"),
      expect.objectContaining({ download: false }),
    );
  });

  it("preserves streamed text in a terminal error message", async () => {
    mocks.generateResponse.mockImplementationOnce(async (_history, options) => {
      options.onTextChunk("Partial");
      throw new Error("generation failed");
    });
    const stream = await createLlamaCppStreamFn({})(model, {
      messages: [{ role: "user", content: "Hi", timestamp: 1 }],
    });

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      content: [{ type: "text", text: "Partial" }],
      errorMessage: expect.stringContaining("generation failed"),
    });
  });

  it("returns an aborted stream error when the signal is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = await createLlamaCppStreamFn({})(
      model,
      { messages: [{ role: "user", content: "stop", timestamp: 1 }] },
      { signal: controller.signal },
    );

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    });
    expect(mocks.generateResponse).not.toHaveBeenCalled();
  });

  it("maps a native abort result to an aborted stream error", async () => {
    mocks.generateResponse.mockResolvedValueOnce({
      response: "",
      functionCalls: undefined,
      metadata: { stopReason: "abort" },
    });
    const stream = await createLlamaCppStreamFn({})(model, {
      messages: [{ role: "user", content: "stop", timestamp: 1 }],
    });

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    });
  });

  it("ends an aborted queued request without loading or switching its model", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    mocks.generateResponse.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const streamFn = createLlamaCppStreamFn({});
    const firstStream = await streamFn(model, {
      messages: [{ role: "user", content: "first", timestamp: 1 }],
    });
    await vi.waitFor(() => expect(mocks.generateResponse).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const queuedStream = await streamFn(
      { ...model, id: "other.gguf", params: { modelPath: "other.gguf" } },
      { messages: [{ role: "user", content: "second", timestamp: 2 }] },
      { signal: controller.signal },
    );

    controller.abort();
    await expect(queuedStream.result()).resolves.toMatchObject({ stopReason: "aborted" });
    expect(mocks.llama.loadModel).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      response: "",
      functionCalls: undefined,
      metadata: { stopReason: "eogToken" },
    });
    await firstStream.result();
  });
});
