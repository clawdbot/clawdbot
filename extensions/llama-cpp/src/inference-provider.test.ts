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
  });

  it("emits native function calls in the final assistant message", async () => {
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

    expect(events.map((event) => event.type)).toEqual(["done"]);
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
