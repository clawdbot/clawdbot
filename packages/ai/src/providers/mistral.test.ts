// Mistral provider tests cover request mapping and stream conversion.
import { toolCallFromJSON } from "@mistralai/mistralai/models/components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";

const mistralMockState = vi.hoisted(() => ({
  configs: [] as unknown[],
  payloads: [] as unknown[],
  randomUUIDs: [] as string[],
  streamError: new Error("stop before network") as unknown,
  streamResult: undefined as unknown,
}));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => mistralMockState.randomUUIDs.shift() ?? actual.randomUUID(),
  };
});

vi.mock("@mistralai/mistralai", async () => {
  // Preserve real exports for everything except `Mistral`, so the new
  // imports of `HTTPClient` and `Fetcher` introduced by the bounded-stream
  // helper (`createBoundedMistralHttpClient`) resolve correctly. Only
  // `Mistral` itself is overridden so the test can capture payloads without
  // any actual HTTP traffic.
  const actual =
    await vi.importActual<typeof import("@mistralai/mistralai")>("@mistralai/mistralai");
  return {
    ...actual,
    Mistral: class MockMistral {
      constructor(config: unknown) {
        mistralMockState.configs.push(config);
      }

      chat = {
        stream: vi.fn(async (payload: unknown) => {
          mistralMockState.payloads.push(payload);
          if (mistralMockState.streamResult !== undefined) {
            return mistralMockState.streamResult;
          }
          throw mistralMockState.streamError;
        }),
      };
    },
  };
});

import { streamMistral, streamSimpleMistral } from "./mistral.js";

function makeMistralModel(): Model<"mistral-conversations"> {
  return {
    id: "mistral-large-latest",
    name: "Mistral Large",
    api: "mistral-conversations",
    provider: "mistral",
    baseUrl: "https://api.mistral.ai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

function makeUnreadableParameterTool() {
  const tool = {
    name: "broken_tool",
    description: "broken tool",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "broken" }] };
    },
  };
  Object.defineProperty(tool, "parameters", {
    enumerable: true,
    get() {
      throw new Error("fuzzplugin parameters getter exploded");
    },
  });
  return tool;
}

describe("Mistral provider", () => {
  beforeEach(() => {
    mistralMockState.configs = [];
    mistralMockState.payloads = [];
    mistralMockState.randomUUIDs = [];
    mistralMockState.streamError = new Error("stop before network");
    mistralMockState.streamResult = undefined;
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("forwards simple stop sequences to Mistral stop", async () => {
    const stream = streamSimpleMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
      stop: ["STOP"],
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { stop?: unknown }).stop).toEqual(["STOP"]);
  });

  it("keeps truncated Mistral error bodies UTF-16 safe with an exact omitted count", async () => {
    const prefix = "a".repeat(3_999);
    mistralMockState.streamError = Object.assign(new Error("invalid request"), {
      statusCode: 400,
      body: `${prefix}😀tail`,
    });

    const result = await streamMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
    }).result();

    expect(result.errorMessage).toBe(`Mistral API error (400): ${prefix}... [truncated 6 chars]`);
  });

  it("routes the Mistral HTTPClient through the host guarded fetch", async () => {
    const hostFetch = vi.fn<typeof fetch>(async () => new Response("guarded"));
    configureAiTransportHost({ buildModelFetch: () => hostFetch });

    await streamMistral(makeMistralModel(), context, { apiKey: "sentinel-key" }).result();

    const config = mistralMockState.configs[0] as {
      apiKey?: string;
      httpClient?: { request(request: Request): Promise<Response> };
    };
    expect(config.apiKey).toBe("sentinel-key");
    const response = await config.httpClient?.request(new Request("https://api.mistral.ai/chat"));
    expect(await response?.text()).toBe("guarded");
    expect(hostFetch).toHaveBeenCalledTimes(1);
  });

  it("uses reasoning effort for Mistral Medium 3.5", async () => {
    const stream = streamSimpleMistral(
      {
        ...makeMistralModel(),
        id: "mistral-medium-3-5",
        name: "Mistral Medium 3.5",
        reasoning: true,
      },
      context,
      {
        apiKey: "sk-mistral-provider",
        reasoning: "high",
      },
    );

    const result = await stream.result();
    const payload = mistralMockState.payloads[0] as Record<string, unknown>;

    expect(result.stopReason).toBe("error");
    expect(payload.reasoningEffort).toBe("high");
    expect(payload).not.toHaveProperty("promptMode");
  });

  it("skips unreadable tool schemas while preserving healthy Mistral tools", async () => {
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [
          makeUnreadableParameterTool(),
          {
            name: "healthy_tool",
            description: "healthy tool",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
            async execute() {
              return { content: [{ type: "text", text: "ok" }] };
            },
          },
        ] as never,
      },
      {
        apiKey: "sk-mistral-provider",
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { tools?: unknown[] }).tools).toEqual([
      {
        type: "function",
        function: {
          name: "healthy_tool",
          description: "healthy tool",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
          strict: false,
        },
      },
    ]);
  });

  it("omits tools and automatic tool choice when every schema is unreadable", async () => {
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [makeUnreadableParameterTool()] as never,
      },
      {
        apiKey: "sk-mistral-provider",
        toolChoice: "auto",
      },
    );

    const result = await stream.result();
    const payload = mistralMockState.payloads[0] as Record<string, unknown>;

    expect(result.stopReason).toBe("error");
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("toolChoice");
  });

  it("keeps omitted streamed tool ids stable within a response and unique across responses", async () => {
    mistralMockState.randomUUIDs = [
      "00000000-0000-4000-8000-000000429244",
      "00000000-0000-4000-8000-000000429245",
    ];
    const responseIds: string[][] = [];
    for (const responseId of ["response-a", "response-b"]) {
      mistralMockState.streamResult = {
        async *[Symbol.asyncIterator]() {
          yield {
            data: {
              id: responseId,
              model: "mistral-large-latest",
              choices: [
                {
                  finishReason: "tool_calls",
                  delta: {
                    content: null,
                    toolCalls: [
                      {
                        index: 0,
                        id: "null",
                        function: { name: "computer", arguments: '{"step"' },
                      },
                      {
                        index: 1,
                        id: responseId === "response-a" ? "explicitA" : "explicitB",
                        function: { name: "computer", arguments: '{"other"' },
                      },
                    ],
                  },
                },
              ],
            },
          };
          yield {
            data: {
              id: responseId,
              model: "mistral-large-latest",
              choices: [
                {
                  finishReason: "tool_calls",
                  delta: {
                    content: null,
                    toolCalls: [
                      {
                        index: 0,
                        function: { name: "", arguments: ":1}" },
                      },
                      {
                        index: 1,
                        function: { name: "", arguments: ":true}" },
                      },
                    ],
                  },
                },
              ],
            },
          };
        },
      };
      const result = await streamMistral(makeMistralModel(), context, {
        apiKey: "sk-mistral-provider",
      }).result();
      const toolCalls = result.content.filter((block) => block.type === "toolCall");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]?.arguments).toEqual({ step: 1 });
      expect(toolCalls[1]?.arguments).toEqual({ other: true });
      responseIds.push(toolCalls.map((toolCall) => toolCall.id));
    }

    expect(responseIds.flat().every((id) => /^[a-zA-Z0-9]{9}$/.test(id))).toBe(true);
    expect(responseIds[0]?.[1]).toBe("explicitA");
    expect(responseIds[1]?.[1]).toBe("explicitB");
    expect(responseIds[1]?.[0]).not.toBe(responseIds[0]?.[0]);
  });

  it("keeps explicit streamed tool calls distinct when index is omitted", async () => {
    const firstCall = toolCallFromJSON(
      JSON.stringify({
        id: "explicitA",
        function: { name: "first_tool", arguments: '{"value"' },
      }),
    );
    const secondCall = toolCallFromJSON(
      JSON.stringify({
        id: "explicitB",
        function: { name: "second_tool", arguments: '{"value"' },
      }),
    );
    const firstContinuation = toolCallFromJSON(
      JSON.stringify({ function: { name: "first_tool", arguments: ":1}" } }),
    );
    const secondContinuation = toolCallFromJSON(
      JSON.stringify({ function: { name: "second_tool", arguments: ":2}" } }),
    );
    if (!firstCall.ok || !secondCall.ok || !firstContinuation.ok || !secondContinuation.ok) {
      throw new Error("Mistral SDK failed to parse tool-call fixtures");
    }
    // The SDK defaults an omitted wire index to zero. Explicit provider ids
    // must still win over that ambiguous compatibility default.
    expect(firstCall.value.index).toBe(0);
    expect(secondCall.value.index).toBe(0);
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "response-unindexed",
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: {
                  content: null,
                  toolCalls: [firstCall.value, secondCall.value],
                },
              },
            ],
          },
        };
        yield {
          data: {
            id: "response-unindexed",
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: {
                  content: null,
                  toolCalls: [firstContinuation.value, secondContinuation.value],
                },
              },
            ],
          },
        };
      },
    };

    const result = await streamMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
    }).result();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toMatchObject([
      { id: "explicitA", name: "first_tool", arguments: { value: 1 } },
      { id: "explicitB", name: "second_tool", arguments: { value: 2 } },
    ]);
  });

  it("keeps missing-id streamed tool calls distinct when index is omitted", async () => {
    mistralMockState.randomUUIDs = ["00000000-0000-4000-8000-000000429246"];
    const firstCall = toolCallFromJSON(
      JSON.stringify({ function: { name: "first_tool", arguments: '{"value"' } }),
    );
    const secondCall = toolCallFromJSON(
      JSON.stringify({
        index: 1,
        function: { name: "second_tool", arguments: '{"value"' },
      }),
    );
    const firstContinuation = toolCallFromJSON(
      JSON.stringify({ function: { name: "first_tool", arguments: ":1}" } }),
    );
    const secondContinuation = toolCallFromJSON(
      JSON.stringify({ function: { name: "second_tool", arguments: ":2}" } }),
    );
    if (!firstCall.ok || !secondCall.ok || !firstContinuation.ok || !secondContinuation.ok) {
      throw new Error("Mistral SDK failed to parse tool-call fixtures");
    }
    expect(firstCall.value).toMatchObject({ id: "null", index: 0 });
    expect(secondCall.value).toMatchObject({ id: "null", index: 1 });
    expect(secondContinuation.value).toMatchObject({ id: "null", index: 0 });
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "response-unidentified",
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: {
                  content: null,
                  toolCalls: [firstCall.value, secondCall.value],
                },
              },
            ],
          },
        };
        yield {
          data: {
            id: "response-unidentified",
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: {
                  content: null,
                  toolCalls: [firstContinuation.value, secondContinuation.value],
                },
              },
            ],
          },
        };
      },
    };

    const result = await streamMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
    }).result();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toMatchObject([
      { name: "first_tool", arguments: { value: 1 } },
      { name: "second_tool", arguments: { value: 2 } },
    ]);
    const toolCallIds = toolCalls.map((toolCall) => toolCall.id);
    expect(toolCallIds).toHaveLength(2);
    expect(new Set(toolCallIds).size).toBe(2);
    expect(toolCallIds.every((id) => /^[a-zA-Z0-9]{9}$/.test(id))).toBe(true);
  });

  it("routes an asymmetric omitted-index continuation by its persistent function name", async () => {
    mistralMockState.randomUUIDs = ["00000000-0000-4000-8000-000000429247"];
    const firstCall = toolCallFromJSON(
      JSON.stringify({ function: { name: "first_tool", arguments: '{"value":1}' } }),
    );
    const secondCall = toolCallFromJSON(
      JSON.stringify({
        index: 1,
        function: { name: "second_tool", arguments: '{"value"' },
      }),
    );
    const secondContinuation = toolCallFromJSON(
      JSON.stringify({ function: { name: "second_tool", arguments: ":2}" } }),
    );
    if (!firstCall.ok || !secondCall.ok || !secondContinuation.ok) {
      throw new Error("Mistral SDK failed to parse tool-call fixtures");
    }
    expect(firstCall.value).toMatchObject({ id: "null", index: 0 });
    expect(secondCall.value).toMatchObject({ id: "null", index: 1 });
    // The SDK defaults the omitted continuation index to zero; the persistent
    // function name must still bind it back to the index-1 call.
    expect(secondContinuation.value).toMatchObject({ id: "null", index: 0 });
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "response-asymmetric-unindexed",
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: {
                  content: null,
                  toolCalls: [firstCall.value, secondCall.value],
                },
              },
            ],
          },
        };
        yield {
          data: {
            id: "response-asymmetric-unindexed",
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: { content: null, toolCalls: [secondContinuation.value] },
              },
            ],
          },
        };
      },
    };

    const result = await streamMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
    }).result();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toMatchObject([
      { name: "first_tool", arguments: { value: 1 } },
      { name: "second_tool", arguments: { value: 2 } },
    ]);
  });

  it("rejects an ambiguous idless and nameless omitted-index continuation", async () => {
    mistralMockState.randomUUIDs = ["00000000-0000-4000-8000-000000429248"];
    const firstCall = toolCallFromJSON(
      JSON.stringify({ function: { name: "first_tool", arguments: '{"value"' } }),
    );
    const secondCall = toolCallFromJSON(
      JSON.stringify({ function: { name: "second_tool", arguments: '{"value"' } }),
    );
    const ambiguousContinuation = toolCallFromJSON(
      JSON.stringify({ function: { name: "", arguments: ":2}" } }),
    );
    if (!firstCall.ok || !secondCall.ok || !ambiguousContinuation.ok) {
      throw new Error("Mistral SDK failed to parse tool-call fixtures");
    }
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "response-ambiguous-unindexed",
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: {
                  content: null,
                  toolCalls: [firstCall.value, secondCall.value],
                },
              },
            ],
          },
        };
        yield {
          data: {
            id: "response-ambiguous-unindexed",
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: { content: null, toolCalls: [ambiguousContinuation.value] },
              },
            ],
          },
        };
      },
    };

    const result = await streamMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("tool-call continuation is ambiguous");
  });

  it("keeps same-name omitted-index siblings distinct and rejects their ambiguous continuation", async () => {
    mistralMockState.randomUUIDs = ["00000000-0000-4000-8000-000000429249"];
    const firstCall = toolCallFromJSON(
      JSON.stringify({ function: { name: "computer", arguments: '{"step"' } }),
    );
    const secondCall = toolCallFromJSON(
      JSON.stringify({ function: { name: "computer", arguments: '{"step"' } }),
    );
    const ambiguousContinuation = toolCallFromJSON(
      JSON.stringify({ function: { name: "computer", arguments: ":2}" } }),
    );
    if (!firstCall.ok || !secondCall.ok || !ambiguousContinuation.ok) {
      throw new Error("Mistral SDK failed to parse tool-call fixtures");
    }
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "response-same-name-unindexed",
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: {
                  content: null,
                  toolCalls: [firstCall.value, secondCall.value],
                },
              },
            ],
          },
        };
        yield {
          data: {
            id: "response-same-name-unindexed",
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: { content: null, toolCalls: [ambiguousContinuation.value] },
              },
            ],
          },
        };
      },
    };

    const result = await streamMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
    }).result();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toHaveLength(2);
    expect(new Set(toolCalls.map((toolCall) => toolCall.id)).size).toBe(2);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("tool-call continuation is ambiguous");
  });

  it("keeps a later same-name call distinct when it has a nonzero index", async () => {
    mistralMockState.randomUUIDs = ["00000000-0000-4000-8000-000000429250"];
    const firstCall = toolCallFromJSON(
      JSON.stringify({
        index: 0,
        function: { name: "computer", arguments: '{"step":1}' },
      }),
    );
    const secondCall = toolCallFromJSON(
      JSON.stringify({
        index: 1,
        function: { name: "computer", arguments: '{"step":2}' },
      }),
    );
    if (!firstCall.ok || !secondCall.ok) {
      throw new Error("Mistral SDK failed to parse tool-call fixtures");
    }
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        for (const [id, toolCall] of [firstCall.value, secondCall.value].entries()) {
          yield {
            data: {
              id: `response-same-name-indexed-${id}`,
              model: "mistral-large-latest",
              choices: [
                {
                  finishReason: "tool_calls",
                  delta: { content: null, toolCalls: [toolCall] },
                },
              ],
            },
          };
        }
      },
    };

    const result = await streamMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
    }).result();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toMatchObject([
      { name: "computer", arguments: { step: 1 } },
      { name: "computer", arguments: { step: 2 } },
    ]);
    expect(new Set(toolCalls.map((toolCall) => toolCall.id)).size).toBe(2);
  });

  it("fails locally when a pinned Mistral tool choice is skipped", async () => {
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [
          makeUnreadableParameterTool(),
          {
            name: "healthy_tool",
            description: "healthy tool",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { content: [{ type: "text", text: "ok" }] };
            },
          },
        ] as never,
      },
      {
        apiKey: "sk-mistral-provider",
        toolChoice: { type: "function", function: { name: "broken_tool" } },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Mistral tool_choice requested unavailable tool "broken_tool"',
    );
    expect(mistralMockState.payloads).toHaveLength(0);
  });

  it("validates and emits one snapshot of a pinned Mistral tool name", async () => {
    let nameReads = 0;
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [
          {
            name: "healthy_tool",
            description: "healthy tool",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { content: [{ type: "text", text: "ok" }] };
            },
          },
        ] as never,
      },
      {
        apiKey: "sk-mistral-provider",
        toolChoice: {
          type: "function",
          function: {
            get name() {
              nameReads += 1;
              return nameReads === 1 ? "healthy_tool" : "broken_tool";
            },
          },
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(nameReads).toBe(1);
    expect((mistralMockState.payloads[0] as { toolChoice?: unknown }).toolChoice).toEqual({
      type: "function",
      function: { name: "healthy_tool" },
    });
  });

  it("strips the internal cache boundary marker from the system message", async () => {
    const stream = streamSimpleMistral(
      makeMistralModel(),
      {
        systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      { apiKey: "sk-mistral-provider" },
    );

    await stream.result();

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMessage = payload.messages.find((message) => message.role === "system");
    expect(systemMessage?.content).toBe("Stable\nDynamic");
    expect(JSON.stringify(payload)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });

  it("serializes structured non-image blocks in tool results as JSON text", async () => {
    // Prove the host redaction port is applied to structured tool-result text.
    configureAiTransportHost({
      redactToolPayloadText: (text) => text.replaceAll('"value"', '"***"'),
    });
    const testContext = {
      messages: [
        {
          role: "user",
          content: "hello",
          timestamp: 1,
        },
        {
          role: "assistant",
          provider: "mistral",
          api: "mistral-conversations",
          model: "mistral-large-latest",
          stopReason: "toolUse",
          timestamp: 0,
          content: [{ type: "toolCall", id: "tool_1", name: "fetch", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "tool_1",
          content: [
            {
              type: "resource",
              resource: {
                uri: "https://example.com/data.json",
                mimeType: "application/json",
                text: '{"key":"value"}',
              },
            },
          ],
          isError: false,
          timestamp: 0,
        },
      ],
    } as unknown as Context;

    const stream = streamMistral(makeMistralModel(), testContext, {
      apiKey: "sk-mistral-provider",
    });
    await stream.result();

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    };
    const toolMessage = payload.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    const toolContent = Array.isArray(toolMessage?.content) ? toolMessage.content : [];
    const textBlock = toolContent.find((block) => block.type === "text");
    expect(textBlock?.text).toEqual(expect.stringContaining('{"type":"resource"'));
    expect(textBlock?.text).toContain('{\\"key\\":\\"***\\"}');
    expect(textBlock?.text).not.toContain('{\\"key\\":\\"value\\"}');
  });

  it("serializes structured-only tool results instead of empty fallback", async () => {
    const testContext = {
      messages: [
        {
          role: "user",
          content: "hello",
          timestamp: 1,
        },
        {
          role: "assistant",
          provider: "mistral",
          api: "mistral-conversations",
          model: "mistral-large-latest",
          stopReason: "toolUse",
          timestamp: 0,
          content: [{ type: "toolCall", id: "tool_1", name: "get_file", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "tool_1",
          content: [
            {
              type: "resource_link",
              uri: "https://example.com/file.txt",
              name: "file.txt",
              mimeType: "text/plain",
              size: 100,
            },
          ],
          isError: false,
          timestamp: 0,
        },
      ],
    } as unknown as Context;

    const stream = streamMistral(makeMistralModel(), testContext, {
      apiKey: "sk-mistral-provider",
    });
    await stream.result();

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    };
    const toolMessage = payload.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    const toolContent = Array.isArray(toolMessage?.content) ? toolMessage.content : [];
    const textBlock = toolContent.find((block) => block.type === "text");
    // Structured blocks should provide the output, not an empty fallback
    expect(textBlock?.text).toEqual(expect.stringContaining('{"type":"resource_link"'));
    expect(textBlock?.text).not.toContain("(no tool output)");
  });
});
