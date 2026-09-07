import path from "node:path";
import { APIError as AnthropicAPIError } from "@anthropic-ai/sdk/core/error.js";
import type { AssistantMessageEventStreamLike, Model } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";
import {
  anthropicModel,
  context,
  anthropicEvents,
  createAnthropicResponse,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";

type OpenAIChunk = Record<string, unknown>;

const openAiMockState = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  streamError: undefined as Error | undefined,
  chunks: [] as OpenAIChunk[],
  payloads: [] as unknown[],
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: (payload: unknown) => {
          openAiMockState.payloads.push(payload);
          if (openAiMockState.error) {
            throw openAiMockState.error;
          }
          const createIterable = () => ({
            async *[Symbol.asyncIterator]() {
              for (const chunk of openAiMockState.chunks) {
                yield chunk;
              }
              if (openAiMockState.streamError) {
                throw openAiMockState.streamError;
              }
            },
          });
          const iterable = createIterable();
          return Object.assign(iterable, {
            withResponse: async () => ({
              data: createIterable(),
              response: { status: 200, headers: new Headers({ "x-request-id": "req-parity" }) },
            }),
          });
        },
      },
    };
  },
}));

type ParityOutput = {
  payload?: unknown;
  eventTrace: unknown[];
  terminal: Record<string, unknown>;
  errorFields: Record<string, unknown>;
};

type ParityFixture = {
  name: string;
  provider: "anthropic" | "openai";
  outcome: "success" | "error";
  snapshot?: string;
};

const openAiModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<"openai-completions">;

const openRouterModel = {
  ...openAiModel,
  id: "openrouter/minimax/minimax-m2.7",
  name: "MiniMax M2.7",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
} satisfies Model<"openai-completions">;

const openRouterModelWithoutBaseUrl = {
  ...openRouterModel,
  baseUrl: undefined,
} as unknown as Model<"openai-completions">;

const openAiChunks = [
  {
    id: "chatcmpl-parity",
    model: "gpt-5.5-response",
    choices: [{ index: 0, delta: { reasoning_content: "Think." }, finish_reason: null }],
  },
  {
    id: "chatcmpl-parity",
    model: "gpt-5.5-response",
    choices: [{ index: 0, delta: { content: "Answer." }, finish_reason: null }],
  },
  {
    id: "chatcmpl-parity",
    model: "gpt-5.5-response",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 8,
      completion_tokens: 4,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  },
] satisfies OpenAIChunk[];

function makeOpenAiChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): OpenAIChunk {
  return {
    id: "chatcmpl-parity",
    model: "gpt-5.5-response",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const openAiInterleavedReasoningChunks = [
  makeOpenAiChunk({ reasoning_content: "First thought." }),
  makeOpenAiChunk({ content: "Interim." }),
  makeOpenAiChunk({ reasoning_content: "Second thought." }),
  makeOpenAiChunk({ content: "Final." }),
  makeOpenAiChunk({}, "stop"),
] satisfies OpenAIChunk[];

const openAiCoalescedReasoningChunks = [
  makeOpenAiChunk({ reasoning_content: "First thought." }),
  makeOpenAiChunk({ content: "Interim." }),
  makeOpenAiChunk({ content: "Final.", reasoning_content: "Second thought." }),
  makeOpenAiChunk({}, "stop"),
] satisfies OpenAIChunk[];

const openAiTypedReasoningChunks = [
  makeOpenAiChunk({ content: { type: "reasoning", text: "First thought." } }),
  makeOpenAiChunk({ content: "Interim." }),
  makeOpenAiChunk({ content: { type: "reasoning", text: "Second thought." } }),
  makeOpenAiChunk({ content: "Final." }),
  makeOpenAiChunk({}, "stop"),
] satisfies OpenAIChunk[];

const openAiStructuredReasoningChunks = [
  makeOpenAiChunk({
    reasoning_details: [{ type: "reasoning.text", text: "First thought." }],
  }),
  makeOpenAiChunk({ content: "Interim." }),
  makeOpenAiChunk({
    reasoning_details: [{ type: "reasoning.text", text: "Second thought." }],
  }),
  makeOpenAiChunk({ content: "Final." }),
  makeOpenAiChunk({}, "stop"),
] satisfies OpenAIChunk[];

const openAiOrderedVisibleReasoningDetailsChunks = [
  makeOpenAiChunk({
    reasoning_details: [
      { type: "response.output_text", text: "Visible first." },
      { type: "reasoning.text", text: " Hidden second." },
      { type: "response.text", text: " Visible third." },
    ],
  }),
  makeOpenAiChunk({}, "stop"),
] satisfies OpenAIChunk[];

const openAiSplitVisibleReasoningDetailsChunks = [
  makeOpenAiChunk({
    reasoning_details: [{ type: "response.output_text", text: "Visible first." }],
  }),
  makeOpenAiChunk({
    reasoning_details: [{ type: "reasoning.text", text: " Hidden second." }],
  }),
  makeOpenAiChunk({
    reasoning_details: [{ type: "response.text", text: " Visible third." }],
  }),
  makeOpenAiChunk({}, "stop"),
] satisfies OpenAIChunk[];

const openAiVisibleDetailBeforeInterruptedContentChunks = [
  makeOpenAiChunk({
    reasoning_details: [{ type: "response.output_text", text: "Visible first." }],
  }),
  makeOpenAiChunk({
    reasoning_details: [{ type: "reasoning.text", text: " Hidden second." }],
  }),
  makeOpenAiChunk({ content: "Interim." }),
  makeOpenAiChunk({ reasoning_content: "Hidden fourth." }),
  makeOpenAiChunk({ content: "Final." }),
  makeOpenAiChunk({}, "stop"),
] satisfies OpenAIChunk[];

const openAiTrailingReasoningChunks = [
  makeOpenAiChunk({ reasoning_content: "First thought." }),
  makeOpenAiChunk({ content: "Answer." }),
  makeOpenAiChunk({ reasoning_content: "Trailing thought." }),
  makeOpenAiChunk({ content: " " }),
  makeOpenAiChunk({}, "stop"),
] satisfies OpenAIChunk[];

const openAiInterleavedThenTrailingReasoningChunks = [
  makeOpenAiChunk({ reasoning_content: "First thought." }),
  makeOpenAiChunk({ content: "Interim." }),
  makeOpenAiChunk({ reasoning_content: "Second thought." }),
  makeOpenAiChunk({ content: "Final." }),
  makeOpenAiChunk({ reasoning_content: "Trailing thought." }),
  makeOpenAiChunk({}, "stop"),
] satisfies OpenAIChunk[];

const openAiInterruptedErrorChunks = [
  makeOpenAiChunk({ reasoning_content: "First thought." }),
  makeOpenAiChunk({ content: "Interim." }),
  makeOpenAiChunk({ reasoning_content: "Second thought." }),
] satisfies OpenAIChunk[];

const anthropicFailure = {
  status: 429,
  body: {
    type: "error",
    error: { type: "rate_limit_error", message: "synthetic Anthropic rejection" },
  },
  headers: { "content-type": "application/json", "retry-after": "2" },
} as const;

function normalizeRecord(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  );
}

async function observeStream(stream: AssistantMessageEventStreamLike): Promise<{
  eventTrace: unknown[];
  terminal: Record<string, unknown>;
  errorFields: Record<string, unknown>;
}> {
  const eventTrace: unknown[] = [];
  for await (const rawEvent of stream) {
    const event = rawEvent as unknown as Record<string, unknown>;
    eventTrace.push(normalizeRecord(event, ["type", "contentIndex", "delta", "content", "reason"]));
  }
  const result = (await stream.result()) as unknown as Record<string, unknown>;
  return {
    eventTrace,
    terminal: normalizeRecord(result, [
      "role",
      "content",
      "api",
      "provider",
      "model",
      "responseId",
      "responseModel",
      "openclawDelivery",
      "usage",
      "stopReason",
      "diagnostics",
    ]),
    errorFields: normalizeRecord(result, ["errorMessage", "errorCode", "errorType", "errorBody"]),
  };
}

function resetOpenAiMock(
  outcome: ParityFixture["outcome"],
  chunks: readonly OpenAIChunk[] = openAiChunks,
): void {
  openAiMockState.payloads = [];
  openAiMockState.streamError = undefined;
  openAiMockState.chunks = outcome === "success" ? [...chunks] : [];
  openAiMockState.error =
    outcome === "error"
      ? Object.assign(new Error("synthetic OpenAI rejection"), {
          status: 429,
          code: "rate_limit_exceeded",
          type: "rate_limit_error",
          error: { code: "rate_limit_exceeded", type: "rate_limit_error" },
        })
      : undefined;
}

async function runOpenAi(
  implementation: "provider" | "transport",
  outcome: ParityFixture["outcome"],
  chunks: readonly OpenAIChunk[] = openAiChunks,
  emitReasoning = true,
  modelOverride?: Model<"openai-completions">,
  streamError?: Error,
): Promise<ParityOutput> {
  resetOpenAiMock(outcome, chunks);
  openAiMockState.streamError = streamError;
  const baseModel = modelOverride ?? openAiModel;
  const model = emitReasoning ? baseModel : { ...baseModel, reasoning: false };
  const [{ streamOpenAICompletions }, { createOpenAICompletionsTransportStreamFn }] =
    await Promise.all([
      import("./providers/openai-completions.js"),
      import("./transports/openai-completions-transport.js"),
    ]);
  const stream =
    implementation === "provider"
      ? streamOpenAICompletions(model, context, {
          apiKey: "sk-test",
          reasoningEffort: "medium",
        })
      : await Promise.resolve(
          createOpenAICompletionsTransportStreamFn()(model, context, {
            apiKey: "sk-test",
            reasoningEffort: "medium",
          } as never),
        );
  const observed = await observeStream(stream);
  return {
    ...(outcome === "success" ? { payload: openAiMockState.payloads[0] } : {}),
    ...observed,
  };
}

async function runAnthropic(
  implementation: "provider" | "transport",
  outcome: ParityFixture["outcome"],
  events: readonly Record<string, unknown>[] = anthropicEvents,
): Promise<ParityOutput> {
  let payload: unknown;
  let stream: AssistantMessageEventStreamLike;
  const [{ streamAnthropic }, { createAnthropicMessagesTransportStreamFn }] = await Promise.all([
    import("./providers/anthropic.js"),
    import("./transports/anthropic-transport-stream.js"),
  ]);
  if (implementation === "provider") {
    const client = {
      messages: {
        create: (nextPayload: unknown) => {
          payload = nextPayload;
          return {
            asResponse: async () => {
              if (outcome === "error") {
                throw AnthropicAPIError.generate(
                  anthropicFailure.status,
                  anthropicFailure.body,
                  undefined,
                  new Headers(anthropicFailure.headers),
                );
              }
              return createAnthropicResponse(events);
            },
          };
        },
      },
    };
    stream = streamAnthropic(anthropicModel, context, {
      apiKey: "sk-test",
      client: client as never,
      thinkingEnabled: true,
      thinkingBudgetTokens: 1024,
      effort: "low",
    });
  } else {
    const fetchMock: typeof fetch = async (_input, init) => {
      payload = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      if (outcome === "error") {
        return new Response(JSON.stringify(anthropicFailure.body), {
          status: anthropicFailure.status,
          headers: anthropicFailure.headers,
        });
      }
      return createAnthropicResponse(events);
    };
    configureAiTransportHost({ ...getAiTransportHost(), buildModelFetch: () => fetchMock });
    stream = await Promise.resolve(
      createAnthropicMessagesTransportStreamFn()(anthropicModel, context, {
        apiKey: "sk-test",
        thinkingEnabled: true,
        thinkingBudgetTokens: 1024,
        effort: "low",
      } as never),
    );
  }
  const observed = await observeStream(stream);
  return {
    ...(outcome === "success" ? { payload } : {}),
    ...observed,
  };
}

const fixtures: ParityFixture[] = [
  {
    name: "Anthropic successful request and event trace",
    provider: "anthropic",
    outcome: "success",
    snapshot: "anthropic-success.snap.txt",
  },
  {
    name: "Anthropic structured request failure",
    provider: "anthropic",
    outcome: "error",
  },
  {
    name: "OpenAI successful request and event trace",
    provider: "openai",
    outcome: "success",
    snapshot: "openai-success.snap.txt",
  },
  {
    name: "OpenAI structured request failure",
    provider: "openai",
    outcome: "error",
  },
];

describe("provider and transport observable parity fixtures", () => {
  registerParityHostLifecycle();

  it.each(fixtures)("$name", async ({ provider, outcome, snapshot }) => {
    const run = provider === "anthropic" ? runAnthropic : runOpenAi;
    const providerResult = await run("provider", outcome);
    const transportResult = await run("transport", outcome);
    if (outcome === "error") {
      for (const result of [providerResult, transportResult]) {
        expect(result.terminal.stopReason).toBe("error");
        expect(result.errorFields.errorMessage).toEqual(expect.any(String));
      }
      if (provider === "openai") {
        expect(providerResult.errorFields).toEqual(transportResult.errorFields);
      } else {
        expect(providerResult.errorFields).toMatchObject({
          errorCode: "429",
          errorType: "rate_limit_error",
          errorBody: expect.stringContaining("synthetic Anthropic rejection"),
        });
        expect(transportResult.errorFields.errorMessage).toContain("Retry-After: 2 seconds");
      }
      return;
    }
    if (!snapshot) {
      throw new Error("success parity fixture requires a snapshot");
    }
    await expect(
      `${JSON.stringify({ provider: providerResult, transport: transportResult }, null, 2)}\n`,
    ).toMatchFileSnapshot(
      path.join(import.meta.dirname, "../test/fixtures/provider-transport-parity", snapshot),
    );
  });

  it.each([
    {
      name: "omitted usage after cumulative output updates",
      updates: [{ output_tokens: 7 }, { output_tokens: 11 }],
      final: undefined,
      billing: { input: 37, output: 11, cacheRead: 11, cacheWrite: 5, totalTokens: 64 },
      contextUsage: { state: "available", promptTokens: 53, totalTokens: 64 },
    },
    {
      name: "omitted usage after compaction iterations",
      updates: [
        {
          iterations: [
            {
              type: "compaction",
              input_tokens: 10,
              output_tokens: 3,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 1,
            },
            {
              type: "message",
              input_tokens: 4,
              output_tokens: 5,
              cache_read_input_tokens: 6,
              cache_creation_input_tokens: 7,
            },
          ],
        },
      ],
      final: undefined,
      billing: { input: 14, output: 8, cacheRead: 8, cacheWrite: 8, totalTokens: 38 },
      contextUsage: { state: "available", promptTokens: 17, totalTokens: 22 },
    },
    {
      name: "present empty usage after a reported snapshot",
      updates: [],
      final: {},
      billing: { input: 37, output: 2, cacheRead: 11, cacheWrite: 5, totalTokens: 55 },
      contextUsage: { state: "unavailable" },
    },
  ])(
    "preserves Anthropic accounting for $name",
    async ({ updates, final, billing, contextUsage }) => {
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_usage_parity",
            model: anthropicModel.id,
            usage: {
              input_tokens: 37,
              output_tokens: 2,
              cache_read_input_tokens: 11,
              cache_creation_input_tokens: 5,
            },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
        { type: "content_block_stop", index: 0 },
        ...updates.map((usage) => ({ type: "message_delta", delta: {}, usage })),
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: final },
        { type: "message_stop" },
      ];
      for (const implementation of ["provider", "transport"] as const) {
        const result = await runAnthropic(implementation, "success", events);
        expect(result.terminal).toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: "Done." }],
          usage: { ...billing, contextUsage },
        });
        expect(result.eventTrace.at(-1)).toMatchObject({ type: "done" });
        expect(result.errorFields).toEqual({});
      }
    },
  );

  it.each([
    { name: "malformed seeded input", input: "{", providerError: true },
    {
      name: "encoded object input",
      input: '{"query":"seed"}',
      providerArguments: { query: "seed" },
    },
    {
      name: "streamed arguments superseding a malformed seed",
      input: "{",
      delta: '{"query":"streamed"}',
      providerArguments: { query: "streamed" },
    },
  ])("preserves Anthropic terminal tool validation for $name", async (fixture) => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_seeded",
          model: anthropicModel.id,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_seed", name: "lookup", input: fixture.input },
      },
      ...(fixture.delta
        ? [
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: fixture.delta },
            },
          ]
        : []),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    for (const implementation of ["provider", "transport"] as const) {
      const result = await runAnthropic(implementation, "success", events);
      if (implementation === "provider" && fixture.providerError) {
        expect(result.terminal.stopReason).toBe("error");
        expect(result.errorFields.errorMessage).toContain("malformed JSON arguments");
        expect(result.terminal.content).toEqual([]);
        expect(result.eventTrace).not.toContainEqual(
          expect.objectContaining({ type: "toolcall_end" }),
        );
      } else {
        expect(result.terminal).toMatchObject({
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "call_seed",
              arguments:
                implementation === "provider" || fixture.delta ? fixture.providerArguments : {},
            },
          ],
        });
      }
    }
  });

  it("marks content interrupted by native reasoning as commentary", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      for (const chunks of [openAiInterleavedReasoningChunks, openAiCoalescedReasoningChunks]) {
        const result = await runOpenAi(implementation, "success", chunks);

        expect(result.terminal.content).toEqual([
          {
            type: "thinking",
            thinking: "First thought.",
            thinkingSignature: "reasoning_content",
          },
          {
            type: "text",
            text: "Interim.",
            textSignature: expect.stringMatching(
              /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
            ),
          },
          {
            type: "thinking",
            thinking: "Second thought.",
            thinkingSignature: "reasoning_content",
          },
          {
            type: "text",
            text: "Final.",
            textSignature: expect.stringMatching(
              /^\{"v":1,"id":"final-answer-0-[0-9a-f]{24}","phase":"final_answer"\}$/u,
            ),
          },
        ]);
      }

      const typedReasoningResult = await runOpenAi(
        implementation,
        "success",
        openAiTypedReasoningChunks,
      );
      expect(typedReasoningResult.terminal.content).toEqual([
        { type: "thinking", thinking: "First thought." },
        {
          type: "text",
          text: "Interim.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
          ),
        },
        { type: "thinking", thinking: "Second thought." },
        {
          type: "text",
          text: "Final.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"final-answer-0-[0-9a-f]{24}","phase":"final_answer"\}$/u,
          ),
        },
      ]);

      const structuredReasoningResult = await runOpenAi(
        implementation,
        "success",
        openAiStructuredReasoningChunks,
      );
      expect(structuredReasoningResult.terminal.content).toEqual([
        {
          type: "thinking",
          thinking: "First thought.",
          thinkingSignature: "reasoning_details",
        },
        {
          type: "text",
          text: "Interim.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
          ),
        },
        {
          type: "thinking",
          thinking: "Second thought.",
          thinkingSignature: "reasoning_details",
        },
        {
          type: "text",
          text: "Final.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"final-answer-0-[0-9a-f]{24}","phase":"final_answer"\}$/u,
          ),
        },
      ]);

      const hiddenReasoningResult = await runOpenAi(
        implementation,
        "success",
        openAiInterleavedReasoningChunks,
        false,
      );
      expect(hiddenReasoningResult.terminal.content).toEqual([
        {
          type: "text",
          text: "Interim.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
          ),
        },
        {
          type: "text",
          text: "Final.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"final-answer-0-[0-9a-f]{24}","phase":"final_answer"\}$/u,
          ),
        },
      ]);
      expect(hiddenReasoningResult.terminal.openclawDelivery).toEqual({
        textPhaseRequiresTerminal: true,
      });

      const trailingReasoningResult = await runOpenAi(
        implementation,
        "success",
        openAiTrailingReasoningChunks,
      );
      expect(trailingReasoningResult.terminal.content).toEqual([
        {
          type: "thinking",
          thinking: "First thought.",
          thinkingSignature: "reasoning_content",
        },
        { type: "text", text: "Answer." },
        {
          type: "thinking",
          thinking: "Trailing thought.",
          thinkingSignature: "reasoning_content",
        },
        { type: "text", text: " " },
      ]);

      const interleavedThenTrailingReasoningResult = await runOpenAi(
        implementation,
        "success",
        openAiInterleavedThenTrailingReasoningChunks,
      );
      expect(interleavedThenTrailingReasoningResult.terminal.content).toEqual([
        {
          type: "thinking",
          thinking: "First thought.",
          thinkingSignature: "reasoning_content",
        },
        {
          type: "text",
          text: "Interim.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
          ),
        },
        {
          type: "thinking",
          thinking: "Second thought.",
          thinkingSignature: "reasoning_content",
        },
        {
          type: "text",
          text: "Final.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"final-answer-0-[0-9a-f]{24}","phase":"final_answer"\}$/u,
          ),
        },
        {
          type: "thinking",
          thinking: "Trailing thought.",
          thinkingSignature: "reasoning_content",
        },
      ]);
    }
  });

  it("keeps interrupted text non-deliverable when the stream errors", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const result = await runOpenAi(
        implementation,
        "success",
        openAiInterruptedErrorChunks,
        true,
        undefined,
        new Error("synthetic interrupted stream"),
      );

      expect(result.terminal.stopReason).toBe("error");
      expect(result.terminal.content).toEqual([
        {
          type: "thinking",
          thinking: "First thought.",
          thinkingSignature: "reasoning_content",
        },
        {
          type: "text",
          text: "Interim.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
          ),
        },
        {
          type: "thinking",
          thinking: "Second thought.",
          thinkingSignature: "reasoning_content",
        },
      ]);
    }
  });

  it("preserves ordered visible OpenRouter reasoning details across both producers", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      for (const chunks of [
        openAiOrderedVisibleReasoningDetailsChunks,
        openAiSplitVisibleReasoningDetailsChunks,
      ]) {
        const result = await runOpenAi(implementation, "success", chunks, true, openRouterModel);

        expect(result.terminal.content).toEqual([
          { type: "text", text: "Visible first." },
          {
            type: "thinking",
            thinking: " Hidden second.",
            thinkingSignature: "reasoning_details",
          },
          { type: "text", text: " Visible third." },
        ]);
      }
    }
  });

  it("fails closed before using the OpenAI default endpoint for another provider", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const result = await runOpenAi(
        implementation,
        "success",
        openAiChunks,
        true,
        openRouterModelWithoutBaseUrl,
      );

      expect(result.terminal.stopReason).toBe("error");
      expect(result.errorFields.errorMessage).toContain(
        'Provider "openrouter" requires an explicit base URL',
      );
      expect(openAiMockState.payloads).toEqual([]);
    }
  });

  it("preserves earlier visible details when later ordinary content is interrupted", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const result = await runOpenAi(
        implementation,
        "success",
        openAiVisibleDetailBeforeInterruptedContentChunks,
        true,
        openRouterModel,
      );

      expect(result.terminal.content).toEqual([
        {
          type: "text",
          text: "Visible first.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"final-answer-0-[0-9a-f]{24}","phase":"final_answer"\}$/u,
          ),
        },
        {
          type: "thinking",
          thinking: " Hidden second.",
          thinkingSignature: "reasoning_details",
        },
        {
          type: "text",
          text: "Interim.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"commentary-0-[0-9a-f]{24}","phase":"commentary"\}$/u,
          ),
        },
        {
          type: "thinking",
          thinking: "Hidden fourth.",
          thinkingSignature: "reasoning_content",
        },
        {
          type: "text",
          text: "Final.",
          textSignature: expect.stringMatching(
            /^\{"v":1,"id":"final-answer-1-[0-9a-f]{24}","phase":"final_answer"\}$/u,
          ),
        },
      ]);
    }
  });
});
