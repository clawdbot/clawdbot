import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

type DeepPartial<T> = { [P in keyof T]?: DeepPartial<T[P]> };

const mockChunksRef: { chunks: DeepPartial<ChatCompletionChunk>[] } = { chunks: [] };

vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: () => ({
          withResponse: async () => {
            async function* generate() {
              for (const chunk of mockChunksRef.chunks) {
                yield chunk;
              }
            }
            return {
              data: generate(),
              response: { status: 200, headers: new Headers() },
            };
          },
        }),
      },
    };
  }
  return { default: MockOpenAI };
});

import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "./openai-completions.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<"openai-completions">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function createModel(maxTokens: number): Model<"openai-completions"> {
  return {
    id: "custom-model",
    name: "Custom Model",
    api: "openai-completions",
    provider: "custom-openai-compatible",
    baseUrl: "https://third-party.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens,
  };
}

function makeTextChunk(text: string): DeepPartial<ChatCompletionChunk> {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, delta: { content: text, role: "assistant" } }],
  };
}

function makeToolCallChunk(
  id: string,
  name: string,
  args: string,
  finishReason?: string,
): DeepPartial<ChatCompletionChunk> {
  return {
    id: "chatcmpl-test",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: args }, type: "function" }],
        },
        finish_reason: finishReason as ChatCompletionChunk.Choice["finish_reason"],
      },
    ],
  };
}

function makeFinishChunk(
  finishReason: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): DeepPartial<ChatCompletionChunk> {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason as never }],
    ...(usage ? { usage } : {}),
  };
}

describe("OpenAI-compatible completions params", () => {
  it("clamps requested max tokens to the model output cap", async () => {
    let capturedMaxTokens: unknown;
    const stream = streamOpenAICompletions(createModel(32_000), context, {
      apiKey: "sk-test",
      maxTokens: 200_000,
      onPayload(payload) {
        capturedMaxTokens = (payload as { max_completion_tokens?: unknown }).max_completion_tokens;
        throw new Error("stop before network");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedMaxTokens).toBe(32_000);
  });

  it("forwards simple stop sequences to request params", async () => {
    let capturedStop: unknown;
    const stream = streamSimpleOpenAICompletions(createModel(32_000), context, {
      apiKey: "sk-test",
      stop: ["STOP"],
      onPayload(payload) {
        capturedStop = (payload as { stop?: unknown }).stop;
        throw new Error("stop before network");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedStop).toEqual(["STOP"]);
  });
});

describe("openai-completions stop-reason tool-call guard", () => {
  it("strips toolCall blocks when finish_reason is stop but tool_calls were accumulated", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("Hello"),
      makeToolCallChunk("call_1", "bash", '{"cmd":"ls"}'),
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(model, context, {
      apiKey: "sk-test",
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content.filter((b) => b.type === "toolCall")).toStrictEqual([]);
    expect(result.content.some((b) => b.type === "text")).toBe(true);
  });

  it("preserves toolCall blocks when finish_reason is tool_calls", async () => {
    mockChunksRef.chunks = [
      makeToolCallChunk("call_1", "bash", '{"cmd":"ls"}'),
      makeFinishChunk("tool_calls"),
    ];

    const stream = streamOpenAICompletions(model, context, {
      apiKey: "sk-test",
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    const toolCalls = result.content.filter((b) => b.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
  });

  it("strips toolCall blocks when finish_reason is length but tool_calls were accumulated", async () => {
    mockChunksRef.chunks = [
      makeToolCallChunk("call_1", "bash", '{"cmd":"ls"}'),
      makeFinishChunk("length"),
    ];

    const stream = streamOpenAICompletions(model, context, {
      apiKey: "sk-test",
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("length");
    expect(result.content.filter((b) => b.type === "toolCall")).toStrictEqual([]);
  });

  it("downgrades toolUse stop reason when finish_reason is tool_calls but no tool_calls accumulated", async () => {
    mockChunksRef.chunks = [makeTextChunk("Just text"), makeFinishChunk("tool_calls")];

    const stream = streamOpenAICompletions(model, context, {
      apiKey: "sk-test",
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content.filter((b) => b.type === "toolCall")).toStrictEqual([]);
  });
});
