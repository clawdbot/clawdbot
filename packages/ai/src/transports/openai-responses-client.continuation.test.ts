import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

const sseState = vi.hoisted(() => ({
  clientHeaders: [] as Array<Record<string, string>>,
  outcomes: [] as Array<Error | SdkResponse>,
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    apiKey: string;
    baseURL: string;
    responses = {
      create: (request: Record<string, unknown>) => {
        sseState.requests.push(request);
        const outcome = sseState.outcomes.shift() ?? new Error("Unexpected SSE request");
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

    constructor(options: {
      apiKey?: string;
      baseURL?: string;
      defaultHeaders?: Record<string, string>;
    }) {
      this.apiKey = options.apiKey ?? "";
      this.baseURL = options.baseURL ?? "https://api.openai.com/v1";
      sseState.clientHeaders.push(options.defaultHeaders ?? {});
    }
  }

  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: function UnexpectedResponsesWS() {
    throw new Error("SSE continuation tests must not construct a WebSocket");
  },
}));

import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

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

function completedEvent(responseId: string, content: string) {
  const output = [
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
  ];
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

function sdkCompletion(responseId: string, content: string): SdkResponse {
  return sdkEvents(completedEvent(responseId, content));
}

function sdkEvents(...events: Array<Record<string, unknown>>): SdkResponse {
  return {
    data: (async function* () {
      yield* events;
    })(),
    response: new Response(null, { status: 200 }),
  };
}

async function run(
  context: Context,
  options: {
    sessionId?: string;
    onPayload: (payload: Record<string, unknown>) => Record<string, unknown>;
    signal?: AbortSignal;
  },
): Promise<AssistantMessage> {
  const stream = await createOpenAIResponsesTransportStreamFn()(model, context, {
    apiKey: "test-key",
    sessionId: options.sessionId ?? "session-1",
    transport: "sse",
    reasoningEffort: "low",
    onPayload: options.onPayload,
    signal: options.signal,
  } as never);
  return stream.result();
}

describe("native OpenAI Responses SSE continuation", () => {
  beforeEach(() => {
    cleanupSessionResources();
    sseState.clientHeaders.length = 0;
    sseState.outcomes.length = 0;
    sseState.requests.length = 0;
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
          };
        },
      },
    });
  });

  afterEach(() => {
    cleanupSessionResources();
    configureAiTransportHost(initialHost);
  });

  it("continues stateful literal SSE turns with only appended input", async () => {
    sseState.outcomes.push(
      sdkCompletion("resp_1", "first answer"),
      sdkCompletion("resp_2", "second answer"),
    );
    const firstUser = userMessage("first question", 1);
    const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: true });
    const first = await run({ messages: [firstUser], tools: [] }, { onPayload });
    const second = await run(
      { messages: [firstUser, first, userMessage("second question", 2)], tools: [] },
      { onPayload },
    );

    expect(second.stopReason).toBe("stop");
    expect(sseState.clientHeaders).toMatchObject([
      { "x-openclaw-turn-id": "turn-1" },
      { "x-openclaw-turn-id": "turn-2" },
    ]);
    expect(sseState.requests[1]).toMatchObject({
      previous_response_id: "resp_1",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "second question" }],
        },
      ],
    });
  });

  it("keeps final store:false turns stateless and sends full history", async () => {
    sseState.outcomes.push(
      sdkCompletion("resp_1", "first answer"),
      sdkCompletion("resp_2", "second answer"),
    );
    const firstUser = userMessage("first question", 1);
    const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: false });
    const first = await run({ messages: [firstUser], tools: [] }, { onPayload });
    await run(
      { messages: [firstUser, first, userMessage("second question", 2)], tools: [] },
      { onPayload },
    );

    expect(sseState.requests[1]).not.toHaveProperty("previous_response_id");
    expect(sseState.requests[1]?.input).toHaveLength(3);
  });

  it("recovers a rejected continuation with full history and advances the baseline", async () => {
    sseState.outcomes.push(
      sdkCompletion("resp_1", "first answer"),
      Object.assign(new Error("previous response not found"), {
        code: "previous_response_not_found",
        status: 400,
      }),
      sdkCompletion("resp_2", "second answer"),
      sdkCompletion("resp_3", "third answer"),
    );
    const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: true });
    const firstUser = userMessage("first question", 1);
    const first = await run({ messages: [firstUser], tools: [] }, { onPayload });
    const secondContext = {
      messages: [firstUser, first, userMessage("second question", 2)],
      tools: [],
    };
    const second = await run(secondContext, { onPayload });
    await run(
      {
        messages: [...secondContext.messages, second, userMessage("third question", 3)],
        tools: [],
      },
      { onPayload },
    );

    expect(sseState.requests[1]).toMatchObject({ previous_response_id: "resp_1" });
    expect(sseState.requests[1]?.input).toHaveLength(1);
    expect(sseState.requests[2]).not.toHaveProperty("previous_response_id");
    expect(sseState.requests[2]?.input).toHaveLength(3);
    expect(sseState.requests[3]).toMatchObject({ previous_response_id: "resp_2" });
    expect(sseState.requests[3]?.input).toHaveLength(1);
  });

  it("records the effective full-history compaction recovery request", async () => {
    sseState.outcomes.push(
      sdkCompletion("resp_1", "first answer"),
      Object.assign(new Error("invalid encrypted content"), {
        code: "invalid_encrypted_content",
      }),
      sdkCompletion("resp_2", "second answer"),
      sdkCompletion("resp_3", "third answer"),
    );
    const stateful = (payload: Record<string, unknown>) => ({ ...payload, store: true });
    const withCompaction = (payload: Record<string, unknown>) => ({
      ...payload,
      store: true,
      input: [
        ...((payload.input as unknown[]) ?? []),
        { type: "compaction", encrypted_content: "opaque" },
      ],
    });
    const firstUser = userMessage("first question", 1);
    const first = await run({ messages: [firstUser], tools: [] }, { onPayload: stateful });
    const secondContext = {
      messages: [firstUser, first, userMessage("second question", 2)],
      tools: [],
    };
    const second = await run(secondContext, { onPayload: withCompaction });
    await run(
      {
        messages: [...secondContext.messages, second, userMessage("third question", 3)],
        tools: [],
      },
      { onPayload: stateful },
    );

    expect(sseState.requests[1]).toMatchObject({ previous_response_id: "resp_1" });
    expect(JSON.stringify(sseState.requests[1]?.input)).toContain('"compaction"');
    expect(sseState.requests[2]).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(sseState.requests[2]?.input)).not.toContain('"compaction"');
    expect(sseState.requests[3]).toMatchObject({ previous_response_id: "resp_2" });
  });

  it.each([
    "request failure",
    "continuation error without previous_response_id",
    "incomplete response",
    "post-dispatch stream rejection",
    "abort",
  ])("does not commit after %s", async (failure) => {
    const controller = new AbortController();
    if (failure === "request failure") {
      sseState.outcomes.push(new Error("request failed"));
    } else if (failure === "continuation error without previous_response_id") {
      sseState.outcomes.push(
        Object.assign(new Error("previous response not found"), {
          code: "previous_response_not_found",
          status: 400,
        }),
      );
    } else if (failure === "incomplete response") {
      sseState.outcomes.push(
        sdkEvents({
          type: "response.incomplete",
          response: { id: "resp_incomplete", status: "incomplete", output: [] },
        }),
      );
    } else if (failure === "post-dispatch stream rejection") {
      sseState.outcomes.push(
        sdkEvents({
          type: "error",
          code: "previous_response_not_found",
          message: "previous response not found after stream acceptance",
        }),
      );
    } else {
      sseState.outcomes.push({
        data: (async function* () {
          controller.abort();
          yield completedEvent("resp_aborted", "ignored");
        })(),
        response: new Response(null, { status: 200 }),
      });
    }
    sseState.outcomes.push(sdkCompletion("resp_next", "next answer"));
    const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: true });
    const sessionId = `session-${failure}`;
    await run(
      { messages: [userMessage("first", 1)], tools: [] },
      {
        onPayload,
        sessionId,
        signal: failure === "abort" ? controller.signal : undefined,
      },
    );
    await run({ messages: [userMessage("next", 2)], tools: [] }, { onPayload, sessionId });

    expect(sseState.requests[1]).not.toHaveProperty("previous_response_id");
  });
});
