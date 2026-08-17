import path from "node:path";
import { APIError as AnthropicAPIError } from "@anthropic-ai/sdk/core/error.js";
import type { AssistantMessageEventStreamLike, Context, Model } from "@openclaw/llm-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";

type OpenAIChunk = Record<string, unknown>;

const openAiMockState = vi.hoisted(() => ({
  error: undefined as Error | undefined,
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

const anthropicModel = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
} satisfies Model<"anthropic-messages">;

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

const context = {
  systemPrompt: "Be exact.",
  messages: [{ role: "user", content: "Find the answer.", timestamp: 1 }],
  tools: [
    {
      name: "lookup",
      description: "Look up a value.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
} satisfies Context;

const anthropicEvents = [
  {
    type: "message_start",
    message: {
      id: "msg_parity",
      model: "claude-sonnet-4-6-response",
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "seed", signature: "seed-signature" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: " + thought" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "final-signature" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "Hello" },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: " world" },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 7, output_tokens: 5 },
  },
  { type: "message_stop" },
] satisfies Record<string, unknown>[];

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

const openAiTrailingReasoningChunks = [
  makeOpenAiChunk({ reasoning_content: "First thought." }),
  makeOpenAiChunk({ content: "Answer." }),
  makeOpenAiChunk({ reasoning_content: "Trailing thought." }),
  makeOpenAiChunk({ content: " " }),
  makeOpenAiChunk({}, "stop"),
] satisfies OpenAIChunk[];

const anthropicFailure = {
  status: 429,
  body: {
    type: "error",
    error: { type: "rate_limit_error", message: "synthetic Anthropic rejection" },
  },
  headers: { "content-type": "application/json", "retry-after": "2" },
} as const;

function createAnthropicResponse(events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "req-parity" },
  });
}

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
): Promise<ParityOutput> {
  resetOpenAiMock(outcome, chunks);
  const model = emitReasoning ? openAiModel : { ...openAiModel, reasoning: false };
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
              return createAnthropicResponse(anthropicEvents);
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
      return createAnthropicResponse(anthropicEvents);
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
  let initialHost: ReturnType<typeof getAiTransportHost>;

  beforeAll(() => {
    initialHost = getAiTransportHost();
  });

  afterEach(() => {
    configureAiTransportHost(initialHost);
  });

  afterAll(() => {
    configureAiTransportHost(initialHost);
  });

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
            textSignature: '{"v":1,"id":"commentary-0","phase":"commentary"}',
          },
          {
            type: "thinking",
            thinking: "Second thought.",
            thinkingSignature: "reasoning_content",
          },
          {
            type: "text",
            text: "Final.",
            textSignature: '{"v":1,"id":"final-answer-0","phase":"final_answer"}',
          },
        ]);
      }

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
          textSignature: '{"v":1,"id":"commentary-0","phase":"commentary"}',
        },
        {
          type: "text",
          text: "Final.",
          textSignature: '{"v":1,"id":"final-answer-0","phase":"final_answer"}',
        },
      ]);

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
    }
  });
});
