// Mistral provider tests cover request mapping and stream conversion.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";

const mistralMockState = vi.hoisted(() => ({
  configs: [] as unknown[],
  payloads: [] as unknown[],
  streamError: new Error("stop before network") as unknown,
}));

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
    mistralMockState.streamError = new Error("stop before network");
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
    const toolContent = Array.isArray(toolMessage!.content) ? toolMessage!.content : [];
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
    const toolContent = Array.isArray(toolMessage!.content) ? toolMessage!.content : [];
    const textBlock = toolContent.find((block) => block.type === "text");
    // Structured blocks should provide the output, not an empty fallback
    expect(textBlock?.text).toEqual(expect.stringContaining('{"type":"resource_link"'));
    expect(textBlock?.text).not.toContain("(no tool output)");
  });
});
