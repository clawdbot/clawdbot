import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import OpenAI from "openai";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { buildOpenAICompletionsParams } from "./openai-transport-stream.js";
import {
  buildOpenAIResponsesParams,
  makeCompletionsModel,
  makeResponsesModel,
  streamChunks,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

type ReplayContextSpec = {
  source?: Pick<Model, "api" | "id" | "provider">;
  api?: string;
  provider?: string;
  model?: string;
  stopReason?: "stop" | "toolUse";
  thinking?: {
    signature: string | Record<string, unknown>;
    replayMetadata?: unknown;
    text?: string;
  };
  text?: true | { id: string; phase: "commentary" | "final_answer"; text: string };
  toolCalls?: ReadonlyArray<{ id: string; name: string; arguments: unknown }>;
  results?: ReadonlyArray<{
    id: string;
    name: string;
    content: readonly unknown[];
    timestamp?: number;
  }>;
  before?: readonly unknown[];
  after?: readonly unknown[];
};

function replayContext(spec: ReplayContextSpec) {
  const content: Array<Record<string, unknown>> = [];
  if (spec.thinking) {
    content.push({
      type: "thinking",
      thinking: spec.thinking.text ?? "Need a tool.",
      thinkingSignature:
        typeof spec.thinking.signature === "string"
          ? spec.thinking.signature
          : JSON.stringify(spec.thinking.signature),
      ...(spec.thinking.replayMetadata === undefined
        ? {}
        : { openclawReasoningReplay: spec.thinking.replayMetadata }),
    });
  }
  if (spec.text) {
    const text =
      spec.text === true
        ? { id: "msg_prior", phase: "commentary" as const, text: "Checking the price." }
        : spec.text;
    content.push({
      type: "text",
      text: text.text,
      textSignature: JSON.stringify({ v: 1, id: text.id, phase: text.phase }),
    });
  }
  for (const toolCall of spec.toolCalls ?? []) {
    content.push({ type: "toolCall", ...toolCall });
  }
  const messages = [
    ...(spec.before ?? []),
    {
      role: "assistant",
      api: spec.source?.api ?? spec.api ?? "openai-responses",
      provider: spec.source?.provider ?? spec.provider ?? "openai",
      model: spec.source?.id ?? spec.model ?? "gpt-5.5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: spec.stopReason ?? "toolUse",
      timestamp: 1,
      content,
    },
    ...(spec.results ?? []).map(({ id, name, content: resultContent, timestamp = 2 }) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: resultContent,
      isError: false,
      timestamp,
    })),
    ...(spec.after ?? []),
  ];
  return { systemPrompt: "system", messages, tools: [] } as never;
}

function responsesModelFixture(id: string, name: string) {
  return makeResponsesModel({ id, name });
}

function emptyResponsesContext() {
  return { systemPrompt: "system", messages: [], tools: [] } as never;
}

describe("openai transport stream", () => {
  it("omits Responses replay item ids when OpenAI Responses requests disable store", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "mycodex",
        baseUrl: "http://127.0.0.1:8317/v1",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      }),
      replayContext({
        provider: "mycodex",
        thinking: {
          signature: { type: "reasoning", id: "rs_prior", encrypted_content: "ciphertext" },
        },
        text: true,
        toolCalls: [
          { id: "call_abc|fc_prior", name: "price_lookup", arguments: { symbol: "SOL" } },
        ],
        results: [
          {
            id: "call_abc|fc_prior",
            name: "price_lookup",
            content: [{ type: "text", text: "$83.95" }],
          },
        ],
      }),
      { sessionId: "session-123" },
    ) as {
      store?: boolean;
      input?: Array<{
        type?: string;
        role?: string;
        id?: string;
        call_id?: string;
        phase?: string;
        status?: string;
        encrypted_content?: string;
        summary?: unknown;
      }>;
    };

    expect(params.store).toBe(false);
    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
    expect(reasoningItem).not.toHaveProperty("encrypted_content");
    const assistantMessage = params.input?.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expectRecordFields(assistantMessage, {
      type: "message",
      role: "assistant",
      phase: "commentary",
    });
    expect(assistantMessage?.id).toBeUndefined();
    expect(assistantMessage?.status).toBeUndefined();
    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall?.id).toBeUndefined();
  });

  it("preserves Responses replay item ids when a store-enabled wrapper requests replay", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4", "GPT-5.4"),
      replayContext({
        model: "gpt-5.4",
        thinking: {
          signature: { type: "reasoning", id: "rs_prior", encrypted_content: "ciphertext" },
        },
        text: true,
        toolCalls: [
          { id: "call_abc|fc_prior", name: "price_lookup", arguments: { symbol: "SOL" } },
        ],
        results: [
          {
            id: "call_abc|fc_prior",
            name: "price_lookup",
            content: [{ type: "text", text: "$83.95" }],
          },
        ],
      }),
      { replayResponsesItemIds: true, sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        role?: string;
        id?: string;
        call_id?: string;
        phase?: string;
        status?: string;
        encrypted_content?: string;
        summary?: unknown;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      id: "rs_prior",
      summary: [],
    });
    const assistantMessage = params.input?.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expectRecordFields(assistantMessage, {
      type: "message",
      role: "assistant",
      id: "msg_prior",
      phase: "commentary",
      status: "completed",
    });
    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      id: "fc_prior",
      call_id: "call_abc",
    });
  });

  it("preserves Responses replay item ids for store-capable third-party opt-in routes", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "store-capable-model",
        name: "Store-capable model",
        provider: "custom-openai-responses",
        baseUrl: "https://custom.example.com/v1",
        compat: { supportsStore: true } as never,
      }),
      replayContext({
        provider: "custom-openai-responses",
        model: "store-capable-model",
        thinking: { signature: { type: "reasoning", id: "rs_prior", summary: [] } },
        text: true,
        toolCalls: [
          { id: "call_abc|fc_prior", name: "price_lookup", arguments: { symbol: "SOL" } },
        ],
      }),
      { replayResponsesItemIds: true, sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        role?: string;
        id?: string;
        call_id?: string;
        phase?: string;
        summary?: unknown;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      id: "rs_prior",
      summary: [],
    });
    const assistantMessage = params.input?.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expectRecordFields(assistantMessage, {
      type: "message",
      role: "assistant",
      id: "msg_prior",
      phase: "commentary",
    });
    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      id: "fc_prior",
      call_id: "call_abc",
    });
  });

  it("omits prior Responses replay item ids when store is disabled for custom Codex-compatible responses", () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://proxy.example.com/v1",
    });

    const params = buildOpenAIResponsesParams(
      model,
      replayContext({
        source: model,
        thinking: {
          signature: { type: "reasoning", id: "rs_prior", encrypted_content: "ciphertext" },
          replayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
            authProfileId: "openai:oauth",
            sessionId: "session-123",
          }),
        },
        text: true,
        toolCalls: [
          { id: "call_abc|fc_prior", name: "price_lookup", arguments: { symbol: "SOL" } },
        ],
      }),
      { authProfileId: "openai:oauth", sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        role?: string;
        id?: string;
        call_id?: string;
        phase?: string;
        encrypted_content?: string;
        summary?: unknown;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
    expect(reasoningItem).not.toHaveProperty("__openclaw_replay");
    const assistantMessage = params.input?.find(
      (item) => item.type === "message" && item.role === "assistant",
    );
    expectRecordFields(assistantMessage, {
      type: "message",
      role: "assistant",
      phase: "commentary",
    });
    expect(assistantMessage?.id).toBeUndefined();
    const functionCall = params.input?.find((item) => item.type === "function_call");
    expectRecordFields(functionCall, {
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall?.id).toBeUndefined();
  });

  it("keeps GitHub Copilot Responses reasoning replay when store-disabled ids are omitted", () => {
    const model = makeResponsesModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.com",
      contextWindow: 400000,
    });
    const longReasoningId = `rs_${"x".repeat(380)}`;

    const params = buildOpenAIResponsesParams(
      model,
      replayContext({
        source: model,
        thinking: { signature: { type: "reasoning", id: longReasoningId, summary: [] } },
      }),
      { sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        id?: string;
        summary?: unknown;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
  });

  it("drops oversized GitHub Copilot Responses reasoning replay ids before send", () => {
    const model = makeResponsesModel({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.com",
      contextWindow: 400000,
    });
    const longReasoningId = `rs_${"x".repeat(380)}`;

    const params = buildOpenAIResponsesParams(
      model,
      replayContext({
        source: model,
        thinking: { signature: { type: "reasoning", id: longReasoningId, summary: [] } },
      }),
      { replayResponsesItemIds: true, sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        id?: string;
      }>;
    };

    expect(params.input?.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("strips encrypted reasoning replay when provenance does not match", () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://proxy.example.com/v1",
    });

    const params = buildOpenAIResponsesParams(
      model,
      replayContext({
        source: model,
        thinking: {
          signature: { type: "reasoning", id: "rs_prior", encrypted_content: "ciphertext" },
          replayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
            authProfileId: "openai:oauth",
            sessionId: "different-session",
          }),
        },
      }),
      { authProfileId: "openai:oauth", sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        id?: string;
        encrypted_content?: string;
        summary?: unknown;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
    expect(reasoningItem).not.toHaveProperty("encrypted_content");
  });

  it("strips encrypted reasoning replay when the auth profile provenance changes", () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://proxy.example.com/v1",
    });

    const params = buildOpenAIResponsesParams(
      model,
      replayContext({
        source: model,
        thinking: {
          signature: { type: "reasoning", id: "rs_prior", encrypted_content: "ciphertext" },
          replayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
            authProfileId: "openai:old-oauth",
            sessionId: "session-123",
          }),
        },
      }),
      { authProfileId: "openai:new-oauth", sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        id?: string;
        encrypted_content?: string;
        summary?: unknown;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
    expect(reasoningItem).not.toHaveProperty("encrypted_content");
  });

  it("keeps embedded replay provenance as a compatibility fallback", () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://proxy.example.com/v1",
    });

    const params = buildOpenAIResponsesParams(
      model,
      replayContext({
        source: model,
        thinking: {
          signature: {
            type: "reasoning",
            id: "rs_prior",
            encrypted_content: "ciphertext",
            __openclaw_replay: testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
              authProfileId: "openai:oauth",
              sessionId: "session-123",
            }),
          },
        },
      }),
      { authProfileId: "openai:oauth", sessionId: "session-123" },
    ) as {
      input?: Array<{
        type?: string;
        id?: string;
        encrypted_content?: string;
        summary?: unknown;
      }>;
    };

    const reasoningItem = params.input?.find((item) => item.type === "reasoning");
    expectRecordFields(reasoningItem, {
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    });
    expect(reasoningItem?.id).toBeUndefined();
    expect(reasoningItem).not.toHaveProperty("__openclaw_replay");
  });

  it("retries mixed replay without reasoning first and preserves compaction on success", async () => {
    const request = {
      model: "gpt-5.5",
      stream: true,
      input: [
        {
          type: "reasoning",
          id: "rs_prior",
          encrypted_content: "ciphertext",
          summary: [{ type: "summary_text", text: "checked" }],
          nested: { encrypted_content: "nested-ciphertext", keep: "value" },
        },
        {
          type: "compaction",
          id: "cmp_prior",
          encrypted_content: "compaction-ciphertext",
        },
        {
          type: "function_call",
          id: "fc_prior",
          call_id: "call_abc",
          name: "price_lookup",
          arguments: "{}",
        },
      ],
    };
    const recoveredStream = streamChunks([]);
    const recoveredResponse = new Response(null, { status: 200 });
    const create = vi
      .fn()
      .mockReturnValueOnce({
        withResponse: vi.fn().mockRejectedValue(
          Object.assign(new Error("invalid reasoning"), {
            code: "invalid_encrypted_content",
          }),
        ),
      })
      .mockReturnValueOnce({
        withResponse: vi.fn().mockResolvedValue({
          data: recoveredStream,
          response: recoveredResponse,
        }),
      });
    const onCompactionRejected = vi.fn();

    await expect(
      testing.createResponsesStreamWithEncryptedContentRetry({
        client: { responses: { create } } as never,
        request: request as never,
        requestOptions: undefined,
        model: makeResponsesModel({ id: "gpt-5.5", name: "GPT-5.5" }),
        onCompactionRejected,
      }),
    ).resolves.toMatchObject({
      stream: recoveredStream,
      response: recoveredResponse,
      attempt: { kind: "reasoning-stripped" },
    });

    expect(create).toHaveBeenCalledTimes(2);
    const retry = create.mock.calls[1]?.[0] as typeof request;
    expect(retry.input[0]).toMatchObject({
      type: "reasoning",
      id: "rs_prior",
      summary: [{ type: "summary_text", text: "checked" }],
      nested: { keep: "value" },
    });
    expect(retry.input[0]).not.toHaveProperty("encrypted_content");
    expect(retry.input[0]?.nested).not.toHaveProperty("encrypted_content");
    expect(retry.input[1]).toEqual(request.input[1]);
    expect(onCompactionRejected).not.toHaveBeenCalled();
  });

  it("removes compaction only after a compaction-preserving retry rejects it", async () => {
    const request = {
      model: "gpt-5.5",
      stream: true,
      input: [
        { type: "reasoning", encrypted_content: "reasoning-ciphertext", summary: [] },
        { type: "compaction", id: "cmp_prior", encrypted_content: "compaction-ciphertext" },
      ],
    };
    const invalidEncryptedContent = () =>
      Object.assign(new Error("invalid encrypted content"), {
        code: "invalid_encrypted_content",
      });
    const recoveredStream = streamChunks([]);
    const recoveredResponse = new Response(null, { status: 200 });
    const create = vi
      .fn()
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(invalidEncryptedContent()) })
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(invalidEncryptedContent()) })
      .mockReturnValueOnce({
        withResponse: vi.fn().mockResolvedValue({
          data: recoveredStream,
          response: recoveredResponse,
        }),
      });
    const onCompactionRejected = vi.fn();

    await expect(
      testing.createResponsesStreamWithEncryptedContentRetry({
        client: { responses: { create } } as never,
        request: request as never,
        requestOptions: undefined,
        model: makeResponsesModel({ id: "gpt-5.5", name: "GPT-5.5" }),
        onCompactionRejected,
      }),
    ).resolves.toMatchObject({
      stream: recoveredStream,
      response: recoveredResponse,
      attempt: { kind: "compaction-stripped" },
    });

    expect(create).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(create.mock.calls[1]?.[0])).not.toContain("reasoning-ciphertext");
    expect(JSON.stringify(create.mock.calls[1]?.[0])).toContain("compaction-ciphertext");
    expect(JSON.stringify(create.mock.calls[2]?.[0])).not.toContain("compaction-ciphertext");
    expect(onCompactionRejected).toHaveBeenCalledOnce();
  });

  it("does not tombstone compaction when the final recovery attempt fails", async () => {
    const invalidEncryptedContent = Object.assign(new Error("invalid encrypted content"), {
      code: "invalid_encrypted_content",
    });
    const finalFailure = new Error("final recovery failed");
    const create = vi
      .fn()
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(invalidEncryptedContent) })
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(invalidEncryptedContent) })
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(finalFailure) });
    const onCompactionRejected = vi.fn();

    await expect(
      testing.createResponsesStreamWithEncryptedContentRetry({
        client: { responses: { create } } as never,
        request: {
          model: "gpt-5.5",
          stream: true,
          input: [
            { type: "reasoning", encrypted_content: "reasoning", summary: [] },
            { type: "compaction", encrypted_content: "compaction" },
          ],
        } as never,
        requestOptions: undefined,
        model: makeResponsesModel({ id: "gpt-5.5", name: "GPT-5.5" }),
        onCompactionRejected,
      }),
    ).rejects.toBe(finalFailure);
    expect(onCompactionRejected).not.toHaveBeenCalled();
  });

  it("does not advance past an unrelated error from the reasoning-free attempt", async () => {
    const invalidEncryptedContent = Object.assign(new Error("invalid encrypted content"), {
      code: "invalid_encrypted_content",
    });
    const unrelatedFailure = new OpenAI.RateLimitError(
      429,
      { code: "rate_limit_exceeded", message: "rate limited", type: "rate_limit_error" },
      undefined,
      new Headers(),
    );
    const create = vi
      .fn()
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(invalidEncryptedContent) })
      .mockReturnValueOnce({ withResponse: vi.fn().mockRejectedValue(unrelatedFailure) });
    const onCompactionRejected = vi.fn();

    await expect(
      testing.createResponsesStreamWithEncryptedContentRetry({
        client: { responses: { create } } as never,
        request: {
          model: "gpt-5.5",
          stream: true,
          input: [
            { type: "reasoning", encrypted_content: "reasoning", summary: [] },
            { type: "compaction", encrypted_content: "compaction" },
          ],
        } as never,
        requestOptions: undefined,
        model: makeResponsesModel({ id: "gpt-5.5", name: "GPT-5.5" }),
        onCompactionRejected,
      }),
    ).rejects.toBe(unrelatedFailure);
    expect(create).toHaveBeenCalledTimes(2);
    expect(onCompactionRejected).not.toHaveBeenCalled();
  });

  it("does not retry encrypted-content failures emitted after stream creation", async () => {
    const streamFailure = Object.assign(new Error("stream rejected encrypted content"), {
      code: "invalid_encrypted_content",
    });
    const responseStream = (async function* () {
      yield { type: "response.created", response: { id: "resp_stream" } };
      throw streamFailure;
    })();
    const create = vi.fn().mockReturnValue({
      withResponse: vi.fn().mockResolvedValue({
        data: responseStream,
        response: new Response(null, { status: 200 }),
      }),
    });
    const result = await testing.createResponsesStreamWithEncryptedContentRetry({
      client: { responses: { create } } as never,
      request: {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "reasoning", encrypted_content: "reasoning", summary: [] }],
      } as never,
      requestOptions: undefined,
      model: makeResponsesModel({ id: "gpt-5.5", name: "GPT-5.5" }),
    });

    await expect(async () => {
      for await (const event of result.stream) {
        // Consume until the provider stream rejects.
        void event;
      }
    }).rejects.toBe(streamFailure);
    expect(create).toHaveBeenCalledOnce();
  });

  it("retries thinking_signature_invalid once without encrypted reasoning content", async () => {
    const request = {
      model: "gpt-5.5",
      stream: true,
      input: [
        {
          type: "reasoning",
          id: "rs_prior",
          encrypted_content: "ciphertext",
          summary: [],
        },
        {
          type: "message",
          id: "msg_prior",
          role: "assistant",
          content: [{ type: "output_text", text: "visible answer" }],
        },
        {
          type: "function_call",
          id: "fc_prior",
          call_id: "call_abc",
          name: "price_lookup",
          arguments: "{}",
        },
      ],
    };
    const recoveredStream = streamChunks([]);
    const recoveredResponse = new Response(null, { status: 200 });
    const create = vi
      .fn()
      .mockReturnValueOnce({
        withResponse: vi.fn().mockRejectedValue(
          new OpenAI.BadRequestError(
            400,
            {
              code: "thinking_signature_invalid",
              message:
                "The encrypted content for item rs_prior could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
              type: "invalid_request_error",
            },
            undefined,
            new Headers(),
          ),
        ),
      })
      .mockReturnValueOnce({
        withResponse: vi.fn().mockResolvedValue({
          data: recoveredStream,
          response: recoveredResponse,
          request_id: null,
        }),
      });

    await expect(
      testing.createResponsesStreamWithEncryptedContentRetry({
        client: { responses: { create } } as never,
        request: request as never,
        requestOptions: undefined,
        model: {
          id: "gpt-5.5",
          name: "GPT-5.5",
          api: "openai-responses",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      }),
    ).resolves.toMatchObject({
      stream: recoveredStream,
      response: recoveredResponse,
      attempt: { kind: "reasoning-stripped" },
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toBe(request);
    expect(create.mock.calls[1]?.[0]).toEqual({
      ...request,
      input: [
        {
          type: "reasoning",
          id: "rs_prior",
          summary: [],
        },
        request.input[1],
        request.input[2],
      ],
    });
  });

  it("preserves HTTP status when a managed Responses request rejects", async () => {
    const failure = new OpenAI.RateLimitError(
      429,
      {
        code: "rate_limit_exceeded",
        message: "rate limited",
        type: "rate_limit_error",
      },
      undefined,
      new Headers(),
    );
    const withResponse = vi.fn().mockRejectedValue(failure);

    await expect(
      testing.createResponsesStreamWithEncryptedContentRetry({
        client: {
          responses: {
            create: vi.fn().mockReturnValue({ withResponse }),
          },
        } as never,
        request: { model: "gpt-5.5", stream: true, input: [] } as never,
        requestOptions: undefined,
        model: {
          id: "gpt-5.5",
          name: "GPT-5.5",
          api: "openai-responses",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      }),
    ).rejects.toBe(failure);

    expect(failure.status).toBe(429);
    expect(withResponse).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "matches xAI's code-less encrypted-content 400",
      status: 400,
      message:
        "Could not decrypt the provided encrypted_content. Ensure the value is the unmodified encrypted_content from a previous response.",
      expected: true,
    },
    {
      label: "rejects an unrelated decrypt 400",
      status: 400,
      message: "Could not decrypt encrypted_content metadata for the OAuth sidecar.",
      expected: false,
    },
    {
      label: "rejects the xAI phrase on a 500",
      status: 500,
      message: "Could not decrypt the provided encrypted_content.",
      expected: false,
    },
  ])("$label", ({ status, message, expected }) => {
    const error = OpenAI.APIError.generate(status, { error: message }, undefined, new Headers());

    expect(testing.isInvalidEncryptedContentError(error)).toBe(expected);
  });

  it("normalizes overlong Copilot Responses replay tool ids before dispatch", () => {
    const longToolItemId = "iVec" + "A".repeat(360);
    const longToolCallId = `call_ug6lFGKwZDjHfzW8H0PDQRwN|${longToolItemId}`;
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com",
      }),
      replayContext({
        provider: "github-copilot",
        before: [{ role: "user", content: "read the queue", timestamp: 0 }],
        toolCalls: [
          {
            id: longToolCallId,
            name: "exec",
            arguments: { command: "gh pr list --limit 1" },
          },
        ],
        results: [{ id: longToolCallId, name: "exec", content: [{ type: "text", text: "[]" }] }],
        after: [{ role: "user", content: "continue", timestamp: 3 }],
      }),
      { sessionId: "session-123" },
    ) as {
      input?: Array<{ type?: string; id?: string; call_id?: string }>;
    };

    const functionCall = params.input?.find((item) => item.type === "function_call");
    const functionOutput = params.input?.find((item) => item.type === "function_call_output");
    expect(functionCall).toBeDefined();
    expect(functionOutput).toBeDefined();
    expect(functionCall?.id).toBeUndefined();
    expect(functionCall?.call_id).toBe("call_ug6lFGKwZDjHfzW8H0PDQRwN");
    expect(functionOutput?.call_id).toBe(functionCall?.call_id);
    for (const item of params.input ?? []) {
      if (item.id !== undefined) {
        expect(item.id.length).toBeLessThanOrEqual(64);
      }
      if (item.call_id !== undefined) {
        expect(item.call_id.length).toBeLessThanOrEqual(64);
      }
    }
  });

  it("replays update_plan-style empty non-image Responses tool results as no output", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.5", "GPT-5.5"),
      replayContext({
        toolCalls: [{ id: "call_plan", name: "update_plan", arguments: {} }],
        results: [{ id: "call_plan", name: "update_plan", content: [] }],
      }),
      { sessionId: "session-123" },
    ) as {
      input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
    };

    expect(params.input?.find((item) => item.type === "function_call_output")).toMatchObject({
      type: "function_call_output",
      call_id: "call_plan",
      output: "(no output)",
    });
  });

  it("replays payload-less Responses tool images as no output without image parts", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        input: ["text", "image"],
      }),
      replayContext({
        toolCalls: [{ id: "call_husk", name: "screenshot", arguments: {} }],
        results: [
          {
            id: "call_husk",
            name: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "" }],
          },
        ],
      }),
      { sessionId: "session-123" },
    ) as {
      input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
    };

    const output = params.input?.find((item) => item.type === "function_call_output");
    expect(output).toMatchObject({ call_id: "call_husk", output: "(no output)" });
    expect(JSON.stringify(output)).not.toContain("input_image");
    expect(JSON.stringify(output)).not.toContain("see attached image");
  });

  it("preserves image-bearing Responses tool results as image input parts", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        input: ["text", "image"],
      }),
      replayContext({
        toolCalls: [{ id: "call_shot", name: "screenshot", arguments: {} }],
        results: [
          {
            id: "call_shot",
            name: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "aW1n" }],
          },
        ],
      }),
      { sessionId: "session-123" },
    ) as {
      input?: Array<{ type?: string; output?: unknown }>;
    };

    expect(params.input?.find((item) => item.type === "function_call_output")?.output).toEqual([
      {
        type: "input_image",
        detail: "auto",
        image_url: "data:image/png;base64,aW1n",
      },
    ]);
  });

  it("serializes structured tool result content (e.g. json blocks) into Responses function_call_output text", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.5", "GPT-5.5"),
      replayContext({
        toolCalls: [{ id: "call_lookup", name: "lookup", arguments: { query: "price" } }],
        results: [
          {
            id: "call_lookup",
            name: "lookup",
            content: [{ type: "json", payload: { price: 42, currency: "USD" } }],
          },
        ],
        after: [{ role: "user", content: "continue", timestamp: 3 }],
      }),
      undefined,
    ) as {
      input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
    };

    const output = params.input?.find((item) => item.type === "function_call_output");
    expect(output).toBeDefined();
    expect(output?.call_id).toBe("call_lookup");
    const outputText = output?.output as string;
    expect(typeof outputText).toBe("string");
    expect(outputText).toContain("price");
    expect(outputText).toContain("42");
    expect(outputText).not.toBe("(see attached image)");
  });

  it("omits distinct overlong Copilot Responses replay item ids when store is disabled", () => {
    const sharedToolItemPrefix = "iVec" + "A".repeat(160);
    const firstToolCallId = `call_first|${sharedToolItemPrefix}Aa`;
    const secondToolCallId = `call_second|${sharedToolItemPrefix}BB`;
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com",
      }),
      replayContext({
        provider: "github-copilot",
        toolCalls: [
          { id: firstToolCallId, name: "read", arguments: { path: "a" } },
          { id: secondToolCallId, name: "read", arguments: { path: "b" } },
        ],
        results: [
          { id: firstToolCallId, name: "read", content: [{ type: "text", text: "a" }] },
          {
            id: secondToolCallId,
            name: "read",
            content: [{ type: "text", text: "b" }],
            timestamp: 3,
          },
        ],
        after: [{ role: "user", content: "continue", timestamp: 4 }],
      }),
      { sessionId: "session-123" },
    ) as {
      input?: Array<{ type?: string; id?: string; call_id?: string }>;
    };

    const functionCalls = params.input?.filter((item) => item.type === "function_call") ?? [];
    const functionOutputs =
      params.input?.filter((item) => item.type === "function_call_output") ?? [];
    expect(functionCalls.map((item) => item.id)).toEqual([undefined, undefined]);
    expect(functionOutputs.map((item) => item.call_id)).toEqual(["call_first", "call_second"]);
  });

  it("adds minimal user input for Codex responses when only the system prompt is present", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as {
      input?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
      instructions?: string;
    };

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: " " }],
      },
    ]);
  });

  it("does not infer high reasoning when the runtime passes thinking off", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4", "GPT-5.4"),
      emptyResponsesContext(),
      undefined,
    ) as { reasoning?: unknown; include?: string[] };

    expect(params.reasoning).toEqual({ effort: "none" });
    expect(params).not.toHaveProperty("include");
  });

  it("uses shared stream reasoning as OpenAI Responses effort", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4", "GPT-5.4"),
      emptyResponsesContext(),
      {
        reasoning: "high",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("normalizes canonical reasoning casing in Responses and Chat Completions payloads", () => {
    const context = emptyResponsesContext();
    const baseModel = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"] as Model["input"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };

    const responses = buildOpenAIResponsesParams(
      makeResponsesModel({
        ...baseModel,
      }),
      context,
      { reasoningEffort: " XHIGH " } as never,
    ) as { reasoning?: unknown };
    const completions = buildOpenAICompletionsParams(
      makeCompletionsModel({
        ...baseModel,
      }),
      context,
      { reasoningEffort: " XHIGH " } as never,
    ) as { reasoning_effort?: unknown };

    expect(responses.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(completions.reasoning_effort).toBe("xhigh");
  });

  it("uses disabled OpenAI Responses reasoning when the model supports none", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4", "GPT-5.4"),
      emptyResponsesContext(),
      {
        reasoningEffort: "none",
      } as never,
    ) as { reasoning?: unknown; include?: unknown };

    expect(params.reasoning).toEqual({ effort: "none" });
    expect(params).not.toHaveProperty("include");
  });

  it("omits disabled OpenAI Responses reasoning when the model does not support none", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5", "GPT-5"),
      emptyResponsesContext(),
      {
        reasoningEffort: "none",
      } as never,
    ) as { reasoning?: unknown; include?: unknown };

    expect(params).not.toHaveProperty("reasoning");
    expect(params).not.toHaveProperty("include");
  });

  it("maps minimal shared reasoning to low for OpenAI Responses", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4", "GPT-5.4"),
      emptyResponsesContext(),
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("raises minimal OpenAI Responses reasoning when web_search is available", () => {
    const model = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      compat: {
        supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      },
    } as unknown as Model<"openai-responses">;

    const params = buildOpenAIResponsesParams(
      model,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "web_search",
            description: "Search the web",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("keeps minimal OpenAI Responses reasoning without web_search", () => {
    const model = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      compat: {
        supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      },
    } as unknown as Model<"openai-responses">;

    const params = buildOpenAIResponsesParams(
      model,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      {
        reasoning: "minimal",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "minimal", summary: "auto" });
  });

  it("maps low reasoning to medium for Codex mini responses models", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.1-codex-mini",
        name: "gpt-5.1-codex-mini",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      emptyResponsesContext(),
      {
        reasoning: "low",
      } as never,
    ) as { reasoning?: unknown };

    expect(params.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  it.each([
    {
      label: "openai-platform",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
    },
    {
      label: "openai-chatgpt",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        provider: "openai",
        baseUrl: "https://chatgpt.com/backend-api",
      },
    },
    {
      label: "azure-openai-responses",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        baseUrl: "https://azure.example.openai.azure.com/openai/v1",
      },
    },
    {
      label: "custom-openai-responses",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "custom-openai-responses",
        baseUrl: "https://proxy.example.com/v1",
      },
    },
  ])("omits orphan phase-tagged ids for $label responses payloads", ({ label: _label, model }) => {
    const params = buildOpenAIResponsesParams(
      {
        ...model,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as Model<"openai-responses">,
      replayContext({
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop",
        text: { id: "msg_commentary", phase: "commentary", text: "Working..." },
        after: [{ role: "user", content: "Continue", timestamp: 2 }],
      }),
      undefined,
    ) as {
      input?: Array<{ role?: string; id?: string; phase?: string }>;
    };

    const assistantItem = params.input?.find((item) => item.role === "assistant");
    expectRecordFields(assistantItem, {
      role: "assistant",
      phase: "commentary",
    });
    expect(assistantItem?.id).toBeUndefined();
  });

  it("strips the internal cache boundary from OpenAI system prompts", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4", "GPT-5.4"),
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { instructions?: string };

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
  });

  it("defaults responses tool schemas to strict on native OpenAI routes", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4", "GPT-5.4"),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean }> };

    expect(params.tools?.[0]?.strict).toBe(true);
    expectRecordFields(params.tools?.[0], {
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
        required: [],
      },
    });
  });

  it("passes explicit Responses tool_choice when tools are present", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4", "GPT-5.4"),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      } as never,
      { toolChoice: "required" } as never,
    ) as { tool_choice?: string };

    expect(params.tool_choice).toBe("required");
  });

  it("keeps healthy Responses tools when a sibling schema is unreadable", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.5", "GPT-5.5"),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "broken",
            description: "Broken",
            get parameters(): never {
              throw new Error("parameters exploded");
            },
          },
          {
            name: "lookup",
            description: "Lookup",
            parameters: {},
          },
        ],
      } as never,
      { toolChoice: { type: "function", name: "lookup" } },
    ) as {
      tools?: Array<{ name?: string; strict?: boolean }>;
      tool_choice?: unknown;
    };

    expect(params.tools).toEqual([expect.objectContaining({ name: "lookup", strict: true })]);
    expect(params.tool_choice).toEqual({ type: "function", name: "lookup" });
  });

  it("fails locally when a pinned Responses tool is unreadable", () => {
    expect(() =>
      buildOpenAIResponsesParams(
        responsesModelFixture("gpt-5.5", "GPT-5.5"),
        {
          systemPrompt: "system",
          messages: [],
          tools: [
            {
              name: "broken",
              get parameters(): never {
                throw new Error("parameters exploded");
              },
            },
          ],
        } as never,
        { toolChoice: { type: "function", name: "broken" } },
      ),
    ).toThrow('requested unavailable tool "broken"');
  });

  it("filters official Responses allowed_tools against projected functions", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.5", "GPT-5.5"),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            parameters: {},
          },
        ],
      } as never,
      {
        toolChoice: {
          type: "allowed_tools",
          mode: "required",
          tools: [
            { type: "function", name: "broken" },
            { type: "function", name: "lookup" },
          ],
        },
      },
    ) as { tool_choice?: unknown };

    expect(params.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "lookup" }],
    });
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
    const responsesModel = responsesModelFixture("gpt-5.5", "GPT-5.5");
    const completionsModel = makeCompletionsModel({
      ...responsesModel,
      api: "openai-completions",
      reasoning: false,
    });
    const context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools,
    } as never;

    expect(buildOpenAIResponsesParams(responsesModel, context, undefined)).not.toHaveProperty(
      "tools",
    );
    expect(buildOpenAICompletionsParams(completionsModel, context, undefined)).not.toHaveProperty(
      "tools",
    );
  });

  it("sorts Responses tools by name for stable prompt-cache payloads", () => {
    const model = responsesModelFixture("gpt-5.4", "GPT-5.4");
    const zetaTool = {
      name: "zeta",
      description: "Z",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    };
    const alphaTool = {
      name: "alpha",
      description: "A",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    };

    const first = buildOpenAIResponsesParams(
      model,
      {
        systemPrompt: "system",
        messages: [],
        tools: [zetaTool, alphaTool],
      } as never,
      { sessionId: "session-123" } as never,
    ) as { tools?: Array<{ name?: string }> };
    const second = buildOpenAIResponsesParams(
      model,
      {
        systemPrompt: "system",
        messages: [],
        tools: [alphaTool, zetaTool],
      } as never,
      { sessionId: "session-123" } as never,
    ) as { tools?: Array<{ name?: string }> };

    expect(first.tools?.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
    expect(first.tools).toEqual(second.tools);
  });

  it("falls back to strict:false when a native OpenAI tool schema is not strict-compatible", () => {
    const params = buildOpenAIResponsesParams(
      responsesModelFixture("gpt-5.4", "GPT-5.4"),
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: [],
            },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean }> };

    expect(params.tools?.[0]?.strict).toBe(false);
  });

  it("deduplicates repeated OpenAI strict schema downgrade diagnostics", async () => {
    const debug = vi.fn();
    const logger = {
      subsystem: "openai-transport",
      isEnabled: vi.fn((level: string, target?: string) => level === "debug" && target === "any"),
      trace: vi.fn(),
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      raw: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);

    vi.resetModules();
    vi.doMock("../logging/subsystem.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
      createSubsystemLogger: vi.fn(() => logger),
    }));

    try {
      const { testing: isolatedTesting } =
        await import("./openai-transport-stream.test-support.js");
      const isolatedBuildOpenAIResponsesParams = isolatedTesting.buildOpenAIResponsesParams;
      const model = responsesModelFixture("gpt-5.4", "GPT-5.4");
      const context = {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "read",
            description: "Read file",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: [],
            },
          },
        ],
      } as never;

      const first = isolatedBuildOpenAIResponsesParams(model, context, undefined) as {
        tools?: Array<{ strict?: boolean }>;
      };
      const second = isolatedBuildOpenAIResponsesParams(model, context, undefined) as {
        tools?: Array<{ strict?: boolean }>;
      };

      expect(first.tools?.[0]?.strict).toBe(false);
      expect(second.tools?.[0]?.strict).toBe(false);
      expect(
        debug.mock.calls.filter(
          ([message]) =>
            typeof message === "string" &&
            message.includes("tool schema strict mode downgraded to strict=false"),
        ),
      ).toHaveLength(1);
    } finally {
      vi.doUnmock("../logging/subsystem.js");
      vi.resetModules();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
