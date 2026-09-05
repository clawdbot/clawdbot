import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../../test/helpers/promise.js";
import { Agent } from "../../../agent-core/src/agent.js";

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
const astra = { ...model, id: "gpt-6-astra", name: "GPT-6 Astra" };

function functionTool(name: string) {
  return { name, description: name, parameters: Type.Object({}) };
}

const asyncCall = {
  type: "function_call",
  id: "fc_lookup",
  call_id: "call_lookup",
  name: "lookup",
  arguments: "{}",
  status: "completed",
  async: true,
};

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
    reasoningEffort?: "low" | "medium" | "high";
    asyncToolExecution?: boolean;
    openclawCodeModeToolSurface?: boolean;
  },
  requestModel: Model = model,
): Promise<AssistantMessage> {
  const stream = await createOpenAIResponsesTransportStreamFn()(requestModel, context, {
    apiKey: "test-key",
    sessionId: options.sessionId ?? "session-1",
    transport: "sse",
    reasoningEffort: options.reasoningEffort ?? "low",
    asyncToolExecution: options.asyncToolExecution,
    openclawCodeModeToolSurface: options.openclawCodeModeToolSurface,
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

  it("preserves Astra effort updates on the wire across unstored SSE turns", async () => {
    sseState.outcomes.push(
      sdkCompletion("resp_1", "first answer"),
      sdkCompletion("resp_2", "second answer"),
      sdkCompletion("resp_3", "third answer"),
    );
    const onPayload = (payload: Record<string, unknown>) => ({ ...payload, store: false });
    const messages: Context["messages"] = [userMessage("first question", 1)];
    const first = await run({ messages }, { onPayload }, astra);
    messages.push(first, userMessage("second question", 2));
    const second = await run({ messages }, { onPayload, reasoningEffort: "high" }, astra);
    messages.push(second, userMessage("third question", 3));
    const third = await run({ messages }, { onPayload, reasoningEffort: "high" }, astra);

    expect([first.stopReason, second.stopReason, third.stopReason]).toEqual([
      "stop",
      "stop",
      "stop",
    ]);
    const configuration = { type: "configuration_update", reasoning: { effort: "high" } };
    expect(sseState.requests).toEqual([
      expect.objectContaining({ store: false, reasoning: { effort: "low", summary: "auto" } }),
      expect.objectContaining({
        store: false,
        reasoning: { effort: "low", summary: "auto" },
        input: [expect.anything(), expect.anything(), configuration, expect.anything()],
      }),
      expect.objectContaining({
        store: false,
        reasoning: { effort: "low", summary: "auto" },
        input: [
          expect.anything(),
          expect.anything(),
          configuration,
          expect.anything(),
          expect.anything(),
          expect.anything(),
        ],
      }),
    ]);
    expect(sseState.requests.every((request) => !request.previous_response_id)).toBe(true);
  });

  it("executes an Astra tool before SSE completes and returns its result once", async () => {
    const toolStarted = createDeferred();
    const releaseTool = createDeferred();
    const responseCompleted = createDeferred();
    const execute = vi.fn(async () => {
      toolStarted.resolve();
      await releaseTool.promise;
      return { content: [{ type: "text" as const, text: "lookup result" }], details: {} };
    });
    sseState.outcomes.push(
      {
        response: new Response(null, { status: 200 }),
        data: (async function* () {
          yield {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...asyncCall, arguments: "" },
          };
          yield { type: "response.output_item.done", output_index: 0, item: asyncCall };
          await withTestTimeout(toolStarted.promise, 5000, "Async tool did not start during SSE");
          const completed = completedEvent("resp_async", "independent answer");
          yield {
            type: "response.output_item.done",
            output_index: 1,
            item: completed.response.output[0],
          };
          responseCompleted.resolve();
          yield {
            ...completed,
            response: { ...completed.response, output: [asyncCall, ...completed.response.output] },
          };
        })(),
      },
      sdkCompletion("resp_final", "used lookup result"),
    );
    const agent = new Agent({
      initialState: {
        model: astra,
        thinkingLevel: "low",
        tools: [{ ...functionTool("lookup"), label: "lookup", execute }],
      },
      streamFn: createOpenAIResponsesTransportStreamFn(),
      getApiKey: () => "test-key",
      sessionId: "async-agent",
      transport: "sse",
    });
    const prompt = agent.prompt("Start a lookup and explain something independent.");
    try {
      await withTestTimeout(
        responseCompleted.promise,
        5000,
        "SSE did not continue while the tool ran",
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(sseState.requests).toHaveLength(1);
      expect(sseState.requests[0]?.tools).toEqual([
        expect.objectContaining({ name: "lookup", async: true }),
      ]);
      releaseTool.resolve();
      await prompt;
      expect(sseState.requests).toHaveLength(2);
      expect(execute).toHaveBeenCalledTimes(1);
      const replay = sseState.requests[1]?.input as Array<{
        type: string;
        call_id?: string;
        output?: string;
      }>;
      expect(replay.filter((item) => item.type === "function_call_output")).toEqual([
        { type: "function_call_output", call_id: "call_lookup", output: "lookup result" },
      ]);
      expect(agent.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
        content: [expect.objectContaining({ text: "used lookup result" })],
      });
    } finally {
      releaseTool.resolve();
      agent.abort();
      await prompt;
    }
  });

  it.each([
    { name: "direct Astra", requestModel: astra, enabled: true, expected: true },
    { name: "ordinary model", requestModel: model, enabled: true, expected: false },
    { name: "missing executor capability", requestModel: astra, enabled: false, expected: false },
    { name: "code mode", requestModel: astra, enabled: true, codeMode: true, expected: false },
    {
      name: "API multi-agent",
      requestModel: astra,
      enabled: true,
      multiAgent: true,
      expected: false,
    },
    {
      name: "custom endpoint",
      requestModel: { ...astra, baseUrl: "https://example.test/v1" },
      enabled: true,
      expected: false,
    },
  ])(
    "gates async advertisement and normalized calls for $name",
    async ({ requestModel, enabled, codeMode, multiAgent, expected }) => {
      const completed = completedEvent("resp_call", "");
      sseState.outcomes.push(
        sdkEvents(
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...asyncCall, arguments: "" },
          },
          { type: "response.output_item.done", output_index: 0, item: asyncCall },
          { ...completed, response: { ...completed.response, output: [asyncCall] } },
        ),
      );
      const result = await run(
        { messages: [userMessage("call", 1)], tools: [functionTool("exec"), functionTool("wait")] },
        {
          asyncToolExecution: enabled,
          openclawCodeModeToolSurface: codeMode,
          onPayload: (payload) => ({
            ...payload,
            ...(multiAgent ? { multi_agent: { enabled: true } } : {}),
          }),
        },
        requestModel,
      );
      expect(result.stopReason).toBe("toolUse");
      const tools = sseState.requests[0]?.tools as Array<{ async?: boolean }>;
      expect(tools.every((tool) => tool.async === (expected ? true : undefined))).toBe(true);
      expect(result.content.find((item) => item.type === "toolCall")?.async).toBe(
        expected ? true : undefined,
      );
    },
  );

  it("keeps async tools on full-history encrypted-content recovery", async () => {
    sseState.outcomes.push(
      Object.assign(new Error("invalid encrypted content"), { code: "invalid_encrypted_content" }),
      sdkCompletion("resp_retry", "recovered"),
    );
    const result = await run(
      { messages: [userMessage("recover", 1)], tools: [functionTool("lookup")] },
      {
        asyncToolExecution: true,
        onPayload: (payload) => ({
          ...payload,
          input: [
            ...(payload.input as unknown[]),
            { type: "compaction", encrypted_content: "opaque" },
          ],
        }),
      },
      astra,
    );
    expect(result.stopReason).toBe("stop");
    expect(sseState.requests).toHaveLength(2);
    expect(sseState.requests.map((request) => request.tools)).toEqual([
      [expect.objectContaining({ name: "lookup", async: true })],
      [expect.objectContaining({ name: "lookup", async: true })],
    ]);
    expect(JSON.stringify(sseState.requests[1]?.input)).not.toContain('"compaction"');
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
