// OpenAI Responses shared tests cover tool conversion and response item mapping.
import type {
  ResponseStreamEvent,
  Tool as OpenAIResponsesTool,
} from "openai/resources/responses/responses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, Tool } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import {
  applyCommonResponsesParams,
  createResponsesAssistantOutput,
  convertResponsesMessages,
  processResponsesStream,
  resolveResponsesReasoningEffort,
  runResponsesStreamLifecycle,
} from "./openai-responses-shared.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";

type ResponsesFunctionTool = Extract<OpenAIResponsesTool, { type: "function" }>;
type OpenAIResponsesStreamEvent =
  Parameters<typeof processResponsesStream>[0] extends AsyncIterable<infer Event> ? Event : never;

async function* streamResponsesEvents(
  events: readonly OpenAIResponsesStreamEvent[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function createNeverYieldingResponsesStream<
  T extends OpenAIResponsesStreamEvent = OpenAIResponsesStreamEvent,
>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return new Promise<IteratorResult<T>>(() => {});
        },
      };
    },
  };
}

function createCapturedAssistantMessageEventStream(): {
  stream: AssistantMessageEventStream;
  events: AssistantMessageEvent[];
} {
  const stream = new AssistantMessageEventStream();
  const events: AssistantMessageEvent[] = [];
  const push = stream.push.bind(stream);
  stream.push = (event) => {
    events.push(event);
    push(event);
  };
  return { stream, events };
}

function expectResponsesFunctionTool(tool: OpenAIResponsesTool | undefined): ResponsesFunctionTool {
  expect(tool).toHaveProperty("type", "function");
  return tool as ResponsesFunctionTool;
}

const nativeOpenAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

const proxyOpenAIModel = {
  ...nativeOpenAIModel,
  id: "custom-model",
  name: "Custom Model",
  baseUrl: "https://proxy.example.com/v1",
} satisfies Model<"openai-responses">;

const gpt56SolModel = {
  ...nativeOpenAIModel,
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
} satisfies Model<"openai-responses">;

const testAllowedToolCallProviders = new Set(["openai", "openai-codex", "opencode"]);

function createAssistantOutput(): AssistantMessage {
  return {
    role: "assistant",
    api: nativeOpenAIModel.api,
    provider: nativeOpenAIModel.provider,
    model: nativeOpenAIModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    content: [],
  };
}

async function* responseEvents(events: Array<Record<string, unknown>>) {
  for (const event of events) {
    yield event as never;
  }
}

describe("convertResponsesToolPayload", () => {
  beforeEach(() => {
    // Mimic the OpenClaw host strict-tool policy: native OpenAI routes force
    // strict=true, proxy-like routes leave the flag unset.
    configureAiTransportHost({
      resolveOpenAIStrictToolSetting: (model, options) => {
        if (model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1") {
          return true;
        }
        return options?.supportsStrictMode ? false : undefined;
      },
    });
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("enables native strict OpenAI Responses tools and normalizes schemas", () => {
    const tools = [
      {
        name: "lookup_weather",
        description: "Get forecast",
        parameters: {},
      },
    ] satisfies Tool[];

    const converted = convertResponsesToolPayload(tools, { model: nativeOpenAIModel }).tools;

    expect(converted).toEqual([
      {
        type: "function",
        name: "lookup_weather",
        description: "Get forecast",
        strict: true,
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("downgrades incompatible native Responses schemas to strict false", () => {
    const converted = convertResponsesToolPayload(
      [
        {
          name: "read_file",
          description: "Read",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { path: { type: "string" } },
            required: [],
          },
        },
      ],
      { model: nativeOpenAIModel },
    ).tools;

    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool.strict).toBe(false);
    expect(tool.parameters).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: [],
    });
  });

  it("omits strict on proxy-like Responses routes but keeps schema normalization", () => {
    const converted = convertResponsesToolPayload(
      [
        {
          name: "lookup_weather",
          description: "Get forecast",
          parameters: {},
        },
      ],
      { model: proxyOpenAIModel },
    ).tools;

    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool).not.toHaveProperty("strict");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("keeps tool order deterministic", () => {
    const zeta = {
      name: "zeta",
      description: "Z",
      parameters: {},
    } satisfies Tool;
    const alpha = {
      name: "alpha",
      description: "A",
      parameters: {},
    } satisfies Tool;

    expect(
      convertResponsesToolPayload([zeta, alpha]).tools.map(
        (tool) => expectResponsesFunctionTool(tool).name,
      ),
    ).toEqual(["alpha", "zeta"]);
  });

  it("skips unreadable schemas and preserves healthy native strict tools", () => {
    const converted = convertResponsesToolPayload(
      [
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
      { model: nativeOpenAIModel },
    ).tools;

    expect(converted).toEqual([
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        strict: true,
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("does not reread an unreadable tool inventory length", () => {
    const tools = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("length exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const params = {} as never;

    applyCommonResponsesParams(params, nativeOpenAIModel, {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools,
    } as never);

    expect(params).not.toHaveProperty("tools");
  });
});

describe("Responses temperature support", () => {
  it("drops temperature for the GPT-5.6 family that rejects it", () => {
    const params = {} as never;
    applyCommonResponsesParams(params, gpt56SolModel, { messages: [] }, { temperature: 0.3 });

    expect(params).not.toHaveProperty("temperature");
  });

  it("keeps temperature for models that accept it", () => {
    const params = {} as never;
    applyCommonResponsesParams(params, nativeOpenAIModel, { messages: [] }, { temperature: 0.3 });

    expect(params).toMatchObject({ temperature: 0.3 });
  });
});

describe("Responses reasoning effort", () => {
  it("omits unsupported default-off reasoning for GPT-5.6 Sol", () => {
    const params = {} as never;
    applyCommonResponsesParams(params, gpt56SolModel, { messages: [] });

    expect(params).not.toHaveProperty("reasoning");
  });

  it("passes max through for GPT-5.6 Sol", () => {
    expect(resolveResponsesReasoningEffort(gpt56SolModel, "max")).toBe("max");

    const params = {} as never;
    applyCommonResponsesParams(
      params,
      gpt56SolModel,
      { messages: [] },
      {
        reasoningEffort: "max",
      },
    );
    expect(params).toMatchObject({ reasoning: { effort: "max", summary: "auto" } });
  });

  it("raises unsupported minimal reasoning to low for GPT-5.6 Sol", () => {
    expect(resolveResponsesReasoningEffort(gpt56SolModel, "minimal")).toBe("low");
  });

  it("keeps max clamped to xhigh for earlier models", () => {
    const gpt55WithXHigh = {
      ...nativeOpenAIModel,
      thinkingLevelMap: { xhigh: "xhigh" },
    } satisfies Model<"openai-responses">;

    expect(resolveResponsesReasoningEffort(gpt55WithXHigh, "max")).toBe("xhigh");
  });
});

describe("convertResponsesMessages", () => {
  const allowedToolCallProviders = testAllowedToolCallProviders;

  it("adds explicit message item types for system and user input items", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      } satisfies Context,
      allowedToolCallProviders,
    );

    expect(input[0]).toMatchObject({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "system" }],
    });
    expect(input[1]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    });
  });

  it("strips the internal cache boundary marker from the system prompt message", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
        messages: [],
      } satisfies Context,
      allowedToolCallProviders,
    );

    expect(input[0]).toMatchObject({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Stable\nDynamic" }],
    });
    expect(JSON.stringify(input)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });

  it("omits phase-tagged assistant replay ids without reasoning", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
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
            content: [
              {
                type: "text",
                text: "Working...",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_commentary",
                  phase: "commentary",
                }),
              },
            ],
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(
      input.find(
        (item) =>
          item &&
          typeof item === "object" &&
          "role" in item &&
          item.role === "assistant" &&
          "phase" in item &&
          item.phase === "commentary",
      ),
    ).toMatchObject({
      phase: "commentary",
    });
    expect(
      input.find(
        (item) =>
          item &&
          typeof item === "object" &&
          "role" in item &&
          item.role === "assistant" &&
          "phase" in item &&
          item.phase === "commentary",
      ),
    ).not.toHaveProperty("id");
  });

  it("omits raw signed assistant ids when the paired reasoning item is absent", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
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
            content: [
              {
                type: "text",
                text: "Earlier answer",
                textSignature: "msg_real_response_item_requiring_reasoning",
              },
            ],
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(
      input.find(
        (item) =>
          item &&
          typeof item === "object" &&
          "role" in item &&
          item.role === "assistant" &&
          "content" in item,
      ),
    ).not.toHaveProperty("id");
  });

  it("omits Responses replay item ids when requested by store-disabled callers", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              {
                type: "thinking",
                thinking: "Need a tool.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_prior",
                  encrypted_content: "ciphertext",
                }),
              },
              {
                type: "text",
                text: "Checking the price.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_prior",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call_abc|fc_prior",
                name: "price_lookup",
                arguments: { symbol: "SOL" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_abc|fc_prior",
            toolName: "price_lookup",
            content: [{ type: "text", text: "$83.95" }],
            isError: false,
            timestamp: 2,
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false, replayResponsesItemIds: false },
    ) as unknown as Array<Record<string, unknown>>;

    const reasoningItem = input.find((item) => item.type === "reasoning");
    expect(reasoningItem).toMatchObject({
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    });
    expect(reasoningItem).not.toHaveProperty("id");

    const assistantMessage = input.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expect(assistantMessage).toMatchObject({
      type: "message",
      role: "assistant",
      phase: "commentary",
    });
    expect(assistantMessage).not.toHaveProperty("id");

    const functionCall = input.find((item) => item.type === "function_call");
    expect(functionCall).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall).not.toHaveProperty("id");
  });

  it("replays update_plan-style empty non-image tool results as no output", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [{ type: "toolCall", id: "call_plan", name: "update_plan", arguments: {} }],
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
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    ) as unknown as Array<Record<string, unknown>>;

    const functionOutput = input.find((item) => item.type === "function_call_output");
    expect(functionOutput).toMatchObject({
      type: "function_call_output",
      call_id: "call_plan",
      output: "(no output)",
    });
  });

  it("preserves image-bearing tool results instead of using no-output text", () => {
    const input = convertResponsesMessages(
      { ...nativeOpenAIModel, input: ["text", "image"] },
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              { type: "toolCall", id: "call_screenshot", name: "screenshot", arguments: {} },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_screenshot",
            toolName: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "aW1n" }],
            isError: false,
            timestamp: 2,
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    ) as unknown as Array<{ type?: string; output?: unknown }>;

    const functionOutput = input.find((item) => item.type === "function_call_output");
    expect(functionOutput?.output).toEqual([
      {
        type: "input_image",
        detail: "auto",
        image_url: "data:image/png;base64,aW1n",
      },
    ]);
  });

  it("uses audio placeholder for audio-only tool results instead of image or no-output text", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [{ type: "toolCall", id: "call_audio", name: "audio", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "call_audio",
            toolName: "audio",
            content: [{ type: "audio", mimeType: "audio/mpeg", data: "YXVkaW8=" }],
            isError: false,
            timestamp: 2,
          },
        ],
      } as unknown as Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    ) as unknown as Array<Record<string, unknown>>;

    const functionOutput = input.find((item) => item.type === "function_call_output");
    expect(functionOutput).toMatchObject({
      type: "function_call_output",
      call_id: "call_audio",
      output: "(see attached audio)",
    });
    expect(functionOutput?.output).not.toBe("(see attached image)");
    expect(functionOutput?.output).not.toBe("(no output)");
  });

  it("does not emit image parts or placeholders for payload-less tool media", () => {
    const input = convertResponsesMessages(
      { ...nativeOpenAIModel, input: ["text", "image"] },
      {
        systemPrompt: "system",
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_husk",
            toolName: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "" }],
            isError: false,
            timestamp: 2,
          },
        ],
      } as unknown as Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    ) as unknown as Array<Record<string, unknown>>;

    const functionOutput = input.find((item) => item.type === "function_call_output");
    expect(functionOutput?.output).toBe("(no output)");
    expect(JSON.stringify(functionOutput)).not.toContain("input_image");
    expect(JSON.stringify(functionOutput)).not.toContain("see attached image");
  });

  it("keeps encrypted reasoning replay item ids when requested", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: nativeOpenAIModel.api,
            provider: nativeOpenAIModel.provider,
            model: nativeOpenAIModel.id,
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
            content: [
              {
                type: "thinking",
                thinking: "Need continuity.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_foundry_prior",
                  encrypted_content: "ciphertext",
                }),
              },
            ],
          },
        ],
      } satisfies Context,
      allowedToolCallProviders,
      { includeSystemPrompt: false, replayResponsesItemIds: true },
    ) as unknown as Array<Record<string, unknown>>;

    expect(input.find((item) => item.type === "reasoning")).toMatchObject({
      type: "reasoning",
      id: "rs_foundry_prior",
      encrypted_content: "ciphertext",
      summary: [],
    });
  });

  it("serializes structured tool results as text instead of image placeholders", () => {
    const input = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_structured",
            toolName: "session_status",
            content: [
              {
                type: "json",
                payload: { sessionKey: "current", model: "openai/gpt-5.4", status: "ok" },
              },
            ],
            isError: false,
            timestamp: 1,
          },
        ],
      } as unknown as Context,
      testAllowedToolCallProviders,
      { includeSystemPrompt: false, replayResponsesItemIds: false },
    ) as unknown as Array<Record<string, unknown>>;
    expect(input).toContainEqual({
      type: "function_call_output",
      call_id: "call_structured",
      output: expect.stringContaining('"type":"json"'),
    });
  });
});

describe("processResponsesStream", () => {
  it("aborts the Responses request signal when the first SSE event never arrives", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const output = createAssistantOutput();
      const stream = new AssistantMessageEventStream();
      const onFirstEventTimeout = vi.fn();
      const resultPromise = runResponsesStreamLifecycle({
        stream,
        model: nativeOpenAIModel,
        output,
        options: { firstEventTimeoutMs: 5, onFirstEventTimeout },
        createClient: () => ({
          responses: {
            create: (_params, requestOptions) => {
              requestSignal = requestOptions.signal;
              return {
                withResponse: async () => ({
                  data: createNeverYieldingResponsesStream<ResponseStreamEvent>(),
                  response: new Response(null, { status: 200 }),
                }),
              };
            },
          },
        }),
        buildParams: () => ({ model: nativeOpenAIModel.id, input: [], stream: true }),
        formatError: (error) => (error instanceof Error ? error.message : String(error)),
      });

      await vi.advanceTimersByTimeAsync(5);
      await resultPromise;

      expect(output.stopReason).toBe("error");
      expect(requestSignal?.aborted).toBe(true);
      expect(requestSignal?.reason).toBeInstanceOf(Error);
      expect(onFirstEventTimeout).toHaveBeenCalledWith(requestSignal?.reason);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails when streaming headers arrive but no first SSE event follows", async () => {
    vi.useFakeTimers();
    try {
      const output = createAssistantOutput();
      const stream = new AssistantMessageEventStream();
      const abortFirstEventStream = vi.fn();
      const onFirstEventTimeout = vi.fn();
      const resultPromise = processResponsesStream(
        createNeverYieldingResponsesStream(),
        output,
        stream,
        nativeOpenAIModel,
        { firstEventTimeoutMs: 5, abortFirstEventStream, onFirstEventTimeout },
      );
      const rejection = expect(resultPromise).rejects.toThrow(
        /responses HTTP stream opened but did not deliver a first SSE event within 5ms/,
      );

      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(abortFirstEventStream).toHaveBeenCalledTimes(1);
      expect(abortFirstEventStream.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(onFirstEventTimeout).toHaveBeenCalledWith(abortFirstEventStream.mock.calls[0]?.[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["omits arguments", undefined],
    ["sends empty arguments", ""],
  ])("preserves streamed tool-call arguments when done %s", async (_label, doneArguments) => {
    const output = createAssistantOutput();
    const stream = new AssistantMessageEventStream();
    const events: Array<Record<string, unknown>> = [];
    const collect = (async () => {
      for await (const event of stream) {
        events.push(event as unknown as Record<string, unknown>);
      }
    })();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          delta: '{"path":"docs/gateway/local-models.md"}',
        },
        {
          type: "response.function_call_arguments.done",
          ...(doneArguments === undefined ? {} : { arguments: doneArguments }),
          item_id: "fc_read",
          name: "read",
          output_index: 0,
          sequence_number: 3,
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            status: "completed",
          },
        },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );
    stream.end();
    await collect;

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_read|fc_read",
        name: "read",
        arguments: { path: "docs/gateway/local-models.md" },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]);
  });

  it("keeps idless tool-call ids stable within a response and unique across responses", async () => {
    const runOnce = async () => {
      const output = createAssistantOutput();
      const { stream, events } = createCapturedAssistantMessageEventStream();
      await processResponsesStream(
        responseEvents([
          {
            type: "response.output_item.added",
            item: { type: "function_call", name: "computer", arguments: "" },
          },
          {
            type: "response.output_item.done",
            item: { type: "function_call", name: "computer", arguments: "{}" },
          },
        ]),
        output,
        stream,
        nativeOpenAIModel,
      );
      const block = output.content.find((entry) => entry.type === "toolCall");
      const end = events.find((event) => event.type === "toolcall_end");
      if (!block || block.type !== "toolCall" || !end || end.type !== "toolcall_end") {
        throw new Error("missing tool-call lifecycle");
      }
      return { blockId: block.id, endId: end.toolCall.id };
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(first.blockId).toMatch(/^call_[0-9a-f]{24}$/);
    expect(first.endId).toBe(first.blockId);
    expect(second.endId).toBe(second.blockId);
    expect(second.blockId).not.toBe(first.blockId);
  });

  it("uses the SDK call id directly when the optional item id stays absent", async () => {
    const events: ResponseStreamEvent[] = [
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          type: "function_call",
          call_id: "call_without_item_id",
          name: "computer",
          arguments: "",
          status: "in_progress",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 2,
        item: {
          type: "function_call",
          call_id: "call_without_item_id",
          name: "computer",
          arguments: "{}",
          status: "completed",
        },
      },
    ];
    const output = createAssistantOutput();

    await processResponsesStream(
      streamResponsesEvents(events),
      output,
      new AssistantMessageEventStream(),
      nativeOpenAIModel,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_without_item_id",
        name: "computer",
        arguments: {},
      },
    ]);
  });

  it("adopts the completed SDK item id while preserving lifecycle and result linkage", async () => {
    const responseStream: ResponseStreamEvent[] = [
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          type: "function_call",
          call_id: "call_weather",
          name: "weather",
          arguments: "",
          status: "in_progress",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 2,
        item: {
          type: "function_call",
          id: "fc_weather",
          call_id: "call_weather",
          name: "weather",
          arguments: '{"city":"Seattle"}',
          status: "completed",
        },
      },
    ];
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();
    let startedId: string | undefined;
    const capturePush = stream.push.bind(stream);
    stream.push = (event) => {
      if (event.type === "toolcall_start") {
        const block = event.partial.content[event.contentIndex];
        startedId = block?.type === "toolCall" ? block.id : undefined;
      }
      capturePush(event);
    };

    await processResponsesStream(
      streamResponsesEvents(responseStream),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(startedId).toBe("call_weather");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_weather|fc_weather",
        name: "weather",
        arguments: { city: "Seattle" },
      },
    ]);
    expect(
      events.map((event) => [event.type, "contentIndex" in event ? event.contentIndex : undefined]),
    ).toEqual([
      ["toolcall_start", 0],
      ["toolcall_end", 0],
    ]);

    const replay = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "",
        messages: [
          output,
          {
            role: "toolResult",
            toolCallId: "call_weather|fc_weather",
            toolName: "weather",
            content: [{ type: "text", text: "Rain" }],
            isError: false,
            timestamp: 1,
          },
        ],
      } satisfies Context,
      testAllowedToolCallProviders,
      { includeSystemPrompt: false },
    ) as unknown as Array<Record<string, unknown>>;
    expect(replay).toContainEqual({
      type: "function_call",
      id: "fc_weather",
      call_id: "call_weather",
      name: "weather",
      arguments: '{"city":"Seattle"}',
    });
    expect(replay).toContainEqual({
      type: "function_call_output",
      call_id: "call_weather",
      output: "Rain",
    });
  });

  it("keeps interleaved Responses function calls bound to their output indices", async () => {
    const responseStream: ResponseStreamEvent[] = [
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          type: "function_call",
          id: "fc_click",
          call_id: "call_click",
          name: "computer",
          arguments: "",
          status: "in_progress",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        sequence_number: 2,
        item: {
          type: "function_call",
          id: "fc_type",
          call_id: "call_type",
          name: "computer",
          arguments: "",
          status: "in_progress",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "fc_type",
        sequence_number: 3,
        delta: '{"action":"type","text":"hello"}',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_click",
        sequence_number: 4,
        delta: '{"action":"left_click","coordinate":[10,20]}',
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 5,
        item: {
          type: "function_call",
          id: "fc_click",
          call_id: "call_click",
          name: "computer",
          arguments: '{"action":"left_click","coordinate":[10,20]}',
          status: "completed",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        sequence_number: 6,
        item: {
          type: "function_call",
          id: "fc_type",
          call_id: "call_type",
          name: "computer",
          arguments: '{"action":"type","text":"hello"}',
          status: "completed",
        },
      },
    ];
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await processResponsesStream(
      streamResponsesEvents(responseStream),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_click|fc_click",
        name: "computer",
        arguments: { action: "left_click", coordinate: [10, 20] },
      },
      {
        type: "toolCall",
        id: "call_type|fc_type",
        name: "computer",
        arguments: { action: "type", text: "hello" },
      },
    ]);
    expect(
      events
        .filter((event) => event.type.startsWith("toolcall_"))
        .map((event) => [event.type, "contentIndex" in event ? event.contentIndex : undefined]),
    ).toEqual([
      ["toolcall_start", 0],
      ["toolcall_start", 1],
      ["toolcall_delta", 1],
      ["toolcall_delta", 0],
      ["toolcall_end", 0],
      ["toolcall_end", 1],
    ]);
  });

  it("routes indexed Responses tool arguments when item ids rotate", async () => {
    const output = createResponsesAssistantOutput(gpt56SolModel);
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "encrypted_delta_1",
          delta: '{"path":',
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "encrypted_delta_2",
          delta: '"README.md"}',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "encrypted_done",
          arguments: '{"path":"README.md"}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
            arguments: "",
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_read", status: "completed" },
        },
      ]),
      output,
      stream,
      gpt56SolModel,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_read|fc_read",
        name: "read",
        arguments: { path: "README.md" },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
    ]);
  });

  it("rejects indexed Responses completions when call ids change", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await expect(
      processResponsesStream(
        responseEvents([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_read",
              call_id: "call_read_a",
              name: "read",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "encrypted_delta",
            delta: '{"path":"README.md"}',
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_read_done",
              call_id: "call_read_b",
              name: "read",
              arguments: '{"path":"README.md"}',
            },
          },
          {
            type: "response.completed",
            response: { id: "resp_read", status: "completed" },
          },
        ]),
        output,
        stream,
        nativeOpenAIModel,
      ),
    ).rejects.toThrow("Responses stream completed with unresolved tool calls");
    expect(events.map((event) => event.type)).toEqual(["toolcall_start", "toolcall_delta"]);
  });

  it("rejects reuse of an active Responses tool-call output index", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await expect(
      processResponsesStream(
        responseEvents([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_first_index_owner",
              call_id: "call_first_index_owner",
              name: "computer",
              arguments: "",
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_second_index_owner",
              call_id: "call_second_index_owner",
              name: "computer",
              arguments: "",
            },
          },
        ]),
        output,
        stream,
        nativeOpenAIModel,
      ),
    ).rejects.toThrow("Responses stream reused active tool-call output index 0");
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(0);
  });

  it("keeps parallel unindexed Responses calls bound by identity without orphans", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();
    const firstItem = {
      type: "function_call",
      id: "fc_first_unindexed",
      call_id: "call_first_unindexed",
      name: "computer",
      arguments: '{"slot":1}',
      status: "completed",
    };
    const secondItem = {
      type: "function_call",
      id: "fc_second_unindexed",
      call_id: "call_second_unindexed",
      name: "computer",
      arguments: '{"slot":2}',
      status: "completed",
    };

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          item: { ...firstItem, arguments: "", status: "in_progress" },
        },
        {
          type: "response.output_item.added",
          item: { ...secondItem, arguments: "", status: "in_progress" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: secondItem.id,
          delta: secondItem.arguments,
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: firstItem.id,
          delta: firstItem.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          item_id: firstItem.id,
          arguments: firstItem.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          item_id: secondItem.id,
          arguments: secondItem.arguments,
        },
        { type: "response.output_item.done", item: firstItem },
        { type: "response.output_item.done", item: secondItem },
        {
          type: "response.completed",
          response: {
            id: "resp_parallel_unindexed",
            status: "completed",
            output: [firstItem, secondItem],
          },
        },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_first_unindexed|fc_first_unindexed",
        name: "computer",
        arguments: { slot: 1 },
      },
      {
        type: "toolCall",
        id: "call_second_unindexed|fc_second_unindexed",
        name: "computer",
        arguments: { slot: 2 },
      },
    ]);
    expect(
      events
        .filter((event) => event.type === "toolcall_end")
        .map((event) =>
          event.type === "toolcall_end"
            ? [event.contentIndex, event.toolCall.id, event.toolCall.arguments]
            : undefined,
        ),
    ).toEqual([
      [0, "call_first_unindexed|fc_first_unindexed", { slot: 1 }],
      [1, "call_second_unindexed|fc_second_unindexed", { slot: 2 }],
    ]);
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
  });

  it("fails closed on ambiguous unindexed parallel argument events", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();
    const firstItem = {
      type: "function_call",
      id: "fc_ambiguous_first",
      call_id: "call_ambiguous_first",
      name: "computer",
    };
    const secondItem = {
      type: "function_call",
      id: "fc_ambiguous_second",
      call_id: "call_ambiguous_second",
      name: "computer",
    };

    await expect(
      processResponsesStream(
        responseEvents([
          { type: "response.output_item.added", item: { ...firstItem, arguments: "" } },
          { type: "response.output_item.added", item: { ...secondItem, arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: '{"slot":1}' },
          { type: "response.output_item.done", item: firstItem },
          { type: "response.output_item.done", item: secondItem },
          {
            type: "response.completed",
            response: { id: "resp_ambiguous_unindexed", status: "completed" },
          },
        ]),
        output,
        stream,
        nativeOpenAIModel,
      ),
    ).rejects.toThrow("Responses stream completed with unresolved tool calls");
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(0);
  });

  it("recovers parallel arguments from authoritative done events and preserves opening names", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();
    const firstItem = {
      type: "function_call",
      id: "fc_recovered_first",
      call_id: "call_recovered_first",
      name: "read",
    };
    const secondItem = {
      type: "function_call",
      id: "fc_recovered_second",
      call_id: "call_recovered_second",
      name: "write",
    };

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...firstItem, arguments: "" },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...secondItem, arguments: "" },
        },
        { type: "response.function_call_arguments.delta", delta: '{"ambiguous":true}' },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: firstItem.id,
          arguments: '{"path":"README.md"}',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 1,
          item_id: secondItem.id,
          arguments: '{"path":"README.md","text":"ok"}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: firstItem.id,
            call_id: firstItem.call_id,
          },
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "function_call",
            id: secondItem.id,
            call_id: secondItem.call_id,
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_recovered_parallel", status: "completed" },
        },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_recovered_first|fc_recovered_first",
        name: "read",
        arguments: { path: "README.md" },
      },
      {
        type: "toolCall",
        id: "call_recovered_second|fc_recovered_second",
        name: "write",
        arguments: { path: "README.md", text: "ok" },
      },
    ]);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
  });

  it("rejects a completed Responses tool call whose function name changed", async () => {
    const output = createAssistantOutput();

    await expect(
      processResponsesStream(
        responseEvents([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_name_conflict",
              call_id: "call_name_conflict",
              name: "read",
              arguments: "",
            },
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_name_conflict",
              call_id: "call_name_conflict",
              name: "write",
              arguments: "{}",
            },
          },
        ]),
        output,
        new AssistantMessageEventStream(),
        nativeOpenAIModel,
      ),
    ).rejects.toThrow("Responses stream changed tool-call function name from read to write");
  });

  it("routes an omitted-index suffix by item id across parallel Responses calls", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: "",
          },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_first",
          delta: '{"slot":',
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_first",
          delta: "0}",
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          delta: '{"slot":1}',
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: '{"slot":0}',
          },
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: '{"slot":1}',
          },
        },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
      { type: "toolCall", id: "call_second|fc_second", arguments: { slot: 1 } },
    ]);
    expect(
      events
        .filter((event) => event.type === "toolcall_delta")
        .map((event) => ("contentIndex" in event ? event.contentIndex : undefined)),
    ).toEqual([0, 0, 1]);
  });

  it("matches omitted-index parallel completions without duplicating indexed calls", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: "",
          },
        },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: "fc_first",
          delta: '{"incomplete":',
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: '{"slot":1}',
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: '{"slot":0}',
          },
        },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
      { type: "toolCall", id: "call_second|fc_second", arguments: { slot: 1 } },
    ]);
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
  });

  it("rejects omitted-index events whose identity mismatches the sole indexed call", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_other",
          delta: '{"wrong":true}',
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_other",
            call_id: "call_other",
            name: "computer",
            arguments: '{"wrong":true}',
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: '{"slot":0}',
          },
        },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
    ]);
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_delta")).toHaveLength(0);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
  });

  it("keeps sequential omitted-index Responses calls unambiguous", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          output_index: 7,
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: "",
          },
        },
        { type: "response.function_call_arguments.delta", delta: '{"slot":0}' },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: "computer",
            arguments: '{"slot":0}',
          },
        },
        {
          type: "response.output_item.added",
          output_index: 8,
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: "",
          },
        },
        { type: "response.function_call_arguments.delta", delta: '{"slot":1}' },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_second",
            call_id: "call_second",
            name: "computer",
            arguments: '{"slot":1}',
          },
        },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
      { type: "toolCall", id: "call_second|fc_second", arguments: { slot: 1 } },
    ]);
    expect(
      events
        .filter((event) => event.type === "toolcall_delta")
        .map((event) => ("contentIndex" in event ? event.contentIndex : undefined)),
    ).toEqual([0, 1]);
  });

  it("materializes a done-only SDK tool call with a balanced terminal lifecycle", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 1,
          item: {
            type: "function_call",
            id: "fc_done_only",
            call_id: "call_done_only",
            name: "weather",
            arguments: '{"city":"Paris"}',
            status: "completed",
          },
        },
        {
          type: "response.completed",
          sequence_number: 2,
          response: { id: "resp_done_only", status: "completed" },
        },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_done_only|fc_done_only",
        name: "weather",
        arguments: { city: "Paris" },
      },
    ]);
    expect(output.stopReason).toBe("toolUse");
    expect(
      events.map((event) => [event.type, "contentIndex" in event ? event.contentIndex : undefined]),
    ).toEqual([
      ["toolcall_start", 0],
      ["toolcall_end", 0],
    ]);
  });

  it("pairs an item-only tool call with one generated call id", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 1,
          item: {
            type: "function_call",
            id: "fc_item_only",
            name: "computer",
            arguments: "{}",
            status: "completed",
          },
        },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );

    const block = output.content[0];
    const end = events.find((event) => event.type === "toolcall_end");
    if (!block || block.type !== "toolCall" || !end || end.type !== "toolcall_end") {
      throw new Error("missing item-only tool-call lifecycle");
    }
    expect(block.id).toMatch(/^call_[0-9a-f]{24}\|fc_item_only$/);
    expect(end.toolCall.id).toBe(block.id);
  });

  it("prices cache-write tokens separately from ordinary Responses input", async () => {
    const model = {
      ...gpt56SolModel,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    } satisfies Model<"openai-responses">;
    const output = createResponsesAssistantOutput(model, model.api);
    const stream = new AssistantMessageEventStream();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.completed",
          response: {
            id: "resp_cache_write",
            status: "completed",
            usage: {
              input_tokens: 100,
              input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
              output_tokens: 10,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 110,
            },
          },
        },
      ]),
      output,
      stream,
      model,
    );

    expect(output.usage).toMatchObject({
      input: 50,
      output: 10,
      cacheRead: 20,
      cacheWrite: 30,
      totalTokens: 110,
    });
    expect(output.usage.cost.input).toBeCloseTo(0.00025);
    expect(output.usage.cost.output).toBeCloseTo(0.0003);
    expect(output.usage.cost.cacheRead).toBeCloseTo(0.00001);
    expect(output.usage.cost.cacheWrite).toBeCloseTo(0.0001875);
    expect(output.usage.cost.total).toBeCloseTo(0.0007475);
  });

  it("collapses cumulative message snapshot items into one text block (#91959)", async () => {
    const output = createAssistantOutput();
    const stream = new AssistantMessageEventStream();
    const events: Array<Record<string, unknown>> = [];
    const textBlockSignatures: Array<[string, number, string | undefined]> = [];
    const collect = (async () => {
      for await (const event of stream) {
        events.push(event as unknown as Record<string, unknown>);
        if (event.type === "text_start" || event.type === "text_end") {
          const block = Array.isArray(event.partial.content)
            ? (event.partial.content[event.contentIndex] as { textSignature?: string } | undefined)
            : undefined;
          textBlockSignatures.push([event.type, event.contentIndex, block?.textSignature]);
        }
      }
    })();

    const snapshot1 = "Self-attention computes";
    const snapshot2 = "Self-attention computes Q/K/V projections";
    const snapshot3 = "Self-attention computes Q/K/V projections for each token.";
    const messageItem = (id: string, text: string) => ({
      type: "message",
      id,
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    });

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_1", phase: "final_answer" },
        },
        { type: "response.content_part.added", part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", delta: snapshot1 },
        { type: "response.output_item.done", item: messageItem("msg_1", snapshot1) },
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_2", phase: "final_answer" },
        },
        { type: "response.output_item.done", item: messageItem("msg_2", snapshot2) },
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_3", phase: "final_answer" },
        },
        { type: "response.output_item.done", item: messageItem("msg_3", snapshot3) },
        { type: "response.completed", response: { id: "resp_1", status: "completed" } },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );
    stream.end();
    await collect;

    expect(output.content).toEqual([
      {
        type: "text",
        text: snapshot3,
        textSignature: JSON.stringify({ v: 1, id: "msg_3", phase: "final_answer" }),
      },
    ]);
    // Balanced lifecycle: exactly one text_start, every event on index 0, and
    // each collapsed snapshot re-ends the same block with its grown content.
    expect(events.map((event) => [event.type, event.contentIndex])).toEqual([
      ["text_start", 0],
      ["text_delta", 0],
      ["text_end", 0],
      ["text_end", 0],
      ["text_end", 0],
    ]);
    expect(
      events.filter((event) => event.type === "text_end").map((event) => event.content),
    ).toEqual([snapshot1, snapshot2, snapshot3]);
    expect(textBlockSignatures).toEqual([
      ["text_start", 0, JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" })],
      ["text_end", 0, JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" })],
      ["text_end", 0, JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" })],
      ["text_end", 0, JSON.stringify({ v: 1, id: "msg_3", phase: "final_answer" })],
    ]);
  });

  it.each([
    ["identical", "Hello world.", "Hello world."],
    ["shrinking", "Step one. Step two.", "Step one."],
  ])("keeps %s adjacent same-phase message items as distinct blocks", async (_label, a, b) => {
    const output = createAssistantOutput();
    const stream = new AssistantMessageEventStream();
    const events: Array<Record<string, unknown>> = [];
    const collect = (async () => {
      for await (const event of stream) {
        events.push(event as unknown as Record<string, unknown>);
      }
    })();
    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_1", phase: "final_answer" },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_1",
            phase: "final_answer",
            content: [{ type: "output_text", text: a }],
          },
        },
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_2", phase: "final_answer" },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_2",
            phase: "final_answer",
            content: [{ type: "output_text", text: b }],
          },
        },
        { type: "response.completed", response: { id: "resp_1", status: "completed" } },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );
    stream.end();
    await collect;

    // Only strict extensions collapse; equal or shrinking items are real,
    // independently identified messages and must never be removed.
    expect(output.content).toEqual([
      {
        type: "text",
        text: a,
        textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" }),
      },
      {
        type: "text",
        text: b,
        textSignature: JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" }),
      },
    ]);
    // The deferred second item still opens and closes its own block.
    expect(events.map((event) => [event.type, event.contentIndex])).toEqual([
      ["text_start", 0],
      ["text_end", 0],
      ["text_start", 1],
      ["text_end", 1],
    ]);
  });

  it("streams a deferred distinct message live once its text diverges from the prior block", async () => {
    const output = createAssistantOutput();
    const stream = new AssistantMessageEventStream();
    const events: Array<Record<string, unknown>> = [];
    const liveTextBlockSignatures: Array<[string, number, string | undefined]> = [];
    const collect = (async () => {
      for await (const event of stream) {
        events.push(event as unknown as Record<string, unknown>);
        if (event.type === "text_start" || event.type === "text_delta") {
          const block =
            event.partial && Array.isArray(event.partial.content)
              ? (event.partial.content[event.contentIndex] as
                  | { textSignature?: string }
                  | undefined)
              : undefined;
          liveTextBlockSignatures.push([event.type, event.contentIndex, block?.textSignature]);
        }
      }
    })();

    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_1", phase: "final_answer" },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_1",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Hello." }],
          },
        },
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_2", phase: "final_answer" },
        },
        { type: "response.content_part.added", part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", delta: "Good" },
        { type: "response.output_text.delta", delta: "bye" },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_2",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Goodbye" }],
          },
        },
        { type: "response.completed", response: { id: "resp_1", status: "completed" } },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );
    stream.end();
    await collect;

    expect(output.content).toEqual([
      {
        type: "text",
        text: "Hello.",
        textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" }),
      },
      {
        type: "text",
        text: "Goodbye",
        textSignature: JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" }),
      },
    ]);
    // The withheld prefix is replayed as one delta at divergence ("Good"
    // diverges from "Hello."), then later deltas stream live.
    expect(events.map((event) => [event.type, event.contentIndex, event.delta ?? null])).toEqual([
      ["text_start", 0, null],
      ["text_end", 0, null],
      ["text_start", 1, null],
      ["text_delta", 1, "Good"],
      ["text_delta", 1, "bye"],
      ["text_end", 1, null],
    ]);
    expect(liveTextBlockSignatures).toEqual([
      ["text_start", 0, JSON.stringify({ v: 1, id: "msg_1", phase: "final_answer" })],
      ["text_start", 1, JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" })],
      ["text_delta", 1, JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" })],
      ["text_delta", 1, JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" })],
    ]);
  });

  it("keeps prefix-nested message items separated by a reasoning item as separate blocks", async () => {
    const output = createAssistantOutput();
    const stream = new AssistantMessageEventStream();
    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_1", phase: "final_answer" },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_1",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Step one." }],
          },
        },
        { type: "response.output_item.added", item: { type: "reasoning" } },
        {
          type: "response.output_item.done",
          item: { type: "reasoning", id: "rs_1", summary: [] },
        },
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_2", phase: "final_answer" },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_2",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Step one. Step two." }],
          },
        },
        { type: "response.completed", response: { id: "resp_1", status: "completed" } },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );
    stream.end();

    // Collapsing across the reasoning block would orphan it for replay.
    expect(output.content.map((block) => block.type)).toEqual(["text", "thinking", "text"]);
    expect(output.content[2]).toMatchObject({ type: "text", text: "Step one. Step two." });
  });

  it("keeps prefix-nested message items with different phases as separate blocks", async () => {
    const output = createAssistantOutput();
    const stream = new AssistantMessageEventStream();
    await processResponsesStream(
      responseEvents([
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_1", phase: "commentary" },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_1",
            phase: "commentary",
            content: [{ type: "output_text", text: "Done" }],
          },
        },
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_2", phase: "final_answer" },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_2",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Done." }],
          },
        },
        { type: "response.completed", response: { id: "resp_1", status: "completed" } },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );
    stream.end();

    expect(output.content).toEqual([
      {
        type: "text",
        text: "Done",
        textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }),
      },
      {
        type: "text",
        text: "Done.",
        textSignature: JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" }),
      },
    ]);
  });
});

describe("Azure OpenAI Responses content type support", () => {
  const azureModel = {
    id: "gpt-5.5",
    name: "GPT-5.5 (Azure)",
    api: "azure-openai-responses",
    provider: "azure",
    baseUrl: "https://test.openai.azure.com/openai/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  } satisfies Model<"azure-openai-responses">;

  it("supports Azure 'text' content type in addition to 'output_text'", () => {
    const input = convertResponsesMessages(
      azureModel,
      {
        systemPrompt: "system",
        messages: [
          {
            role: "assistant",
            api: azureModel.api,
            provider: azureModel.provider,
            model: azureModel.id,
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
            content: [
              {
                type: "text",
                text: "Azure response with text content type",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_azure_text",
                }),
              },
            ],
          },
        ],
      } satisfies Context,
      new Set(["azure", "azure-openai-responses"]),
      { includeSystemPrompt: false },
    );

    const assistantMessage = input.find(
      (item) => item && typeof item === "object" && "role" in item && item.role === "assistant",
    );

    expect(assistantMessage).toMatchObject({
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Azure response with text content type",
          annotations: [],
        },
      ],
    });
  });

  it("processResponsesStream handles Azure 'text' content type with output_text deltas", async () => {
    const azureEvents: OpenAIResponsesStreamEvent[] = [
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          type: "message",
          role: "assistant",
          id: "msg_azure_1",
          content: [],
          status: "in_progress",
        },
      },
      {
        type: "response.content_part.added",
        content_index: 0,
        item_id: "msg_azure_1",
        output_index: 0,
        sequence_number: 2,
        part: {
          type: "text",
          text: "",
        },
      },
      {
        type: "response.output_text.delta",
        content_index: 0,
        delta: "Hello",
        item_id: "msg_azure_1",
        logprobs: [],
        output_index: 0,
        sequence_number: 3,
      },
      {
        type: "response.output_text.delta",
        content_index: 0,
        delta: " from",
        item_id: "msg_azure_1",
        logprobs: [],
        output_index: 0,
        sequence_number: 4,
      },
      {
        type: "response.output_text.delta",
        content_index: 0,
        delta: " Azure!",
        item_id: "msg_azure_1",
        logprobs: [],
        output_index: 0,
        sequence_number: 5,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 6,
        item: {
          type: "message",
          role: "assistant",
          id: "msg_azure_1",
          content: [
            {
              type: "text",
              text: "Hello from Azure!",
            },
          ],
          status: "completed",
        },
      },
      {
        type: "response.completed",
        sequence_number: 7,
        response: {
          id: "resp_azure_123",
          created_at: 1,
          output_text: "Hello from Azure!",
          error: null,
          incomplete_details: null,
          instructions: null,
          metadata: null,
          model: azureModel.id,
          object: "response",
          output: [],
          parallel_tool_calls: false,
          temperature: null,
          tool_choice: "auto",
          tools: [],
          top_p: null,
          status: "completed",
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 15,
          },
        },
      },
    ];

    const { stream, events } = createCapturedAssistantMessageEventStream();
    const output = createResponsesAssistantOutput(azureModel, "azure-openai-responses");
    await processResponsesStream(streamResponsesEvents(azureEvents), output, stream, azureModel);

    expect(
      events.map((event) =>
        event.type === "text_delta"
          ? { type: event.type, delta: event.delta }
          : event.type === "text_end"
            ? { type: event.type, content: event.content }
            : { type: event.type },
      ),
    ).toEqual([
      { type: "text_start" },
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " from" },
      { type: "text_delta", delta: " Azure!" },
      { type: "text_end", content: "Hello from Azure!" },
    ]);

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({
      type: "text",
      text: "Hello from Azure!",
    });

    expect(output.usage).toMatchObject({
      input: 10,
      output: 5,
      totalTokens: 15,
    });

    expect(output.stopReason).toBe("stop");
  });

  it("processResponsesStream handles Azure text deltas without a content_part.added event", async () => {
    const azureEvents: OpenAIResponsesStreamEvent[] = [
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          type: "message",
          role: "assistant",
          id: "msg_azure_without_part",
          content: [],
          status: "in_progress",
        },
      },
      {
        type: "response.text.delta",
        delta: "No explicit",
      },
      {
        type: "response.text.delta",
        delta: " part",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 4,
        item: {
          type: "message",
          role: "assistant",
          id: "msg_azure_without_part",
          content: [
            {
              type: "text",
              text: "No explicit part",
            },
          ],
          status: "completed",
        },
      },
      {
        type: "response.completed",
        sequence_number: 5,
        response: {
          id: "resp_azure_without_part",
          created_at: 1,
          output_text: "No explicit part",
          error: null,
          incomplete_details: null,
          instructions: null,
          metadata: null,
          model: azureModel.id,
          object: "response",
          output: [],
          parallel_tool_calls: false,
          temperature: null,
          tool_choice: "auto",
          tools: [],
          top_p: null,
          status: "completed",
          usage: {
            input_tokens: 3,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 6,
          },
        },
      },
    ];

    const { stream, events } = createCapturedAssistantMessageEventStream();
    const output = createResponsesAssistantOutput(azureModel, "azure-openai-responses");
    const liveTextSignatures: Array<string | undefined> = [];
    const push = stream.push.bind(stream);
    stream.push = (event) => {
      if (event.type === "text_start" || event.type === "text_delta") {
        const block = event.partial?.content[event.contentIndex];
        liveTextSignatures.push(block?.type === "text" ? block.textSignature : undefined);
      }
      push(event);
    };

    await processResponsesStream(streamResponsesEvents(azureEvents), output, stream, azureModel);

    expect(
      events.map((event) =>
        event.type === "text_delta"
          ? event.delta
          : event.type === "text_end"
            ? `[END:${event.content}]`
            : event.type,
      ),
    ).toEqual(["text_start", "No explicit", " part", "[END:No explicit part]"]);

    expect(output.content[0]).toMatchObject({
      type: "text",
      text: "No explicit part",
    });
    // Unphased Responses items keep streaming live; replay identity is stamped
    // only once completion supplies the final block.
    expect(liveTextSignatures).toEqual([undefined, undefined, undefined]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
