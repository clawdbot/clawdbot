// OpenAI Responses shared tests cover tool conversion and response item mapping.
import type { Tool as OpenAIResponsesTool } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Model, Tool } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { convertResponsesMessages, processResponsesStream } from "./openai-responses-shared.js";
import { convertResponsesTools } from "./openai-responses-tools.js";

type ResponsesFunctionTool = Extract<OpenAIResponsesTool, { type: "function" }>;

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
});

describe("convertResponsesMessages", () => {
  const allowedToolCallProviders = new Set(["openai", "openai-codex", "opencode"]);

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
});
