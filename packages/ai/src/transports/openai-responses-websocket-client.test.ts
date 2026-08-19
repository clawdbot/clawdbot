import {
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
  type AssistantMessage,
  type Context,
  type Model,
} from "@openclaw/llm-core";
import { WebSocketError } from "openai/resources/responses/internal-base.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableAssistantError } from "../../../../src/llm/utils/retry.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import {
  OpenAIResponsesWebSocketSafeRetryError,
  responsesPromptObserver,
  type ResponsesPromptObservation,
} from "./openai-responses-contracts.js";

type StreamMessage =
  | { type: "open" }
  | { type: "error"; error: Error }
  | { type: "close"; code: number }
  | { type: "delay"; ms: number }
  | { type: "message"; message: Record<string, unknown> };
type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

const transportState = vi.hoisted(() => ({
  handshakeMessages: [] as StreamMessage[],
  responseBatches: [] as StreamMessage[][],
  sdkOutcomes: [] as Array<Error | SdkResponse>,
  sdkRequests: [] as Array<Record<string, unknown>>,
  websocketCloseCount: 0,
  websocketCloseReasons: [] as string[],
  websocketClients: [] as Array<{ apiKey?: string; baseURL?: string }>,
  websocketOptions: [] as Array<{ headers?: Record<string, string> }>,
  websocketRequests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    apiKey: string;
    baseURL: string;
    responses = {
      create: (request: Record<string, unknown>) => {
        transportState.sdkRequests.push(request);
        const outcome = transportState.sdkOutcomes.shift() ?? new Error("Unexpected SSE request");
        return {
          withResponse: async () => {
            if (outcome instanceof Error) {
              throw outcome;
            }
            return outcome;
          },
        };
      },
    };

    constructor(options: { apiKey?: string; baseURL?: string }) {
      this.apiKey = options.apiKey ?? "";
      this.baseURL = options.baseURL ?? "https://api.openai.com/v1";
    }

    withOptions(options: { apiKey?: string }) {
      return new MockOpenAI({ apiKey: options.apiKey ?? this.apiKey, baseURL: this.baseURL });
    }
  }

  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: class MockResponsesWS {
    socket = { readyState: 1 };
    private responseMessages: StreamMessage[] = [];

    constructor(
      client: { apiKey?: string; baseURL?: string },
      options: { headers?: Record<string, string> },
    ) {
      transportState.websocketClients.push(client);
      transportState.websocketOptions.push(options);
    }

    send(request: Record<string, unknown>) {
      transportState.websocketRequests.push(request);
      this.responseMessages = transportState.responseBatches.shift() ?? [];
    }

    close(options?: { reason?: string }) {
      transportState.websocketCloseCount += 1;
      transportState.websocketCloseReasons.push(options?.reason ?? "");
      this.socket.readyState = 3;
    }

    on(_event: string, _listener: (error: Error) => void) {
      return this;
    }

    stream() {
      const handshake = transportState.handshakeMessages.shift() ?? { type: "open" as const };
      const readResponses = () => this.responseMessages;
      return (async function* () {
        yield handshake;
        if (handshake.type !== "open") {
          return;
        }
        for (const streamMessage of readResponses()) {
          if (streamMessage.type === "delay") {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, streamMessage.ms);
            });
            continue;
          }
          yield streamMessage;
        }
      })();
    }
  },
}));

import {
  createOpenAIResponsesClient,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";
import { createOpenAIResponsesWebSocketStream } from "./openai-responses-websocket.js";

const initialHost = getAiTransportHost();
const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

function userMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: text, timestamp };
}

function completedEvent(responseId: string, content?: string | Array<Record<string, unknown>>) {
  const output =
    typeof content === "string"
      ? [
          {
            id: `msg_${responseId}`,
            type: "message",
            status: "completed",
            content: [
              {
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.test/source",
                    title: "source",
                    start_index: 0,
                    end_index: content.length,
                  },
                ],
                logprobs: [{ token: content, logprob: -0.1, bytes: [], top_logprobs: [] }],
                text: content,
                type: "output_text",
              },
            ],
            role: "assistant",
            phase: "final_answer",
          },
        ]
      : (content ?? []);
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output,
      usage: {
        input_tokens: 5,
        output_tokens: output.length > 0 ? 3 : 0,
        total_tokens: output.length > 0 ? 8 : 5,
      },
    },
  };
}

function message(event: Record<string, unknown>): StreamMessage {
  return { type: "message", message: event };
}

function wrappedSdkServerError(params: {
  code: string;
  message: string;
  param?: string;
  status: number;
}): WebSocketError {
  const event = {
    type: "error",
    error: {
      type: "invalid_request_error",
      code: params.code,
      message: params.message,
      param: params.param ?? null,
    },
    status: params.status,
  };
  return new WebSocketError(JSON.stringify(event), event as never);
}

function toolCallResponse(responseId: string): StreamMessage[] {
  const functionCall = {
    type: "function_call",
    id: "fc_read",
    call_id: "call_read",
    name: "read",
    arguments: '{"path":"README.md"}',
    status: "completed",
  };
  return [
    message({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...functionCall, arguments: "", status: "in_progress" },
    }),
    message({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fc_read",
      delta: '{"path":"README.md"}',
    }),
    message({
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: "fc_read",
      name: "read",
      arguments: '{"path":"README.md"}',
    }),
    message({
      type: "response.output_item.done",
      output_index: 0,
      item: functionCall,
    }),
    message(completedEvent(responseId, [functionCall])),
  ];
}

function sdkCompletion(responseId: string): SdkResponse {
  return sdkEvent(completedEvent(responseId));
}

function sdkEvent(event: Record<string, unknown>): SdkResponse {
  return {
    data: (async function* () {
      yield event;
    })(),
    response: new Response(null, { status: 200 }),
  };
}

async function run(
  context: Context,
  overrides: {
    model?: Model<"openai-responses">;
    transport?: "sse" | "websocket" | "websocket-cached" | "auto";
    sessionId?: string;
    timeoutMs?: number;
    headers?: Record<string, string>;
    observations?: ResponsesPromptObservation[];
    onCompactionRejected?: () => void;
  } = {},
): Promise<AssistantMessage> {
  const options = {
    apiKey: "test-key",
    sessionId: overrides.sessionId ?? "session-1",
    transport: overrides.transport ?? "websocket-cached",
    reasoningEffort: "low",
    timeoutMs: overrides.timeoutMs,
    headers: overrides.headers,
    onCompactionRejected: overrides.onCompactionRejected,
  };
  if (overrides.observations) {
    responsesPromptObserver.set(options, (observation) =>
      overrides.observations?.push(observation),
    );
  }
  const stream = await createOpenAIResponsesTransportStreamFn()(
    overrides.model ?? model,
    context,
    options as never,
  );
  return stream.result();
}

describe("native OpenAI Responses WebSocket client integration", () => {
  beforeEach(() => {
    cleanupSessionResources();
    transportState.handshakeMessages.length = 0;
    transportState.responseBatches.length = 0;
    transportState.sdkOutcomes.length = 0;
    transportState.sdkRequests.length = 0;
    transportState.websocketCloseCount = 0;
    transportState.websocketCloseReasons.length = 0;
    transportState.websocketClients.length = 0;
    transportState.websocketOptions.length = 0;
    transportState.websocketRequests.length = 0;
    let turn = 0;
    configureAiTransportHost({
      ...initialHost,
      plugin: {
        ...initialHost.plugin,
        resolveTransportTurnState: ({ context }) => {
          turn += 1;
          return {
            headers: {
              "x-openclaw-session-id": context.sessionId ?? "",
              "x-openclaw-turn-id": `turn-${turn}`,
              "x-openclaw-turn-attempt": "1",
            },
            metadata: {
              openclaw_session_id: context.sessionId ?? "",
              openclaw_turn_id: `turn-${turn}`,
              openclaw_turn_attempt: "1",
              openclaw_transport: context.transport,
            },
            websocket: {
              headers: {
                "x-client-request-id": context.sessionId ?? "",
                "x-openclaw-session-id": context.sessionId ?? "",
              },
              degradeCooldownMs: 1_000,
            },
          };
        },
      },
    });
  });

  afterEach(() => {
    cleanupSessionResources();
    configureAiTransportHost(initialHost);
  });

  it("continues past provider-only output metadata with one socket and only new input", async () => {
    transportState.responseBatches.push(
      [message(completedEvent("resp_1", "first answer"))],
      [message(completedEvent("resp_2", "second answer"))],
    );
    const firstUser = userMessage("first question", 1);
    const first = await run(
      { messages: [firstUser], tools: [] },
      { headers: { traceparent: "00-first-turn" } },
    );
    expect(first.stopReason).toBe("stop");
    expect(transportState.websocketCloseReasons).toEqual([]);

    const second = await run(
      {
        messages: [firstUser, first, userMessage("second question", 2)],
        tools: [],
      },
      { headers: { traceparent: "00-second-turn" } },
    );
    expect(second.stopReason).toBe("stop");

    expect(transportState.sdkRequests).toEqual([]);
    expect(transportState.websocketOptions).toHaveLength(1);
    expect(transportState.websocketOptions[0]?.headers).toMatchObject({
      "x-client-request-id": "session-1",
      "x-openclaw-session-id": "session-1",
    });
    expect(transportState.websocketOptions[0]?.headers).not.toHaveProperty("x-openclaw-turn-id");
    expect(transportState.websocketOptions[0]?.headers).not.toHaveProperty("traceparent");
    expect(transportState.websocketRequests).toHaveLength(2);
    expect(transportState.websocketRequests[1]).toMatchObject({
      previous_response_id: "resp_1",
    });
    expect(transportState.websocketRequests[1]?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "second question" }],
      },
    ]);
    expect(transportState.websocketRequests[0]).not.toHaveProperty("stream");
  });

  it("continues a tool loop without treating synthetic missing results as provider output", async () => {
    transportState.responseBatches.push(toolCallResponse("resp_tool"), [
      message(completedEvent("resp_answer", "done")),
    ]);
    const user = userMessage("read the file", 1);
    const toolCall = await run({ messages: [user], tools: [] });
    const block = toolCall.content.find((item) => item.type === "toolCall");
    if (!block || block.type !== "toolCall") {
      throw new Error("Expected a tool call");
    }

    const answer = await run({
      messages: [
        user,
        toolCall,
        {
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: "file contents" }],
          isError: false,
          timestamp: 2,
        },
      ],
      tools: [],
    });

    expect(answer.stopReason).toBe("stop");
    expect(transportState.websocketOptions).toHaveLength(1);
    expect(transportState.websocketRequests[1]).toMatchObject({
      previous_response_id: "resp_tool",
      input: [
        {
          type: "function_call_output",
          call_id: "call_read",
          output: "file contents",
        },
      ],
    });
  });

  it("falls back to SSE only when the WebSocket fails before dispatch", async () => {
    transportState.handshakeMessages.push({ type: "error", error: new Error("connect failed") });
    transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));

    const result = await run({ messages: [userMessage("hello", 1)], tools: [] });

    expect(result.stopReason).toBe("stop");
    expect(transportState.websocketRequests).toEqual([]);
    expect(transportState.sdkRequests).toHaveLength(1);
  });

  it("awaits the SSE response hook before start after a WebSocket fallback", async () => {
    transportState.handshakeMessages.push({ type: "error", error: new Error("connect failed") });
    transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));
    const order: string[] = [];
    let releaseHook!: () => void;
    const hookPending = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const onResponse = vi.fn(async () => {
      order.push("hook:start");
      await hookPending;
      order.push("hook:end");
    });
    const responseStream = await createOpenAIResponsesTransportStreamFn()(
      model,
      { messages: [userMessage("hello", 1)], tools: [] },
      {
        apiKey: "test-key",
        sessionId: "session-1",
        transport: "auto",
        onResponse,
      },
    );
    const consume = (async () => {
      for await (const event of responseStream) {
        order.push(event.type);
      }
    })();

    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
    expect(order).toEqual(["hook:start"]);

    releaseHook();
    await consume;
    expect((await responseStream.result()).stopReason).toBe("stop");
    expect(order.slice(0, 3)).toEqual(["hook:start", "hook:end", "start"]);
  });

  it("skips repeated WebSocket setup during the provider degradation cooldown", async () => {
    transportState.handshakeMessages.push({ type: "error", error: new Error("connect failed") });
    transportState.sdkOutcomes.push(sdkCompletion("resp_sse_1"), sdkCompletion("resp_sse_2"));

    const first = await run({ messages: [userMessage("first", 1)], tools: [] });
    const second = await run({ messages: [userMessage("second", 2)], tools: [] });

    expect(first.stopReason).toBe("stop");
    expect(second.stopReason).toBe("stop");
    expect(transportState.websocketOptions).toHaveLength(1);
    expect(transportState.websocketRequests).toEqual([]);
    expect(transportState.sdkRequests).toHaveLength(2);
  });

  it.each(["previous_response_not_found", "websocket_connection_limit_reached"])(
    "recovers a cached continuation rejected with %s over full-history SSE",
    async (code) => {
      transportState.responseBatches.push(
        [message(completedEvent("resp_1", "first answer"))],
        [
          {
            type: "error",
            error: wrappedSdkServerError({
              code,
              message: `safe rejection: ${code}`,
              param: code === "previous_response_not_found" ? "previous_response_id" : undefined,
              status: 400,
            }),
          },
        ],
        [message(completedEvent("resp_3", "third answer"))],
      );
      transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));
      const firstUser = userMessage("first question", 1);
      const first = await run({ messages: [firstUser], tools: [] });

      const secondUser = userMessage("second question", 2);
      const observations: ResponsesPromptObservation[] = [];
      const second = await run(
        { messages: [firstUser, first, secondUser], tools: [] },
        { observations },
      );

      expect(second.stopReason).toBe("stop");
      expect(transportState.websocketRequests[1]).toMatchObject({
        previous_response_id: "resp_1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "second question" }],
          },
        ],
      });
      expect(transportState.websocketCloseCount).toBe(1);
      expect(transportState.sdkRequests).toHaveLength(1);
      expect(transportState.sdkRequests[0]).not.toHaveProperty("previous_response_id");
      expect(transportState.sdkRequests[0]?.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
          expect.objectContaining({ role: "user" }),
        ]),
      );
      expect(
        observations.map(({ egress, payloadVariant }) => ({ egress, payloadVariant })),
      ).toEqual([
        { egress: "responses-websocket", payloadVariant: "initial" },
        { egress: "responses-sdk", payloadVariant: "continuation-rejected" },
      ]);

      const third = await run({
        messages: [firstUser, first, secondUser, second, userMessage("third question", 3)],
        tools: [],
      });
      expect(third.stopReason).toBe("stop");
      expect(transportState.websocketOptions).toHaveLength(2);
      expect(transportState.sdkRequests).toHaveLength(1);
    },
  );

  it("preserves the wrapped server error details and original SDK cause", async () => {
    const cause = wrappedSdkServerError({
      code: "previous_response_not_found",
      message: "previous response missing",
      param: "previous_response_id",
      status: 400,
    });
    transportState.responseBatches.push([{ type: "error", error: cause }]);
    const response = createOpenAIResponsesWebSocketStream({
      client: createOpenAIResponsesClient(model, { messages: [], tools: [] }, "test-key"),
      request: { model: model.id, input: [] },
      mode: "websocket",
    });

    let error: unknown;
    try {
      for await (const event of response.stream) {
        void event;
      }
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(OpenAIResponsesWebSocketSafeRetryError);
    expect(error).toMatchObject({
      code: "previous_response_not_found",
      message: "previous response missing",
      param: "previous_response_id",
      status: 400,
    });
    expect((error as Error).cause).toBe(cause);
    expect(transportState.websocketCloseCount).toBe(1);
  });

  it("recovers a rejected WebSocket compaction replay over full-history SSE", async () => {
    const onCompactionRejected = vi.fn();
    transportState.responseBatches.push(
      [
        message(
          completedEvent("resp_checkpoint", [
            {
              type: "compaction",
              id: "cmp_rejected",
              encrypted_content: "opaque-rejected-compaction",
            },
          ]),
        ),
      ],
      [
        {
          type: "error",
          error: wrappedSdkServerError({
            code: "invalid_encrypted_content",
            message: "compaction checkpoint could not be decrypted",
            param: "input[0].encrypted_content",
            status: 400,
          }),
        },
      ],
      [message(completedEvent("resp_next"))],
    );
    transportState.sdkOutcomes.push(sdkCompletion("resp_recovered"));
    const firstUser = userMessage("full history before compaction", 1);
    const checkpoint = await run({ messages: [firstUser], tools: [] }, { transport: "websocket" });
    expect(checkpoint.providerReplay).toMatchObject({ type: "openai-responses-compaction" });
    transportState.websocketRequests.length = 0;
    const observations: ResponsesPromptObservation[] = [];
    const context = {
      messages: [firstUser, checkpoint, userMessage("continue after compaction", 2)],
      tools: [],
    } satisfies Context;

    const result = await run(context, {
      observations,
      transport: "websocket",
      onCompactionRejected,
    });
    const next = await run(
      {
        ...context,
        messages: [...context.messages, result, userMessage("continue again", 3)],
      },
      { observations, transport: "websocket" },
    );

    expect(result).toMatchObject({
      stopReason: "stop",
      providerReplay: {
        type: "openai-responses-compaction-suppression",
        data: "rejected",
      },
    });
    expect(next.stopReason).toBe("stop");
    expect(onCompactionRejected).toHaveBeenCalledOnce();
    expect(transportState.websocketRequests).toHaveLength(2);
    expect(JSON.stringify(transportState.websocketRequests[0]?.input)).toContain(
      '"type":"compaction"',
    );
    expect(JSON.stringify(transportState.websocketRequests[0]?.input)).not.toContain(
      "full history before compaction",
    );
    expect(transportState.sdkRequests).toHaveLength(1);
    expect(JSON.stringify(transportState.sdkRequests[0]?.input)).not.toContain(
      '"type":"compaction"',
    );
    expect(JSON.stringify(transportState.sdkRequests[0]?.input)).toContain(
      "full history before compaction",
    );
    expect(JSON.stringify(transportState.websocketRequests[1]?.input)).not.toContain(
      '"type":"compaction"',
    );
    expect(observations.map(({ egress, payloadVariant }) => ({ egress, payloadVariant }))).toEqual([
      { egress: "responses-websocket", payloadVariant: "initial" },
      { egress: "responses-sdk", payloadVariant: "compaction-stripped" },
      { egress: "responses-websocket", payloadVariant: "initial" },
    ]);
  });

  it.each([
    [
      "invalid_websocket_request",
      "request may have been dispatched",
      PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
    ],
    [
      "invalid_encrypted_content",
      "encrypted reasoning was rejected without compaction",
      "invalid_encrypted_content",
    ],
    [
      "thinking_signature_invalid",
      "thinking signature was rejected without replayable reasoning",
      "thinking_signature_invalid",
    ],
  ])(
    "does not replay over SSE after a post-dispatch %s without compaction",
    async (code, text, expectedCode) => {
      transportState.responseBatches.push([
        {
          type: "error",
          error: wrappedSdkServerError({
            code,
            message: text,
            param: "input",
            status: 400,
          }),
        },
      ]);

      const result = await run({ messages: [userMessage("hello", 1)], tools: [] });

      expect(result.stopReason).toBe("error");
      expect(result.errorCode).toBe(expectedCode);
      expect(transportState.websocketRequests).toHaveLength(1);
      expect(transportState.sdkRequests).toEqual([]);
    },
  );

  it("applies the request timeout after dispatch without falling back", async () => {
    transportState.responseBatches.push([{ type: "delay", ms: 25 }]);

    const result = await run({ messages: [userMessage("hello", 1)], tools: [] }, { timeoutMs: 5 });

    expect(result.stopReason).toBe("error");
    expect(transportState.websocketRequests).toHaveLength(1);
    expect(transportState.sdkRequests).toEqual([]);
    expect(transportState.websocketCloseCount).toBe(1);

    transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));
    const next = await run({ messages: [userMessage("next", 2)], tools: [] });
    expect(next.stopReason).toBe("stop");
    expect(transportState.websocketOptions).toHaveLength(1);
    expect(transportState.sdkRequests).toHaveLength(1);
  });

  it("preserves failed terminal semantics across WebSocket and SSE without degradation", async () => {
    const failedEvent = {
      type: "response.failed",
      response: {
        id: "resp_failed",
        status: "failed",
        model: "gpt-5.6-luna-2026-08-01",
        service_tier: "priority",
        error: { code: "server_error", message: "503 temporary provider response" },
        output: [],
        usage: {
          input_tokens: 21,
          output_tokens: 4,
          total_tokens: 25,
          input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    };
    const pricedModel = {
      ...model,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    } satisfies Model<"openai-responses">;
    transportState.responseBatches.push(
      [message(failedEvent)],
      [message(completedEvent("resp_next"))],
    );
    transportState.sdkOutcomes.push(sdkEvent(failedEvent));

    const websocket = await run(
      { messages: [userMessage("websocket", 1)], tools: [] },
      { model: pricedModel },
    );
    const sse = await run(
      { messages: [userMessage("sse", 2)], tools: [] },
      { model: pricedModel, transport: "sse" },
    );

    const terminalFacts = {
      stopReason: "error",
      errorMessage: "server_error: 503 temporary provider response",
      responseId: "resp_failed",
      responseModel: "gpt-5.6-luna-2026-08-01",
      usage: {
        input: 13,
        output: 4,
        cacheRead: 6,
        cacheWrite: 2,
        reasoningTokens: 3,
        totalTokens: 25,
      },
    };
    expect(websocket).toMatchObject(terminalFacts);
    expect(sse).toMatchObject(terminalFacts);
    expect(websocket.usage.cost.total).toBeCloseTo(0.000401, 10);
    expect(sse.usage.cost.total).toBeCloseTo(0.000401, 10);
    expect(isRetryableAssistantError(websocket)).toBe(true);
    expect(isRetryableAssistantError(sse)).toBe(true);

    const next = await run(
      { messages: [userMessage("next", 3)], tools: [] },
      { model: pricedModel },
    );
    expect(next.stopReason).toBe("stop");
    expect(transportState.websocketOptions).toHaveLength(2);
    expect(transportState.websocketRequests[1]).not.toHaveProperty("previous_response_id");
    expect(transportState.sdkRequests).toHaveLength(1);
  });

  it("keeps a true post-dispatch connection loss replay-unsafe", async () => {
    transportState.responseBatches.push([{ type: "close", code: 1006 }]);

    const result = await run({ messages: [userMessage("hello", 1)], tools: [] });

    expect(result).toMatchObject({
      stopReason: "error",
      errorCode: PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
    });
    expect(isRetryableAssistantError(result)).toBe(false);
    expect(transportState.websocketRequests).toHaveLength(1);
    expect(transportState.sdkRequests).toEqual([]);
  });

  it("keeps custom OpenAI-compatible endpoints on guarded SSE", async () => {
    transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));
    const compatibleModel = { ...model, baseUrl: "https://compatible.example/v1" };

    const result = await run(
      { messages: [userMessage("hello", 1)], tools: [] },
      { model: compatibleModel },
    );

    expect(result.stopReason).toBe("stop");
    expect(transportState.websocketClients).toEqual([]);
    expect(transportState.sdkRequests).toHaveLength(1);
  });

  it("keeps host-managed proxy and TLS models on guarded SSE", async () => {
    configureAiTransportHost({
      ...getAiTransportHost(),
      requiresManagedTransport: () => true,
    });
    transportState.sdkOutcomes.push(sdkCompletion("resp_sse"));

    const result = await run({ messages: [userMessage("hello", 1)], tools: [] });

    expect(result.stopReason).toBe("stop");
    expect(transportState.websocketClients).toEqual([]);
    expect(transportState.sdkRequests).toHaveLength(1);
  });
});
