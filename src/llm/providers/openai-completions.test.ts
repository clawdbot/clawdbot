// OpenAI completions tests cover chat completion stream adaptation.
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { describe, expect, it, vi } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../agents/system-prompt-cache-boundary.js";
import type { Context, Model } from "../types.js";

type DeepPartial<T> = { [P in keyof T]?: DeepPartial<T[P]> };
type OpenAICompatibleDelta = DeepPartial<ChatCompletionChunk["choices"][number]["delta"]> & {
  reasoning_content?: string;
};
type OpenAICompatibleChoice = Omit<DeepPartial<ChatCompletionChunk["choices"][number]>, "delta"> & {
  delta?: OpenAICompatibleDelta;
};
type OpenAICompatibleChatCompletionChunk = Omit<DeepPartial<ChatCompletionChunk>, "choices"> & {
  choices?: OpenAICompatibleChoice[];
};

const mockChunksRef: { chunks: OpenAICompatibleChatCompletionChunk[] } = { chunks: [] };

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

const reasoningModel = {
  ...model,
  reasoning: true,
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

function makeTextChunk(text: string): OpenAICompatibleChatCompletionChunk {
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
): OpenAICompatibleChatCompletionChunk {
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
): OpenAICompatibleChatCompletionChunk {
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

  it("keeps prompt cache keys when long retention is disabled", async () => {
    let capturedCacheKey: unknown;
    let capturedRetention: unknown;
    const stream = streamOpenAICompletions(
      {
        ...createModel(32_000),
        compat: {
          supportsPromptCacheKey: true,
          supportsLongCacheRetention: false,
        },
      },
      context,
      {
        apiKey: "sk-test",
        sessionId: "session-123",
        cacheRetention: "long",
        onPayload(payload) {
          capturedCacheKey = (payload as { prompt_cache_key?: unknown }).prompt_cache_key;
          capturedRetention = (payload as { prompt_cache_retention?: unknown })
            .prompt_cache_retention;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedCacheKey).toBe("session-123");
    expect(capturedRetention).toBeUndefined();
  });

  it("omits prompt cache retention when third-party models have not opted into cache keys", async () => {
    let capturedCacheKey: unknown;
    let capturedRetention: unknown;
    const stream = streamOpenAICompletions(createModel(32_000), context, {
      apiKey: "sk-test",
      sessionId: "session-123",
      cacheRetention: "long",
      onPayload(payload) {
        capturedCacheKey = (payload as { prompt_cache_key?: unknown }).prompt_cache_key;
        capturedRetention = (payload as { prompt_cache_retention?: unknown })
          .prompt_cache_retention;
        throw new Error("stop before network");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedCacheKey).toBeUndefined();
    expect(capturedRetention).toBeUndefined();
  });

  it("keeps OpenAI long retention even when no cache key is available", async () => {
    let capturedCacheKey: unknown;
    let capturedRetention: unknown;
    const stream = streamOpenAICompletions(model, context, {
      apiKey: "sk-test",
      cacheRetention: "long",
      onPayload(payload) {
        capturedCacheKey = (payload as { prompt_cache_key?: unknown }).prompt_cache_key;
        capturedRetention = (payload as { prompt_cache_retention?: unknown })
          .prompt_cache_retention;
        throw new Error("stop before network");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedCacheKey).toBeUndefined();
    expect(capturedRetention).toBe("24h");
  });

  it("strips the internal cache boundary from OpenAI-compatible system prompts", async () => {
    let capturedMessages: unknown;
    const stream = streamOpenAICompletions(
      createModel(32_000),
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      },
      {
        apiKey: "sk-test",
        onPayload(payload) {
          capturedMessages = (payload as { messages?: unknown }).messages;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    const messages = capturedMessages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({
      role: "system",
      content: "Stable prefix\nDynamic suffix",
    });
  });

  it("splits the cache boundary before applying Anthropic cache control for OpenRouter Anthropic models", async () => {
    let capturedMessages: unknown;
    const stream = streamOpenAICompletions(
      {
        ...createModel(32_000),
        id: "anthropic/claude-sonnet-4.6",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      },
      {
        apiKey: "sk-test",
        onPayload(payload) {
          capturedMessages = (payload as { messages?: unknown }).messages;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    const messages = capturedMessages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({
      role: "system",
      content: [
        {
          type: "text",
          text: "Stable prefix",
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: "Dynamic suffix",
        },
      ],
    });
  });

  it("adds reasoning_content replay fields for Xiaomi MiMo assistant tool history", async () => {
    let capturedMessages: unknown;
    const stream = streamOpenAICompletions(
      {
        ...createModel(32_000),
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro",
        provider: "xiaomi",
        baseUrl: "https://api.xiaomimimo.com/v1",
        reasoning: true,
      },
      {
        messages: [
          {
            role: "user",
            content: "search first",
            timestamp: 1,
          },
          {
            role: "assistant",
            api: "openai-completions",
            provider: "xiaomi",
            model: "mimo-v2.5-pro",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call_search",
                name: "search",
                arguments: { query: "MiMo docs" },
              },
            ],
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "call_search",
            toolName: "search",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 3,
          },
          {
            role: "user",
            content: "continue",
            timestamp: 4,
          },
        ],
      },
      {
        apiKey: "sk-test",
        onPayload(payload) {
          capturedMessages = (payload as { messages?: unknown }).messages;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    const messages = capturedMessages as Array<Record<string, unknown>>;
    expect(messages.find((message) => message.role === "assistant")).toMatchObject({
      role: "assistant",
      reasoning_content: "",
    });
  });
});

describe("openai-completions stop-reason tool-call guard", () => {
  it("keeps literal reasoning tag examples visible when no reasoning field is mirrored", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("Use `<think>private</think>` only as an example."),
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
    const result = await stream.result();

    expect(result.content).toContainEqual({
      type: "text",
      text: "Use `<think>private</think>` only as an example.",
    });
    expect(result.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it("keeps prose mentions of unclosed reasoning tags visible without mirrored reasoning", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("The <reasoning> tag is deprecated in this example."),
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
    const result = await stream.result();

    expect(result.content).toContainEqual({
      type: "text",
      text: "The <reasoning> tag is deprecated in this example.",
    });
    expect(result.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it("keeps prose mentions of unmatched close tags visible without mirrored reasoning", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("Use </think> to close the tag."),
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
    const result = await stream.result();

    expect(result.content).toContainEqual({
      type: "text",
      text: "Use </think> to close the tag.",
    });
    expect(result.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it("strips content-only reasoning tags from visible text", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("Before <think>private reasoning</think> after"),
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
    const result = await stream.result();

    expect(result.content).toContainEqual({
      type: "text",
      text: "Before  after",
    });
    expect(result.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it("recovers fully wrapped unclosed content-only reasoning tags", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("<think>Visible answer from a malformed local model"),
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
    const result = await stream.result();

    expect(result.content).toContainEqual({
      type: "text",
      text: "Visible answer from a malformed local model",
    });
  });

  it("keeps literal reasoning tag examples visible when reasoning is mirrored", async () => {
    mockChunksRef.chunks = [
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              content: "Use `<thi",
            },
          },
        ],
      },
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              content: "nk>private</think>` only as an example.",
              reasoning_content: "Actual hidden reasoning.",
            },
          },
        ],
      },
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
    const result = await stream.result();

    expect(result.content).toContainEqual({
      type: "text",
      text: "Use `<think>private</think>` only as an example.",
    });
    expect(result.content).toContainEqual({
      type: "thinking",
      thinking: "Actual hidden reasoning.",
      thinkingSignature: "reasoning_content",
    });
  });

  it("partitions inline reasoning tags out of visible text", async () => {
    mockChunksRef.chunks = [
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              content: "Before <thi",
            },
          },
        ],
      },
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              content: "nk>private reasoning</think> after",
              reasoning_content: "private reasoning",
            },
          },
        ],
      },
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
    const result = await stream.result();
    const visibleText = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    const thinkingText = result.content
      .filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");

    expect(visibleText).toBe("Before  after");
    expect(visibleText).not.toContain("private reasoning");
    expect(thinkingText).toBe("private reasoning");
  });

  it("does not recover unclosed reasoning tags when mirrored reasoning arrives later", async () => {
    mockChunksRef.chunks = [
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              content: "<think>private reasoning",
            },
          },
        ],
      },
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "private reasoning",
            },
          },
        ],
      },
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
    const result = await stream.result();
    const visibleText = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");

    expect(visibleText).toBe("");
    expect(result.content).toContainEqual({
      type: "thinking",
      thinking: "private reasoning",
      thinkingSignature: "reasoning_content",
    });
  });

  it("drops mirrored reasoning output when reasoning is disabled but keeps strict text partitioning", async () => {
    mockChunksRef.chunks = [
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              content: "<think>private reasoning",
            },
          },
        ],
      },
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "private reasoning",
            },
          },
        ],
      },
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
    });
    const result = await stream.result();
    const visibleText = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");

    expect(visibleText).toBe("");
    expect(result.content.some((block) => block.type === "thinking")).toBe(false);
  });

  it("promotes silent tool_calls with finish_reason stop to toolUse", async () => {
    mockChunksRef.chunks = [
      makeToolCallChunk("call_1", "bash", '{"cmd":"ls"}'),
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(model, context, {
      apiKey: "sk-test",
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("toolUse");
    const toolCalls = result.content.filter((b) => b.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
  });

  it("strips toolCall blocks when finish_reason is stop after visible text", async () => {
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

  it("keeps buffered visible text before following tool calls", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("Use <"),
      makeToolCallChunk("call_1", "bash", '{"cmd":"ls"}'),
      makeFinishChunk("tool_calls"),
    ];

    const stream = streamOpenAICompletions(model, context, {
      apiKey: "sk-test",
    });
    const result = await stream.result();

    expect(result.content[0]).toEqual({ type: "text", text: "Use <" });
    expect(result.content[1]).toMatchObject({ type: "toolCall", id: "call_1", name: "bash" });
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
