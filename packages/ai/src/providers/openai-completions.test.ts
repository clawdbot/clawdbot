// OpenAI completions tests cover chat completion stream adaptation.
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model, SimpleStreamOptions, TextContent } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";

type DeepPartial<T> = { [P in keyof T]?: DeepPartial<T[P]> };
type OpenAICompatibleDelta = DeepPartial<ChatCompletionChunk["choices"][number]["delta"]> & {
  reasoning_content?: string;
};
type OpenAICompatibleChoice = Omit<
  DeepPartial<ChatCompletionChunk["choices"][number]>,
  "delta" | "message"
> & {
  delta?: OpenAICompatibleDelta;
  // Some OpenAI-compatible endpoints deliver a full message instead of delta.
  message?: OpenAICompatibleDelta;
};
type OpenAICompatibleChatCompletionChunk = Omit<
  DeepPartial<ChatCompletionChunk>,
  "choices" | "usage"
> & {
  choices?: OpenAICompatibleChoice[];
  usage?: DeepPartial<ChatCompletionChunk["usage"]> & { cost?: unknown };
};
type FirstEventSimpleStreamOptions = SimpleStreamOptions & {
  firstEventTimeoutMs?: number;
  onFirstEventTimeout?: (reason: Error) => void;
};

const mockChunksRef: {
  chunks: OpenAICompatibleChatCompletionChunk[];
  stream?: AsyncIterable<OpenAICompatibleChatCompletionChunk>;
} = { chunks: [] };
const mockOpenAIOptionsRef: { options: unknown[]; payloads: unknown[]; requests: unknown[] } = {
  options: [],
  payloads: [],
  requests: [],
};

vi.mock("openai", () => {
  class MockOpenAI {
    constructor(options: unknown) {
      mockOpenAIOptionsRef.options.push(options);
    }

    chat = {
      completions: {
        create: (params: unknown, requestOptions: unknown) => {
          mockOpenAIOptionsRef.payloads.push(params);
          mockOpenAIOptionsRef.requests.push(requestOptions);
          return {
            withResponse: async () => {
              if (mockChunksRef.stream) {
                return {
                  data: mockChunksRef.stream,
                  response: { status: 200, headers: new Headers() },
                };
              }
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
          };
        },
      },
    };
  }
  return { default: MockOpenAI };
});

import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "./openai-completions.js";

beforeEach(() => {
  mockChunksRef.chunks = [];
  mockChunksRef.stream = undefined;
  mockOpenAIOptionsRef.payloads = [];
  mockOpenAIOptionsRef.requests = [];
});

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

function makeRefusalChunk(refusal: string): OpenAICompatibleChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: null, refusal },
        finish_reason: "stop",
      },
    ],
  };
}

function makeRefusalMessageChunk(refusal: string): OpenAICompatibleChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, refusal },
        finish_reason: "stop",
      },
    ],
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
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: unknown;
  },
): OpenAICompatibleChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason as never }],
    ...(usage ? { usage } : {}),
  };
}

function createNeverYieldingStream(): AsyncIterable<OpenAICompatibleChatCompletionChunk> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return new Promise<IteratorResult<OpenAICompatibleChatCompletionChunk>>(() => {});
        },
      };
    },
  };
}

describe("OpenAI-compatible completions params", () => {
  it("omits reasoning_effort when deepseek-format compatibility disables it", async () => {
    mockChunksRef.chunks = [makeTextChunk("ok"), makeFinishChunk("stop")];
    const compatibleModel = {
      ...reasoningModel,
      provider: "longcat",
      baseUrl: "https://api.longcat.chat/openai",
      compat: {
        thinkingFormat: "deepseek" as const,
        supportsReasoningEffort: false,
      },
    } satisfies Model<"openai-completions">;

    const stream = streamOpenAICompletions(compatibleModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "high",
    });
    await stream.result();

    expect(mockOpenAIOptionsRef.payloads[0]).toMatchObject({
      thinking: { type: "enabled" },
    });
    expect(mockOpenAIOptionsRef.payloads[0]).not.toHaveProperty("reasoning_effort");
  });

  it("configures the OpenAI SDK client with the host-built model fetch", async () => {
    mockOpenAIOptionsRef.options = [];
    mockChunksRef.chunks = [makeTextChunk("ok"), makeFinishChunk("stop")];
    const hostFetch: typeof fetch = async () => new Response(null, { status: 500 });
    configureAiTransportHost({ buildModelFetch: () => hostFetch });

    try {
      const stream = streamOpenAICompletions(model, context, {
        apiKey: "sk-test",
      });
      const result = await stream.result();

      expect(result.stopReason).toBe("stop");
      expect(mockOpenAIOptionsRef.options).toHaveLength(1);
      expect(mockOpenAIOptionsRef.options[0]).toMatchObject({
        baseURL: "https://api.openai.com/v1",
        dangerouslyAllowBrowser: true,
      });
      expect((mockOpenAIOptionsRef.options[0] as { fetch?: unknown }).fetch).toBe(hostFetch);
    } finally {
      configureAiTransportHost({});
    }
  });

  it("surfaces chat-completions refusal deltas as visible assistant text", async () => {
    mockChunksRef.chunks = [makeRefusalChunk("I can't help with that.")];

    const result = await streamOpenAICompletions(model, context, {
      apiKey: "sk-test",
    }).result();

    expect(result.content).toStrictEqual([{ type: "text", text: "I can't help with that." }]);
    expect(result.stopReason).toBe("stop");
  });

  it("surfaces aggregated chat-completions message.refusal as visible assistant text", async () => {
    mockChunksRef.chunks = [makeRefusalMessageChunk("Requests like this are not allowed.")];

    const result = await streamOpenAICompletions(model, context, {
      apiKey: "sk-test",
    }).result();

    expect(result.content).toStrictEqual([
      { type: "text", text: "Requests like this are not allowed." },
    ]);
    expect(result.stopReason).toBe("stop");
  });

  it("tags pre-tool narration as commentary on tool turns", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("Importing ORDER-1234 into the tracker…"),
      makeToolCallChunk("call_import", "import_order", '{"id":"ORDER-1234"}'),
      makeFinishChunk("tool_calls"),
    ];

    const result = await streamOpenAICompletions(model, context, { apiKey: "sk-test" }).result();
    const textBlock = result.content.find((block) => block.type === "text") as
      | TextContent
      | undefined;

    expect(result.stopReason).toBe("toolUse");
    expect(JSON.parse(String(textBlock?.textSignature))).toMatchObject({
      v: 1,
      phase: "commentary",
    });
  });

  it("rolls back provisional tags when spurious tool calls are stripped", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("Here is the answer."),
      makeToolCallChunk("call_spurious", "noop", "{}"),
      makeFinishChunk("stop"),
    ];

    const result = await streamOpenAICompletions(model, context, { apiKey: "sk-test" }).result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toStrictEqual([{ type: "text", text: "Here is the answer." }]);
  });

  it("does not tag ordinary text when a provider emits an empty tool_calls array", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("Ordinary answer."),
      {
        id: "chatcmpl-test",
        choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: "stop" }],
      },
    ];

    const result = await streamOpenAICompletions(model, context, { apiKey: "sk-test" }).result();

    expect(result.content).toStrictEqual([{ type: "text", text: "Ordinary answer." }]);
  });

  it("preserves a valid provider-reported usage cost", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("ok"),
      makeFinishChunk("stop", {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost: 0,
      }),
    ];
    const pricedModel = {
      ...model,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    } satisfies Model<"openai-completions">;

    const result = await streamOpenAICompletions(pricedModel, context, {
      apiKey: "sk-test",
    }).result();

    expect(result.usage.cost.total).toBe(0);
    expect(result.usage.cost.totalOrigin).toBe("provider-billed");
  });

  it("keeps the catalog estimate for an invalid provider-reported usage cost", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("ok"),
      makeFinishChunk("stop", {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost: -1,
      }),
    ];
    const pricedModel = {
      ...model,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    } satisfies Model<"openai-completions">;

    const result = await streamOpenAICompletions(pricedModel, context, {
      apiKey: "sk-test",
    }).result();

    expect(result.usage.cost.total).toBeCloseTo(0.00002);
    expect(result.usage.cost.totalOrigin).toBeUndefined();
  });

  it("fails when streaming headers arrive but no first SSE event follows", async () => {
    vi.useFakeTimers();
    try {
      mockChunksRef.stream = createNeverYieldingStream();
      const onFirstEventTimeout = vi.fn();

      const stream = streamOpenAICompletions(model, context, {
        apiKey: "sk-test",
        firstEventTimeoutMs: 5,
        onFirstEventTimeout,
      } as FirstEventSimpleStreamOptions);
      const resultPromise = stream.result();

      await vi.advanceTimersByTimeAsync(5);
      const result = await resultPromise;

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(
        /completions HTTP stream opened but did not deliver a first SSE event within 5ms/,
      );
      expect(result.errorMessage).toContain("provider=openai");
      expect(result.errorMessage).toContain("api=openai-completions");
      expect(result.errorMessage).toContain("model=gpt-5.5");
      const signal = (mockOpenAIOptionsRef.requests[0] as { signal?: AbortSignal } | undefined)
        ?.signal;
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBeInstanceOf(Error);
      expect(onFirstEventTimeout).toHaveBeenCalledWith(signal?.reason);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the first-event timeout through the simple completions wrapper", async () => {
    vi.useFakeTimers();
    try {
      mockChunksRef.stream = createNeverYieldingStream();

      const simpleOptions: FirstEventSimpleStreamOptions = {
        apiKey: "sk-test",
        firstEventTimeoutMs: 5,
        onFirstEventTimeout: vi.fn(),
      };
      const stream = streamSimpleOpenAICompletions(model, context, simpleOptions);
      const resultPromise = stream.result();

      await vi.advanceTimersByTimeAsync(5);
      const result = await resultPromise;

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(
        /completions HTTP stream opened but did not deliver a first SSE event within 5ms/,
      );
      expect(simpleOptions.onFirstEventTimeout).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips unreadable schemas while preserving healthy official OpenAI tools", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const stream = streamOpenAICompletions(
      model,
      {
        ...context,
        tools: [
          {
            name: "broken",
            description: "Broken",
            parameters: {
              type: "object",
              get properties(): never {
                throw new Error("properties exploded");
              },
            },
          },
          {
            name: "lookup",
            description: "Lookup",
            parameters: {},
          },
        ],
      },
      {
        apiKey: "sk-test",
        toolChoice: { type: "function", function: { name: "lookup" } },
        onPayload(payload) {
          capturedPayload = payload as Record<string, unknown>;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedPayload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: {},
          strict: false,
        },
      },
    ]);
    expect(capturedPayload?.tool_choice).toEqual({
      type: "function",
      function: { name: "lookup" },
    });
  });

  it("fails locally when a pinned official OpenAI tool is unreadable", async () => {
    const stream = streamOpenAICompletions(
      model,
      {
        ...context,
        tools: [
          {
            name: "broken",
            description: "Broken tool.",
            get parameters(): never {
              throw new Error("parameters exploded");
            },
          },
        ],
      },
      {
        apiKey: "sk-test",
        toolChoice: { type: "function", function: { name: "broken" } },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('requested unavailable tool "broken"');
  });

  it("preserves the empty tools marker for tool history after quarantining every schema", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const stream = streamOpenAICompletions(
      model,
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_abc",
                name: "lookup",
                arguments: {},
              },
            ],
          },
          {
            role: "toolResult",
            content: [{ type: "text", text: "done" }],
            toolCallId: "call_abc",
          },
          ...context.messages,
        ],
        tools: [
          {
            name: "broken",
            description: "Broken tool.",
            get parameters(): never {
              throw new Error("parameters exploded");
            },
          },
        ],
      } as never,
      {
        apiKey: "sk-test",
        onPayload(payload) {
          capturedPayload = payload as Record<string, unknown>;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedPayload?.tools).toEqual([]);
  });

  it("replays update_plan-style empty non-image tool results as no output", async () => {
    let capturedMessages:
      | Array<{ role?: string; content?: unknown; tool_call_id?: string }>
      | undefined;
    const stream = streamOpenAICompletions(
      model,
      {
        messages: [
          {
            role: "assistant",
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
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "call_plan", name: "update_plan", arguments: {} }],
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call_plan",
            toolName: "update_plan",
            content: [],
            isError: false,
            timestamp: 2,
          },
        ],
      } as never,
      {
        apiKey: "sk-test",
        onPayload(payload) {
          capturedMessages = (payload as { messages?: typeof capturedMessages }).messages;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedMessages?.find((message) => message.role === "tool")).toMatchObject({
      role: "tool",
      content: "(no output)",
      tool_call_id: "call_plan",
    });
  });

  it("does not emit image turns or placeholders for payload-less tool media", async () => {
    let capturedMessages:
      | Array<{ role?: string; content?: unknown; tool_call_id?: string }>
      | undefined;
    const stream = streamOpenAICompletions(
      { ...model, input: ["text", "image"] },
      {
        messages: [
          {
            role: "assistant",
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
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "call_husk", name: "screenshot", arguments: {} }],
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call_husk",
            toolName: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "" }],
            isError: false,
            timestamp: 2,
          },
        ],
      } as never,
      {
        apiKey: "sk-test",
        onPayload(payload) {
          capturedMessages = (payload as { messages?: typeof capturedMessages }).messages;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedMessages?.find((message) => message.role === "tool")).toMatchObject({
      role: "tool",
      content: "(no output)",
      tool_call_id: "call_husk",
    });
    expect(JSON.stringify(capturedMessages)).not.toContain("image_url");
    expect(JSON.stringify(capturedMessages)).not.toContain("see attached image");
  });

  it("preserves image-bearing tool results with image placeholders and attachments", async () => {
    let capturedMessages:
      | Array<{ role?: string; content?: unknown; tool_call_id?: string }>
      | undefined;
    const stream = streamOpenAICompletions(
      { ...model, input: ["text", "image"] },
      {
        messages: [
          {
            role: "assistant",
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
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "call_shot", name: "screenshot", arguments: {} }],
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call_shot",
            toolName: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "aW1n" }],
            isError: false,
            timestamp: 2,
          },
        ],
      } as never,
      {
        apiKey: "sk-test",
        onPayload(payload) {
          capturedMessages = (payload as { messages?: typeof capturedMessages }).messages;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedMessages?.find((message) => message.role === "tool")).toMatchObject({
      role: "tool",
      content: "(see attached image)",
      tool_call_id: "call_shot",
    });
    expect(capturedMessages?.find((message) => Array.isArray(message.content))).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Attached image(s) from tool result:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
      ],
    });
  });

  it("does not reread an unreadable tool inventory length", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const tools = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("length exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const stream = streamOpenAICompletions(model, { ...context, tools } as never, {
      apiKey: "sk-test",
      onPayload(payload) {
        capturedPayload = payload as Record<string, unknown>;
        throw new Error("stop before network");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedPayload).not.toHaveProperty("tools");
  });

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

  it("uses Z.AI max_tokens and disables thinking by default", async () => {
    const stream = streamOpenAICompletions(
      {
        ...createModel(32_000),
        provider: "zai",
        baseUrl: "https://api.z.ai/api/paas/v4",
        reasoning: true,
      },
      context,
      {
        apiKey: "sk-test",
        maxTokens: 1_024,
      },
    );

    await stream.result();

    expect(mockOpenAIOptionsRef.payloads[0]).toMatchObject({
      max_tokens: 1_024,
      thinking: { type: "disabled" },
    });
    expect(mockOpenAIOptionsRef.payloads[0]).not.toHaveProperty("max_completion_tokens");
    expect(mockOpenAIOptionsRef.payloads[0]).not.toHaveProperty("enable_thinking");
  });

  it("enables Z.AI thinking with the documented payload when requested", async () => {
    const stream = streamOpenAICompletions(
      {
        ...createModel(32_000),
        provider: "zai",
        baseUrl: "https://api.z.ai/api/paas/v4",
        reasoning: true,
      },
      context,
      {
        apiKey: "sk-test",
        reasoningEffort: "high",
      },
    );

    await stream.result();

    expect(mockOpenAIOptionsRef.payloads[0]).toMatchObject({
      thinking: { type: "enabled" },
    });
    expect(mockOpenAIOptionsRef.payloads[0]).not.toHaveProperty("enable_thinking");
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

  it("anchors the OpenRouter Anthropic cache marker on the last stable user turn, skipping a trailing runtime-context carrier", async () => {
    let capturedMessages: unknown;
    const stream = streamOpenAICompletions(
      {
        ...createModel(32_000),
        id: "anthropic/claude-sonnet-4.6",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "stable question", timestamp: 1 },
          {
            role: "user",
            content: "volatile current-turn metadata",
            timestamp: 2,
            runtimeContextCarrier: true,
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
    const messages = capturedMessages as Array<{ role: string; content: unknown }>;
    const stableMsg = messages.find((m) => JSON.stringify(m.content).includes("stable question"));
    const carrierMsg = messages.find((m) =>
      JSON.stringify(m.content).includes("volatile current-turn metadata"),
    );
    // The stable user turn carries the cache breakpoint; the trailing carrier does not.
    expect(JSON.stringify(stableMsg)).toContain("cache_control");
    expect(JSON.stringify(carrierMsg)).not.toContain("cache_control");
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

  it("seals the native reasoning block before the answer text begins", async () => {
    // deepseek streams reasoning_content, then switches to content with no
    // boundary event; thinking_end must precede the answer so channels do not
    // merge the answer into the reasoning block.
    mockChunksRef.chunks = [
      {
        id: "chatcmpl-test",
        choices: [{ index: 0, delta: { reasoning_content: "Let me think." } }],
      },
      {
        id: "chatcmpl-test",
        choices: [{ index: 0, delta: { reasoning_content: " Still thinking." } }],
      },
      makeTextChunk("The answer"),
      makeTextChunk(" is 42."),
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
    const eventTypes: string[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    const thinkingEndIndex = eventTypes.indexOf("thinking_end");
    const textStartIndex = eventTypes.indexOf("text_start");
    const firstTextDeltaIndex = eventTypes.indexOf("text_delta");
    expect(thinkingEndIndex).toBeGreaterThanOrEqual(0);
    expect(textStartIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingEndIndex).toBeLessThan(textStartIndex);
    expect(thinkingEndIndex).toBeLessThan(firstTextDeltaIndex);
    // thinking_end is emitted exactly once even though the block is also
    // visited by the end-of-stream finish loop.
    expect(eventTypes.filter((type) => type === "thinking_end")).toHaveLength(1);

    expect(result.content).toContainEqual({
      type: "thinking",
      thinking: "Let me think. Still thinking.",
      thinkingSignature: "reasoning_content",
    });
    expect(result.content).toContainEqual({ type: "text", text: "The answer is 42." });
  });

  it("seals the native reasoning block before a following tool call", async () => {
    mockChunksRef.chunks = [
      {
        id: "chatcmpl-test",
        choices: [{ index: 0, delta: { reasoning_content: "I should call a tool." } }],
      },
      makeToolCallChunk("call_1", "bash", '{"cmd":"ls"}'),
      makeFinishChunk("tool_calls"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
    const eventTypes: string[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      eventTypes.push(event.type);
    }
    await stream.result();

    const thinkingEndIndex = eventTypes.indexOf("thinking_end");
    const toolCallStartIndex = eventTypes.indexOf("toolcall_start");
    expect(thinkingEndIndex).toBeGreaterThanOrEqual(0);
    expect(toolCallStartIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingEndIndex).toBeLessThan(toolCallStartIndex);
    expect(eventTypes.filter((type) => type === "thinking_end")).toHaveLength(1);
  });

  it("attaches encrypted reasoning details to the matching streamed tool call", async () => {
    mockChunksRef.chunks = [
      makeToolCallChunk("call_1", "first", '{"value":1}'),
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_2",
                  function: { name: "second", arguments: '{"value":2}' },
                  type: "function",
                },
              ],
              reasoning_details: [
                {
                  type: "reasoning.encrypted",
                  id: "call_1",
                  data: "encrypted",
                },
              ],
            } as OpenAICompatibleDelta & {
              reasoning_details: Array<Record<string, string>>;
            },
          },
        ],
      },
      makeFinishChunk("tool_calls"),
    ];

    const stream = streamOpenAICompletions(model, context, {
      apiKey: "sk-test",
    });
    const result = await stream.result();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      id: "call_1",
      thoughtSignature: JSON.stringify({
        type: "reasoning.encrypted",
        id: "call_1",
        data: "encrypted",
      }),
    });
    expect(toolCalls[1]).not.toHaveProperty("thoughtSignature");
  });

  it("keeps one native reasoning block when content and reasoning co-occur", async () => {
    mockChunksRef.chunks = [
      {
        id: "chatcmpl-test",
        choices: [{ index: 0, delta: { reasoning_content: "First thought." } }],
      },
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              content: "Visible text that shares the reasoning chunk.",
              reasoning_content: " Second thought.",
            },
          },
        ],
      },
      makeTextChunk(" Final answer."),
      makeFinishChunk("stop"),
    ];

    const stream = streamOpenAICompletions(reasoningModel, context, {
      apiKey: "sk-test",
      reasoningEffort: "medium",
    });
    const eventTypes: string[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(eventTypes.filter((type) => type === "thinking_start")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "thinking_end")).toHaveLength(1);
    expect(eventTypes.indexOf("thinking_end")).toBeLessThan(eventTypes.indexOf("text_start"));
    expect(result.content).toContainEqual({
      type: "thinking",
      thinking: "First thought. Second thought.",
      thinkingSignature: "reasoning_content",
    });
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

    expect(result.content[0]).toEqual({
      type: "text",
      text: "Use <",
      textSignature: '{"v":1,"id":"commentary-0","phase":"commentary"}',
    });
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

  it("serializes structured tool results as tool text", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const stream = streamOpenAICompletions(
      model,
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "session_status",
            content: [{ type: "json", payload: { sessionKey: "current", status: "ok" } }],
            isError: false,
            timestamp: 0,
          },
        ],
      } as unknown as Context,
      {
        apiKey: "sk-test",
        onPayload(payload) {
          capturedPayload = payload as Record<string, unknown>;
          throw new Error("stop before network");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedPayload?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_1",
          content: expect.stringContaining('"type":"json"'),
        }),
      ]),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
