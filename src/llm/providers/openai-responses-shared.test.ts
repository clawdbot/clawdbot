// OpenAI Responses shared tests cover tool conversion and response item mapping.
import type { Tool as OpenAIResponsesTool } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../agents/system-prompt-cache-boundary.js";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, Tool } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  applyCommonResponsesParams,
  createResponsesAssistantOutput,
  convertResponsesMessages,
  type OpenAIResponsesStreamEvent,
  processResponsesStream,
  resolveResponsesReasoningEffort,
} from "./openai-responses-shared.js";
import { convertResponsesTools } from "./openai-responses-tools.js";

type ResponsesFunctionTool = Extract<OpenAIResponsesTool, { type: "function" }>;

async function* streamResponsesEvents(
  events: readonly OpenAIResponsesStreamEvent[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const event of events) {
    yield event;
  }
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

describe("convertResponsesTools", () => {
  it("enables native strict OpenAI Responses tools and normalizes schemas", () => {
    const tools = [
      {
        name: "lookup_weather",
        description: "Get forecast",
        parameters: {},
      },
    ] satisfies Tool[];

    const converted = convertResponsesTools(tools, { model: nativeOpenAIModel });

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
    const converted = convertResponsesTools(
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
    );

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
    const converted = convertResponsesTools(
      [
        {
          name: "lookup_weather",
          description: "Get forecast",
          parameters: {},
        },
      ],
      { model: proxyOpenAIModel },
    );

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
      convertResponsesTools([zeta, alpha]).map((tool) => expectResponsesFunctionTool(tool).name),
    ).toEqual(["alpha", "zeta"]);
  });

  it("skips unreadable schemas and preserves healthy native strict tools", () => {
    const converted = convertResponsesTools(
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
    );

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
  const allowedToolCallProviders = new Set(["openai", "openai-codex", "opencode"]);

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
});

describe("processResponsesStream", () => {
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
    const collect = (async () => {
      for await (const event of stream) {
        events.push(event as unknown as Record<string, unknown>);
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
  });
});
