import { toolCallFromJSON, type ToolCall } from "@mistralai/mistralai/models/components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";

const mistralMockState = vi.hoisted(() => ({
  configs: [] as unknown[],
  payloads: [] as unknown[],
  requestOptions: [] as unknown[],
  randomUUIDs: [] as string[],
  requestThroughHttpClient: false,
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
  const actual =
    await vi.importActual<typeof import("@mistralai/mistralai")>("@mistralai/mistralai");
  return {
    ...actual,
    Mistral: class MockMistral {
      private readonly config: unknown;

      constructor(config: unknown) {
        this.config = config;
        mistralMockState.configs.push(config);
      }

      chat = {
        stream: vi.fn(async (payload: unknown, requestOptions: unknown) => {
          mistralMockState.payloads.push(payload);
          mistralMockState.requestOptions.push(requestOptions);
          if (mistralMockState.requestThroughHttpClient) {
            const httpClient = (
              this.config as {
                httpClient?: { request(request: Request): Promise<Response> };
              }
            ).httpClient;
            const response = await httpClient?.request(new Request("https://api.mistral.ai/chat"));
            if (response && !response.ok) {
              throw Object.assign(new Error(`Mistral HTTP ${response.status}`), {
                statusCode: response.status,
              });
            }
          }
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
    execute: async () => ({ content: [{ type: "text", text: "broken" }] }),
  };
  Object.defineProperty(tool, "parameters", {
    enumerable: true,
    get() {
      throw new Error("fuzzplugin parameters getter exploded");
    },
  });
  return tool;
}

function makeUnreadableNameTool() {
  const tool = makeHealthyTool();
  Object.defineProperty(tool, "name", {
    enumerable: true,
    get() {
      throw new Error("fuzzplugin name getter exploded");
    },
  });
  return tool;
}

function makeHealthyTool(parameters: Record<string, unknown> = { type: "object", properties: {} }) {
  return {
    name: "healthy_tool",
    description: "healthy tool",
    parameters,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

function parseMistralToolCall(value: unknown): ToolCall {
  const parsed = toolCallFromJSON(JSON.stringify(value));
  if (!parsed.ok) {
    throw new Error("Mistral SDK failed to parse tool-call fixture");
  }
  return parsed.value;
}

function requireMistralFixtureValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Mistral fixture is missing an expected value");
  }
  return value;
}

function mistralToolStream(responseId: string, ...chunks: ToolCall[][]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const toolCalls of chunks) {
        yield {
          data: {
            id: responseId,
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: { content: null, toolCalls },
              },
            ],
          },
        };
      }
    },
  };
}

type MistralTestOptions = NonNullable<Parameters<typeof streamMistral>[2]>;
type SimpleMistralTestOptions = NonNullable<Parameters<typeof streamSimpleMistral>[2]>;

function runMistralFixture(
  testContext: Context = context,
  options: MistralTestOptions = {},
  testModel = makeMistralModel(),
) {
  return streamMistral(testModel, testContext, {
    apiKey: "sk-mistral-provider",
    ...options,
  }).result();
}

function runSimpleMistralFixture(
  testContext: Context = context,
  options: SimpleMistralTestOptions = {},
  testModel = makeMistralModel(),
) {
  return streamSimpleMistral(testModel, testContext, {
    apiKey: "sk-mistral-provider",
    ...options,
  }).result();
}

async function runMistralToolFixture(
  responseId: string,
  rawChunks: unknown[][],
  randomUUID?: string,
) {
  if (randomUUID) {
    mistralMockState.randomUUIDs = [randomUUID];
  }
  const parsedChunks = rawChunks.map((chunk) => chunk.map(parseMistralToolCall));
  mistralMockState.streamResult = mistralToolStream(responseId, ...parsedChunks);
  const result = await runMistralFixture();
  return {
    result,
    parsedChunks,
    toolCalls: result.content.filter((block) => block.type === "toolCall"),
  };
}

function makeMistralToolResultContext(
  toolName: string,
  content: unknown[],
  options: { toolCallId?: string; includeUser?: boolean; includeToolResultName?: boolean } = {},
): Context {
  const toolCallId = options.toolCallId ?? "tool_1";
  return {
    messages: [
      ...(options.includeUser === false
        ? []
        : [{ ...requireMistralFixtureValue(context.messages[0]), timestamp: 1 }]),
      {
        role: "assistant",
        provider: "mistral",
        api: "mistral-conversations",
        model: "mistral-large-latest",
        stopReason: "toolUse",
        timestamp: 0,
        content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId,
        ...(options.includeToolResultName ? { toolName } : {}),
        content,
        isError: false,
        timestamp: 0,
      },
    ],
  } as unknown as Context;
}

describe("Mistral provider", () => {
  beforeEach(() => {
    mistralMockState.configs = [];
    mistralMockState.payloads = [];
    mistralMockState.requestOptions = [];
    mistralMockState.randomUUIDs = [];
    mistralMockState.requestThroughHttpClient = false;
    mistralMockState.streamError = new Error("stop before network");
    mistralMockState.streamResult = undefined;
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("reports SDK stream acceptance without fabricated HTTP metadata", async () => {
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "resp-ack",
            model: "mistral-large-latest",
            choices: [{ finishReason: "stop", delta: { content: "ok" } }],
          },
        };
      },
    };
    const onProviderAccepted = vi.fn();

    const result = await runSimpleMistralFixture(context, { onProviderAccepted });

    expect(result.stopReason).toBe("stop");
    expect(onProviderAccepted).toHaveBeenCalledWith(
      { kind: "provider_stream_opened", httpMetadata: "unavailable" },
      expect.objectContaining({ provider: "mistral" }),
    );
  });

  it("reports the real HTTP response captured at the Mistral fetcher boundary", async () => {
    mistralMockState.requestThroughHttpClient = true;
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "resp-http-ack",
            model: "mistral-large-latest",
            choices: [{ finishReason: "stop", delta: { content: "ok" } }],
          },
        };
      },
    };
    const hostFetch = vi.fn<typeof fetch>(
      async () =>
        new Response("stream", {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-mistral-request-id": "req-1",
          },
        }),
    );
    configureAiTransportHost({ buildModelFetch: () => hostFetch });
    const onProviderAccepted = vi.fn();
    const onResponse = vi.fn();

    const result = await runSimpleMistralFixture(context, {
      onProviderAccepted,
      onResponse,
    });

    expect(result.stopReason).toBe("stop");
    expect(onProviderAccepted).toHaveBeenCalledWith(
      {
        kind: "http_response",
        status: 200,
        headers: expect.objectContaining({
          "content-type": "text/event-stream",
          "x-mistral-request-id": "req-1",
        }),
      },
      expect.objectContaining({ provider: "mistral" }),
    );
    expect(onResponse).toHaveBeenCalledWith(
      {
        status: 200,
        headers: expect.objectContaining({ "x-mistral-request-id": "req-1" }),
      },
      expect.objectContaining({ provider: "mistral" }),
    );
    expect(hostFetch).toHaveBeenCalledOnce();
  });

  it("reports a rejected HTTP response without marking it accepted", async () => {
    mistralMockState.requestThroughHttpClient = true;
    const hostFetch = vi.fn<typeof fetch>(
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "x-mistral-request-id": "req-rejected" },
        }),
    );
    configureAiTransportHost({ buildModelFetch: () => hostFetch });
    const onProviderAccepted = vi.fn();
    const onResponse = vi.fn();

    const result = await runSimpleMistralFixture(context, {
      onProviderAccepted,
      onResponse,
    });

    expect(result.stopReason).toBe("error");
    expect(onProviderAccepted).not.toHaveBeenCalled();
    expect(onResponse).toHaveBeenCalledWith(
      {
        status: 429,
        headers: expect.objectContaining({ "x-mistral-request-id": "req-rejected" }),
      },
      expect.objectContaining({ provider: "mistral" }),
    );
    expect(hostFetch).toHaveBeenCalledOnce();
  });

  it("does not report acceptance when SDK stream setup fails", async () => {
    const onProviderAccepted = vi.fn();

    const result = await runSimpleMistralFixture(context, { onProviderAccepted });

    expect(result.stopReason).toBe("error");
    expect(onProviderAccepted).not.toHaveBeenCalled();
  });

  it("forwards simple stop sequences to Mistral stop", async () => {
    const result = await runSimpleMistralFixture(context, {
      stop: ["STOP"],
    });

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { stop?: unknown }).stop).toEqual(["STOP"]);
  });

  it("preserves Mistral messages while keeping error bodies UTF-16 safe and bounded", async () => {
    const prefix = "a".repeat(3_999);
    mistralMockState.streamError = Object.assign(new Error("invalid request"), {
      statusCode: 400,
      body: `${prefix}😀tail`,
    });

    const result = await runMistralFixture();

    expect(result.errorMessage).toBe("invalid request");
    expect(result.errorBody).toBe(`${prefix.slice(0, 500)}... [truncated]`);
  });

  it("routes the Mistral HTTPClient through the host guarded fetch", async () => {
    const hostFetch = vi.fn<typeof fetch>(async () => new Response("guarded"));
    configureAiTransportHost({ buildModelFetch: () => hostFetch });

    await runMistralFixture(context, { apiKey: "sentinel-key" });

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
    const result = await runSimpleMistralFixture(
      context,
      { reasoning: "high" },
      {
        ...makeMistralModel(),
        id: "mistral-medium-3-5",
        name: "Mistral Medium 3.5",
        reasoning: true,
      },
    );
    const payload = mistralMockState.payloads[0] as Record<string, unknown>;

    expect(result.stopReason).toBe("error");
    expect(payload.reasoningEffort).toBe("high");
    expect(payload).not.toHaveProperty("promptMode");
  });

  it("skips unreadable tool fields while preserving healthy Mistral tools", async () => {
    const healthyParameters = { type: "object", properties: { query: { type: "string" } } };
    const result = await runMistralFixture({
      ...context,
      tools: [
        makeUnreadableNameTool(),
        makeUnreadableParameterTool(),
        makeHealthyTool(healthyParameters),
      ] as never,
    });

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { tools?: unknown[] }).tools).toEqual([
      {
        type: "function",
        function: {
          name: "healthy_tool",
          description: "healthy tool",
          parameters: healthyParameters,
          strict: false,
        },
      },
    ]);
  });

  it("keeps request bytes stable across equivalent tool input order", async () => {
    const tools = [
      { ...makeHealthyTool(), name: "zeta_tool", description: "Zeta tool" },
      { ...makeHealthyTool(), name: "alpha_tool", description: "Alpha tool" },
    ];

    await runMistralFixture({ ...context, tools } as never);
    await runMistralFixture({ ...context, tools: tools.toReversed() } as never);

    expect(JSON.stringify(mistralMockState.payloads[0])).toBe(
      JSON.stringify(mistralMockState.payloads[1]),
    );
    expect(
      (mistralMockState.payloads[0] as { tools: Array<{ function: { name: string } }> }).tools.map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["alpha_tool", "zeta_tool"]);
  });

  it("omits tools and automatic tool choice when every schema is unreadable", async () => {
    const result = await runMistralFixture(
      {
        ...context,
        tools: [makeUnreadableParameterTool()] as never,
      },
      {
        toolChoice: "auto",
      },
    );
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
      mistralMockState.streamResult = mistralToolStream(
        responseId,
        [
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
        [
          { index: 0, function: { name: "", arguments: ":1}" } },
          { index: 1, function: { name: "", arguments: ":true}" } },
        ],
      );
      const result = await runMistralFixture();
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
    const { parsedChunks, toolCalls } = await runMistralToolFixture("response-unindexed", [
      [
        { id: "explicitA", function: { name: "first_tool", arguments: '{"value"' } },
        { id: "explicitB", function: { name: "second_tool", arguments: '{"value"' } },
      ],
      [
        { function: { name: "first_tool", arguments: ":1}" } },
        { function: { name: "second_tool", arguments: ":2}" } },
      ],
    ]);
    const firstCall = requireMistralFixtureValue(parsedChunks[0]?.[0]);
    const secondCall = requireMistralFixtureValue(parsedChunks[0]?.[1]);
    // The SDK defaults an omitted wire index to zero. Explicit provider ids
    // must still win over that ambiguous compatibility default.
    expect(firstCall.index).toBe(0);
    expect(secondCall.index).toBe(0);

    expect(toolCalls).toMatchObject([
      { id: "explicitA", name: "first_tool", arguments: { value: 1 } },
      { id: "explicitB", name: "second_tool", arguments: { value: 2 } },
    ]);
  });

  it("keeps missing-id streamed tool calls distinct when index is omitted", async () => {
    const { parsedChunks, toolCalls } = await runMistralToolFixture(
      "response-unidentified",
      [
        [
          { function: { name: "first_tool", arguments: '{"value"' } },
          { index: 1, function: { name: "second_tool", arguments: '{"value"' } },
        ],
        [
          { function: { name: "first_tool", arguments: ":1}" } },
          { function: { name: "second_tool", arguments: ":2}" } },
        ],
      ],
      "00000000-0000-4000-8000-000000429246",
    );
    const firstCall = requireMistralFixtureValue(parsedChunks[0]?.[0]);
    const secondCall = requireMistralFixtureValue(parsedChunks[0]?.[1]);
    const secondContinuation = requireMistralFixtureValue(parsedChunks[1]?.[1]);
    expect(firstCall).toMatchObject({ id: "null", index: 0 });
    expect(secondCall).toMatchObject({ id: "null", index: 1 });
    expect(secondContinuation).toMatchObject({ id: "null", index: 0 });

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
    const { parsedChunks, toolCalls } = await runMistralToolFixture(
      "response-asymmetric-unindexed",
      [
        [
          { function: { name: "first_tool", arguments: '{"value":1}' } },
          { index: 1, function: { name: "second_tool", arguments: '{"value"' } },
        ],
        [{ function: { name: "second_tool", arguments: ":2}" } }],
      ],
      "00000000-0000-4000-8000-000000429247",
    );
    const firstCall = requireMistralFixtureValue(parsedChunks[0]?.[0]);
    const secondCall = requireMistralFixtureValue(parsedChunks[0]?.[1]);
    const secondContinuation = requireMistralFixtureValue(parsedChunks[1]?.[0]);
    expect(firstCall).toMatchObject({ id: "null", index: 0 });
    expect(secondCall).toMatchObject({ id: "null", index: 1 });
    // The SDK defaults the omitted continuation index to zero; the persistent
    // function name must still bind it back to the index-1 call.
    expect(secondContinuation).toMatchObject({ id: "null", index: 0 });

    expect(toolCalls).toMatchObject([
      { name: "first_tool", arguments: { value: 1 } },
      { name: "second_tool", arguments: { value: 2 } },
    ]);
  });

  it("rejects an ambiguous idless and nameless omitted-index continuation", async () => {
    const { result } = await runMistralToolFixture(
      "response-ambiguous-unindexed",
      [
        [
          { function: { name: "first_tool", arguments: '{"value"' } },
          { function: { name: "second_tool", arguments: '{"value"' } },
        ],
        [{ function: { name: "", arguments: ":2}" } }],
      ],
      "00000000-0000-4000-8000-000000429248",
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("tool-call continuation is ambiguous");
  });

  it("keeps same-name omitted-index siblings distinct and rejects their ambiguous continuation", async () => {
    const { result, toolCalls } = await runMistralToolFixture(
      "response-same-name-unindexed",
      [
        [
          { function: { name: "computer", arguments: '{"step"' } },
          { function: { name: "computer", arguments: '{"step"' } },
        ],
        [{ function: { name: "computer", arguments: ":2}" } }],
      ],
      "00000000-0000-4000-8000-000000429249",
    );

    expect(toolCalls).toHaveLength(0);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("tool-call continuation is ambiguous");
  });

  it("keeps a later same-name call distinct when it has a nonzero index", async () => {
    mistralMockState.randomUUIDs = ["00000000-0000-4000-8000-000000429250"];
    const firstCall = parseMistralToolCall({
      index: 0,
      function: { name: "computer", arguments: '{"step":1}' },
    });
    const secondCall = parseMistralToolCall({
      index: 1,
      function: { name: "computer", arguments: '{"step":2}' },
    });
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        for (const [id, toolCall] of [firstCall, secondCall].entries()) {
          yield* mistralToolStream(`response-same-name-indexed-${id}`, [toolCall]);
        }
      },
    };

    const result = await runMistralFixture();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toMatchObject([
      { name: "computer", arguments: { step: 1 } },
      { name: "computer", arguments: { step: 2 } },
    ]);
    expect(new Set(toolCalls.map((toolCall) => toolCall.id)).size).toBe(2);
  });

  it("fails locally when a pinned Mistral tool choice is skipped", async () => {
    const result = await runMistralFixture(
      {
        ...context,
        tools: [makeUnreadableParameterTool(), makeHealthyTool()] as never,
      },
      {
        toolChoice: { type: "function", function: { name: "broken_tool" } },
      },
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Mistral tool_choice requested unavailable tool "broken_tool"',
    );
    expect(mistralMockState.payloads).toHaveLength(0);
  });

  it("validates and emits one snapshot of a pinned Mistral tool name", async () => {
    let nameReads = 0;
    const result = await runMistralFixture(
      {
        ...context,
        tools: [makeHealthyTool()] as never,
      },
      {
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

    expect(result.stopReason).toBe("error");
    expect(nameReads).toBe(1);
    expect((mistralMockState.payloads[0] as { toolChoice?: unknown }).toolChoice).toEqual({
      type: "function",
      function: { name: "healthy_tool" },
    });
  });

  it("strips the internal cache boundary marker from the system message", async () => {
    await runSimpleMistralFixture({
      systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    });

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMessage = payload.messages.find((message) => message.role === "system");
    expect(systemMessage?.content).toBe("Stable\nDynamic");
    expect(JSON.stringify(payload)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });

  it("uses prompt cache affinity unless caching is disabled", async () => {
    for (const cacheRetention of [undefined, "none"] as const) {
      mistralMockState.payloads = [];
      mistralMockState.requestOptions = [];
      await runSimpleMistralFixture(context, {
        apiKey: "fixture",
        sessionId: "session-affinity",
        promptCacheKey: "prompt-cache-key",
        ...(cacheRetention ? { cacheRetention } : {}),
      });

      const payload = mistralMockState.payloads[0] as { promptCacheKey?: string };
      const requestOptions = mistralMockState.requestOptions[0] as {
        headers?: Record<string, string>;
      };
      if (cacheRetention === "none") {
        expect(payload.promptCacheKey).toBeUndefined();
        expect(requestOptions.headers?.["x-affinity"]).toBeUndefined();
      } else {
        expect(payload.promptCacheKey).toBe("prompt-cache-key");
        expect(requestOptions.headers?.["x-affinity"]).toBe("session-affinity");
      }
    }
  });

  it("uses the session id as the prompt cache key when no dedicated key is supplied", async () => {
    await runSimpleMistralFixture(context, {
      apiKey: "fixture",
      sessionId: "session-cache-key",
    });

    expect((mistralMockState.payloads[0] as { promptCacheKey?: string }).promptCacheKey).toBe(
      "session-cache-key",
    );
  });

  it.each([
    ["SDK camel case", { promptTokensDetails: { cachedTokens: 64 } }],
    ["wire snake case", { prompt_tokens_details: { cached_tokens: 64 } }],
  ])("accounts for cached prompt tokens from %s usage", async (_label, cacheUsage) => {
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "response-cache-usage",
            model: "mistral-small-latest",
            usage: {
              promptTokens: 100,
              completionTokens: 10,
              totalTokens: 110,
              ...cacheUsage,
            },
            choices: [
              {
                finishReason: "stop",
                delta: { content: "ok", toolCalls: [] },
              },
            ],
          },
        };
      },
    };

    const result = await runMistralFixture(context, { apiKey: "fixture" });

    expect(result.usage).toMatchObject({
      input: 36,
      output: 10,
      cacheRead: 64,
      cacheWrite: 0,
      totalTokens: 110,
    });
  });

  it("serializes structured non-image blocks in tool results as JSON text", async () => {
    // Prove the host redaction port is applied to structured tool-result text.
    configureAiTransportHost({
      redactToolPayloadText: (text) => text.replaceAll('"value"', '"***"'),
    });
    const testContext = makeMistralToolResultContext("fetch", [
      {
        type: "resource",
        resource: {
          uri: "https://example.com/data.json",
          mimeType: "application/json",
          text: '{"key":"value"}',
        },
      },
    ]);

    await runMistralFixture(testContext);

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    };
    const toolMessage = payload.messages.find((message) => message.role === "tool");
    const toolContent = Array.isArray(toolMessage?.content) ? toolMessage.content : [];
    const textBlock = toolContent.find((block) => block.type === "text");
    expect(textBlock?.text).toEqual(expect.stringContaining('{"type":"resource"'));
    expect(textBlock?.text).toContain('{\\"key\\":\\"***\\"}');
    expect(textBlock?.text).not.toContain('{\\"key\\":\\"value\\"}');
  });

  it("does not emit image chunks or placeholders for payload-less tool media", async () => {
    const testContext = makeMistralToolResultContext(
      "screenshot",
      [{ type: "image", mimeType: "image/png", data: "" }],
      { toolCallId: "tool_husk", includeUser: false, includeToolResultName: true },
    );

    await runMistralFixture(
      testContext,
      { apiKey: "fake" },
      { ...makeMistralModel(), input: ["text", "image"] },
    );

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    };
    const toolMessage = payload.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toEqual([{ type: "text", text: "(no tool output)" }]);
    expect(JSON.stringify(toolMessage)).not.toContain("image_url");
    expect(JSON.stringify(toolMessage)).not.toContain("see attached image");
  });

  it("serializes structured-only tool results instead of empty fallback", async () => {
    const testContext = makeMistralToolResultContext("get_file", [
      {
        type: "resource_link",
        uri: "https://example.com/file.txt",
        name: "file.txt",
        mimeType: "text/plain",
        size: 100,
      },
    ]);

    await runMistralFixture(testContext);

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    };
    const toolMessage = payload.messages.find((message) => message.role === "tool");
    const toolContent = Array.isArray(toolMessage?.content) ? toolMessage.content : [];
    const textBlock = toolContent.find((block) => block.type === "text");
    // Structured blocks should provide the output, not an empty fallback
    expect(textBlock?.text).toEqual(expect.stringContaining('{"type":"resource_link"'));
    expect(textBlock?.text).not.toContain("(no tool output)");
  });
});
