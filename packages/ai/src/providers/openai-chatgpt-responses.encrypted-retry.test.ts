import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import { responsesPromptObserver, type ResponsesPromptObservation } from "../internal/openai.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "../transports/openai-responses-compaction-replay.js";
import { OPENAI_RESPONSES_REASONING_REPLAY_META_KEY } from "../transports/openai-responses-contracts.js";
import { withProviderAcceptanceObserver } from "../transports/transport-stream-shared.js";
import type { AssistantMessage, Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

const REASONING_CIPHERTEXT = "opaque-reasoning-replay";
const COMPACTION_CIPHERTEXT = "opaque-compaction-replay";
const FULL_HISTORY_PREFIX = "native full history before compaction";
const REPLAY_IDENTITY = { sessionId: "retry-session", authProfileId: "retry-profile" };

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
} satisfies Model<"openai-chatgpt-responses">;

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

function createReplayContext(kind: "compaction" | "mixed"): Context {
  const content: AssistantMessage["content"] = [];
  if (kind === "mixed") {
    content.push({
      type: "thinking",
      thinking: "prior reasoning",
      thinkingSignature: JSON.stringify({
        type: "reasoning",
        id: "rs_retry",
        encrypted_content: REASONING_CIPHERTEXT,
        summary: [],
        [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: buildOpenAIResponsesReasoningReplayMetadata(
          model,
          REPLAY_IDENTITY,
        ),
      }),
    });
  }
  const prior: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  };
  captureOpenAIResponsesCompaction(
    prior,
    {
      type: "compaction",
      id: "cmp_retry",
      encrypted_content: COMPACTION_CIPHERTEXT,
    },
    0,
    model,
    buildOpenAIResponsesReasoningReplayMetadata(model, REPLAY_IDENTITY),
  );
  return {
    systemPrompt: "PRIVATE-NATIVE-RECOVERY-PROMPT",
    messages: [
      { role: "user", content: FULL_HISTORY_PREFIX, timestamp: 0 },
      prior,
      { role: "user", content: "continue", timestamp: 2 },
    ],
  };
}

function nextTurn(context: Context, output: AssistantMessage): Context {
  return {
    ...context,
    messages: [
      ...context.messages,
      output,
      { role: "user", content: "continue again", timestamp: 3 },
    ],
  };
}

function completionEvent(id: string): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

function successResponse(id: string): Response {
  return new Response(`data: ${JSON.stringify(completionEvent(id))}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function errorResponse(code: string, message = code): Response {
  return new Response(JSON.stringify({ error: { code, message, type: "invalid_request_error" } }), {
    status: 400,
    statusText: "Bad Request",
    headers: { "content-type": "application/json" },
  });
}

function typeOnlyErrorResponse(type: string): Response {
  return new Response(JSON.stringify({ error: { message: type, type } }), {
    status: 400,
    statusText: "Bad Request",
    headers: { "content-type": "application/json" },
  });
}

type RecordedRequest = {
  body: Record<string, unknown>;
  contentEncoding: string | null;
};

function decodeRequest(init: RequestInit | undefined): RecordedRequest {
  const headers = new Headers(init?.headers);
  const contentEncoding = headers.get("content-encoding");
  const raw = init?.body;
  let json: string;
  if (typeof raw === "string") {
    json = raw;
  } else if (raw instanceof Uint8Array) {
    json = contentEncoding === "zstd" ? zstdDecompressSync(raw).toString("utf8") : raw.toString();
  } else {
    throw new Error(`unexpected ChatGPT Responses request body: ${typeof raw}`);
  }
  return { body: JSON.parse(json) as Record<string, unknown>, contentEncoding };
}

function hasInputType(request: RecordedRequest | Record<string, unknown>, type: string): boolean {
  const body = requestBody(request);
  return Array.isArray(body.input) && body.input.some((item) => item?.type === type);
}

function containsCiphertext(
  request: RecordedRequest | Record<string, unknown>,
  ciphertext: string,
): boolean {
  const body = requestBody(request);
  return JSON.stringify(body.input).includes(ciphertext);
}

function containsInputText(
  request: RecordedRequest | Record<string, unknown>,
  text: string,
): boolean {
  return JSON.stringify(requestBody(request).input).includes(text);
}

function requestBody(request: RecordedRequest | Record<string, unknown>): Record<string, unknown> {
  return "contentEncoding" in request ? (request as RecordedRequest).body : request;
}

function requireItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`missing recorded item ${index}`);
  }
  return item;
}

function createObservedOptions<T extends Record<string, unknown>>(
  options: T,
  observations: ResponsesPromptObservation[],
): T {
  responsesPromptObserver.set(options, (observation) => observations.push(observation));
  return options;
}

type WebSocketAction = {
  beforeEvents?: (socket: EventTarget) => void;
  events?: Record<string, unknown>[];
};

function installScriptedWebSocket(actions: WebSocketAction[]) {
  const requests: Array<Record<string, unknown> & { connectionId: number }> = [];
  const sockets: ScriptedWebSocket[] = [];

  class ScriptedWebSocket extends EventTarget {
    readonly connectionId: number;
    closed = false;

    constructor() {
      super();
      this.connectionId = sockets.length + 1;
      sockets.push(this);
      queueMicrotask(() => {
        this.dispatchEvent(new Event("open"));
      });
    }

    send(payload: string): void {
      requests.push({
        ...(JSON.parse(payload) as Record<string, unknown>),
        connectionId: this.connectionId,
      });
      const action = actions.shift();
      if (!action) {
        throw new Error("missing scripted WebSocket action");
      }
      queueMicrotask(() => {
        action.beforeEvents?.(this);
        for (const event of action.events ?? []) {
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
        }
      });
    }

    close(): void {
      this.closed = true;
    }
  }

  vi.stubGlobal("WebSocket", ScriptedWebSocket);
  return { requests, sockets };
}

function invalidEncryptedEvent(): Record<string, unknown> {
  return {
    type: "error",
    error: { code: "invalid_encrypted_content", message: "invalid encrypted content" },
  };
}

function unrelatedErrorEvent(): Record<string, unknown> {
  return {
    type: "error",
    error: { code: "unsupported_parameter", message: "unsupported parameter" },
  };
}

describe("ChatGPT Responses encrypted replay recovery", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("SSE suppresses rejected compaction only after successful stripped recovery", async () => {
    const context = createReplayContext("compaction");
    const onCompactionRejected = vi.fn();
    const observations: ResponsesPromptObservation[] = [];
    const requests: RecordedRequest[] = [];
    const responses = [
      typeOnlyErrorResponse("invalid_encrypted_content"),
      successResponse("resp_recovered"),
      successResponse("resp_next"),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requests.push(decodeRequest(init));
        const response = responses.shift();
        if (!response) {
          throw new Error("missing SSE response");
        }
        return response;
      }),
    );
    const options = createObservedOptions(
      {
        apiKey: createJwt(),
        transport: "sse" as const,
        onCompactionRejected,
        ...REPLAY_IDENTITY,
      },
      observations,
    );

    const recovered = await streamOpenAICodexResponses(model, context, options).result();
    expect(recovered).toMatchObject({
      stopReason: "stop",
      providerReplay: { type: "openai-responses-compaction-suppression", data: "rejected" },
    });
    const next = await streamOpenAICodexResponses(
      model,
      nextTurn(context, recovered),
      options,
    ).result();

    expect(next.stopReason).toBe("stop");
    expect(requests).toHaveLength(3);
    expect(hasInputType(requireItem(requests, 0), "compaction")).toBe(true);
    expect(hasInputType(requireItem(requests, 1), "compaction")).toBe(false);
    expect(containsInputText(requireItem(requests, 0), FULL_HISTORY_PREFIX)).toBe(false);
    expect(containsInputText(requireItem(requests, 1), FULL_HISTORY_PREFIX)).toBe(true);
    expect(hasInputType(requireItem(requests, 2), "compaction")).toBe(false);
    expect(requests.every((request) => request.contentEncoding === "zstd")).toBe(true);
    expect(observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "compaction-stripped",
      "initial",
    ]);
    expect(JSON.stringify(observations)).not.toContain(COMPACTION_CIPHERTEXT);
    expect(onCompactionRejected).toHaveBeenCalledOnce();
  });

  it("SSE preserves compaction when reasoning-stripped recovery succeeds", async () => {
    const context = createReplayContext("mixed");
    const observations: ResponsesPromptObservation[] = [];
    const requests: RecordedRequest[] = [];
    const responses = [
      errorResponse("invalid_encrypted_content"),
      successResponse("resp_reasoning_recovered"),
      successResponse("resp_reasoning_next"),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requests.push(decodeRequest(init));
        return responses.shift() ?? successResponse("unexpected");
      }),
    );
    const options = createObservedOptions(
      { apiKey: createJwt(), transport: "sse" as const, ...REPLAY_IDENTITY },
      observations,
    );

    const recovered = await streamOpenAICodexResponses(model, context, options).result();
    expect(recovered.providerReplay).toBeUndefined();
    await streamOpenAICodexResponses(model, nextTurn(context, recovered), options).result();

    expect(containsCiphertext(requireItem(requests, 0), REASONING_CIPHERTEXT)).toBe(true);
    expect(containsCiphertext(requireItem(requests, 1), REASONING_CIPHERTEXT)).toBe(false);
    expect(hasInputType(requireItem(requests, 1), "compaction")).toBe(true);
    expect(hasInputType(requireItem(requests, 2), "compaction")).toBe(true);
    expect(observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "reasoning-stripped",
      "initial",
    ]);
  });

  it("SSE failed final recovery leaves compaction replayable on the next turn", async () => {
    const context = createReplayContext("mixed");
    const onCompactionRejected = vi.fn();
    const requests: RecordedRequest[] = [];
    const responses = [
      errorResponse("invalid_encrypted_content"),
      errorResponse("invalid_encrypted_content"),
      errorResponse("unsupported_parameter"),
      successResponse("resp_after_failure"),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requests.push(decodeRequest(init));
        return responses.shift() ?? successResponse("unexpected");
      }),
    );
    const options = {
      apiKey: createJwt(),
      transport: "sse" as const,
      onCompactionRejected,
      ...REPLAY_IDENTITY,
    };

    const failed = await streamOpenAICodexResponses(model, context, options).result();
    expect(failed).toMatchObject({
      stopReason: "error",
      errorMessage: "400: unsupported_parameter",
      errorCode: "unsupported_parameter",
    });
    expect(failed.providerReplay).toBeUndefined();
    expect(onCompactionRejected).not.toHaveBeenCalled();
    await streamOpenAICodexResponses(model, nextTurn(context, failed), options).result();

    expect(requests).toHaveLength(4);
    expect(hasInputType(requireItem(requests, 2), "compaction")).toBe(false);
    expect(containsInputText(requireItem(requests, 2), FULL_HISTORY_PREFIX)).toBe(true);
    expect(containsCiphertext(requireItem(requests, 2), REASONING_CIPHERTEXT)).toBe(false);
    expect(hasInputType(requireItem(requests, 3), "compaction")).toBe(true);
  });

  it("SSE abort during stripped recovery leaves compaction replayable", async () => {
    const context = createReplayContext("compaction");
    const controller = new AbortController();
    const requests: RecordedRequest[] = [];
    let requestNumber = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requests.push(decodeRequest(init));
        requestNumber += 1;
        if (requestNumber === 1) {
          return errorResponse("invalid_encrypted_content");
        }
        controller.abort();
        throw Object.assign(new Error("Request was aborted"), { name: "AbortError" });
      }),
    );
    const aborted = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt(),
      transport: "sse",
      signal: controller.signal,
      ...REPLAY_IDENTITY,
    }).result();
    expect(aborted.stopReason).toBe("aborted");
    expect(aborted.providerReplay).toBeUndefined();

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requests.push(decodeRequest(init));
        return successResponse("resp_after_abort");
      }),
    );
    await streamOpenAICodexResponses(model, nextTurn(context, aborted), {
      apiKey: createJwt(),
      transport: "sse",
      ...REPLAY_IDENTITY,
    }).result();
    expect(hasInputType(requireItem(requests, 2), "compaction")).toBe(true);
  });

  it.each([
    {
      label: "unrelated response",
      install: () =>
        vi.fn<typeof fetch>().mockResolvedValue(errorResponse("unsupported_parameter")),
    },
    {
      label: "fetch exception",
      install: () =>
        vi.fn<typeof fetch>().mockRejectedValue(
          Object.assign(new Error("invalid_encrypted_content from local fetch"), {
            code: "invalid_encrypted_content",
          }),
        ),
    },
  ])("SSE does not semantically retry an $label", async ({ install }) => {
    const fetchMock = install();
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAICodexResponses(model, createReplayContext("compaction"), {
      apiKey: createJwt(),
      transport: "sse",
      ...REPLAY_IDENTITY,
    }).result();

    expect(result.stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.providerReplay).toBeUndefined();
  });

  it("SSE does not retry a prompt observer exception", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const options = {
      apiKey: createJwt(),
      transport: "sse" as const,
      ...REPLAY_IDENTITY,
    };
    responsesPromptObserver.set(options, () => {
      throw Object.assign(new Error("observer failed"), { code: "invalid_encrypted_content" });
    });

    const result = await streamOpenAICodexResponses(
      model,
      createReplayContext("compaction"),
      options,
    ).result();

    expect(result).toMatchObject({ stopReason: "error", errorMessage: "observer failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("WebSocket suppresses rejected compaction after output starts and reacquires", async () => {
    const context = createReplayContext("compaction");
    const onCompactionRejected = vi.fn();
    const observations: ResponsesPromptObservation[] = [];
    const scripted = installScriptedWebSocket([
      { events: [invalidEncryptedEvent()] },
      { events: [completionEvent("resp_ws_recovered")] },
      { events: [completionEvent("resp_ws_next")] },
    ]);
    const options = createObservedOptions(
      {
        apiKey: createJwt(),
        transport: "websocket" as const,
        onCompactionRejected,
        ...REPLAY_IDENTITY,
      },
      observations,
    );

    const recovered = await streamOpenAICodexResponses(model, context, options).result();
    expect(recovered.providerReplay).toMatchObject({
      type: "openai-responses-compaction-suppression",
    });
    await streamOpenAICodexResponses(model, nextTurn(context, recovered), options).result();

    expect(scripted.sockets).toHaveLength(2);
    expect(scripted.sockets[0]?.closed).toBe(true);
    expect(scripted.sockets[1]?.closed).toBe(false);
    expect(hasInputType(requireItem(scripted.requests, 0), "compaction")).toBe(true);
    expect(hasInputType(requireItem(scripted.requests, 1), "compaction")).toBe(false);
    expect(containsInputText(requireItem(scripted.requests, 0), FULL_HISTORY_PREFIX)).toBe(false);
    expect(containsInputText(requireItem(scripted.requests, 1), FULL_HISTORY_PREFIX)).toBe(true);
    expect(hasInputType(requireItem(scripted.requests, 2), "compaction")).toBe(false);
    expect(observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "compaction-stripped",
      "initial",
    ]);
    expect(onCompactionRejected).toHaveBeenCalledOnce();
  });

  it("WebSocket commits stripped compaction before acceptance observation fails", async () => {
    const context = createReplayContext("compaction");
    const onCompactionRejected = vi.fn();
    const observations: ResponsesPromptObservation[] = [];
    const scripted = installScriptedWebSocket([
      { events: [invalidEncryptedEvent()] },
      { events: [completionEvent("resp_ws_hook_failure")] },
    ]);
    const baseOptions = createObservedOptions(
      {
        apiKey: createJwt(),
        transport: "websocket" as const,
        onCompactionRejected,
        ...REPLAY_IDENTITY,
      },
      observations,
    );
    const options = withProviderAcceptanceObserver(baseOptions, () => {
      if (scripted.requests.length >= 2) {
        throw new Error("acceptance observer failed");
      }
    });

    const result = await streamOpenAICodexResponses(model, context, options).result();

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "acceptance observer failed",
      providerReplay: { type: "openai-responses-compaction-suppression" },
    });
    expect(scripted.requests).toHaveLength(2);
    expect(hasInputType(requireItem(scripted.requests, 0), "compaction")).toBe(true);
    expect(hasInputType(requireItem(scripted.requests, 1), "compaction")).toBe(false);
    expect(observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "compaction-stripped",
    ]);
    expect(onCompactionRejected).toHaveBeenCalledOnce();
    expect(scripted.sockets[1]?.closed).toBe(true);
  });

  it("WebSocket preserves compaction when reasoning-stripped recovery succeeds", async () => {
    const context = createReplayContext("mixed");
    const observations: ResponsesPromptObservation[] = [];
    const scripted = installScriptedWebSocket([
      { events: [invalidEncryptedEvent()] },
      { events: [completionEvent("resp_ws_reasoning")] },
      { events: [completionEvent("resp_ws_reasoning_next")] },
    ]);
    const options = createObservedOptions(
      { apiKey: createJwt(), transport: "websocket" as const, ...REPLAY_IDENTITY },
      observations,
    );

    const recovered = await streamOpenAICodexResponses(model, context, options).result();
    expect(recovered.providerReplay).toBeUndefined();
    await streamOpenAICodexResponses(model, nextTurn(context, recovered), options).result();

    expect(containsCiphertext(requireItem(scripted.requests, 0), REASONING_CIPHERTEXT)).toBe(true);
    expect(containsCiphertext(requireItem(scripted.requests, 1), REASONING_CIPHERTEXT)).toBe(false);
    expect(hasInputType(requireItem(scripted.requests, 1), "compaction")).toBe(true);
    expect(hasInputType(requireItem(scripted.requests, 2), "compaction")).toBe(true);
    expect(observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "reasoning-stripped",
      "initial",
    ]);
  });

  it("WebSocket final recovery failure leaves replay for the next turn", async () => {
    const context = createReplayContext("mixed");
    const onCompactionRejected = vi.fn();
    const scripted = installScriptedWebSocket([
      { events: [invalidEncryptedEvent()] },
      { events: [invalidEncryptedEvent()] },
      { events: [unrelatedErrorEvent()] },
      { events: [completionEvent("resp_ws_after_failure")] },
    ]);
    const options = {
      apiKey: createJwt(),
      transport: "websocket" as const,
      onCompactionRejected,
      ...REPLAY_IDENTITY,
    };

    const failed = await streamOpenAICodexResponses(model, context, options).result();
    expect(failed.stopReason).toBe("error");
    expect(failed.providerReplay).toBeUndefined();
    expect(onCompactionRejected).not.toHaveBeenCalled();
    await streamOpenAICodexResponses(model, nextTurn(context, failed), options).result();

    expect(scripted.sockets.slice(0, 3).every((socket) => socket.closed)).toBe(true);
    expect(hasInputType(requireItem(scripted.requests, 2), "compaction")).toBe(false);
    expect(containsInputText(requireItem(scripted.requests, 2), FULL_HISTORY_PREFIX)).toBe(true);
    expect(containsCiphertext(requireItem(scripted.requests, 2), REASONING_CIPHERTEXT)).toBe(false);
    expect(hasInputType(requireItem(scripted.requests, 3), "compaction")).toBe(true);
  });

  it("WebSocket abort during stripped recovery leaves replay for the next turn", async () => {
    const context = createReplayContext("compaction");
    const controller = new AbortController();
    const scripted = installScriptedWebSocket([
      { events: [invalidEncryptedEvent()] },
      { beforeEvents: () => controller.abort() },
      { events: [completionEvent("resp_ws_after_abort")] },
    ]);

    const aborted = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt(),
      transport: "websocket",
      signal: controller.signal,
      ...REPLAY_IDENTITY,
    }).result();
    expect(aborted.stopReason).toBe("aborted");
    expect(aborted.providerReplay).toBeUndefined();

    await streamOpenAICodexResponses(model, nextTurn(context, aborted), {
      apiKey: createJwt(),
      transport: "websocket",
      ...REPLAY_IDENTITY,
    }).result();
    expect(hasInputType(requireItem(scripted.requests, 2), "compaction")).toBe(true);
  });

  it("WebSocket does not retry unrelated errors or errors after response.created", async () => {
    const unrelated = installScriptedWebSocket([{ events: [unrelatedErrorEvent()] }]);
    const first = await streamOpenAICodexResponses(model, createReplayContext("compaction"), {
      apiKey: createJwt(),
      transport: "websocket",
      ...REPLAY_IDENTITY,
    }).result();
    expect(first.stopReason).toBe("error");
    expect(unrelated.requests).toHaveLength(1);
    closeOpenAICodexWebSocketSessions();
    resetOpenAICodexWebSocketStateForTest();

    const afterStart = installScriptedWebSocket([
      {
        events: [
          { type: "response.created", response: { id: "resp_created", status: "in_progress" } },
          invalidEncryptedEvent(),
        ],
      },
    ]);
    const second = await streamOpenAICodexResponses(model, createReplayContext("compaction"), {
      apiKey: createJwt(),
      transport: "websocket",
      ...REPLAY_IDENTITY,
    }).result();
    expect(second.stopReason).toBe("error");
    expect(afterStart.requests).toHaveLength(1);
  });

  it("auto fallback carries the reasoning-stripped attempt into SSE", async () => {
    const context = createReplayContext("mixed");
    const observations: ResponsesPromptObservation[] = [];
    installScriptedWebSocket([
      { events: [invalidEncryptedEvent()] },
      { beforeEvents: (socket) => socket.dispatchEvent(new Event("error")) },
    ]);
    const sseRequests: RecordedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        sseRequests.push(decodeRequest(init));
        return successResponse("resp_fallback");
      }),
    );
    const options = createObservedOptions(
      { apiKey: createJwt(), transport: "auto" as const, ...REPLAY_IDENTITY },
      observations,
    );

    const result = await streamOpenAICodexResponses(model, context, options).result();

    expect(result.stopReason).toBe("stop");
    expect(sseRequests).toHaveLength(1);
    expect(containsCiphertext(requireItem(sseRequests, 0), REASONING_CIPHERTEXT)).toBe(false);
    expect(hasInputType(requireItem(sseRequests, 0), "compaction")).toBe(true);
    expect(observations.map(({ egress, payloadVariant }) => ({ egress, payloadVariant }))).toEqual([
      { egress: "native-codex-websocket", payloadVariant: "initial" },
      { egress: "native-codex-websocket", payloadVariant: "reasoning-stripped" },
      { egress: "native-codex-sse", payloadVariant: "reasoning-stripped" },
    ]);
  });

  it("auto fallback reuses the lazily rebuilt full-history attempt in SSE", async () => {
    const context = createReplayContext("compaction");
    const observations: ResponsesPromptObservation[] = [];
    const scripted = installScriptedWebSocket([
      { events: [invalidEncryptedEvent()] },
      { beforeEvents: (socket) => socket.dispatchEvent(new Event("error")) },
    ]);
    const sseRequests: RecordedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        sseRequests.push(decodeRequest(init));
        return successResponse("resp_full_history_fallback");
      }),
    );
    const onPayload = vi.fn((request: unknown) => request);
    const options = createObservedOptions(
      {
        apiKey: createJwt(),
        transport: "auto" as const,
        ...REPLAY_IDENTITY,
        onPayload,
      },
      observations,
    );

    const result = await streamOpenAICodexResponses(model, context, options).result();

    expect(result.stopReason).toBe("stop");
    expect(scripted.sockets).toHaveLength(2);
    expect(scripted.sockets.every((socket) => socket.closed)).toBe(true);
    expect(hasInputType(requireItem(scripted.requests, 0), "compaction")).toBe(true);
    expect(containsInputText(requireItem(scripted.requests, 0), FULL_HISTORY_PREFIX)).toBe(false);
    expect(hasInputType(requireItem(scripted.requests, 1), "compaction")).toBe(false);
    expect(containsInputText(requireItem(scripted.requests, 1), FULL_HISTORY_PREFIX)).toBe(true);
    expect(sseRequests).toHaveLength(1);
    expect(hasInputType(requireItem(sseRequests, 0), "compaction")).toBe(false);
    expect(containsInputText(requireItem(sseRequests, 0), FULL_HISTORY_PREFIX)).toBe(true);
    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(observations.map(({ egress, payloadVariant }) => ({ egress, payloadVariant }))).toEqual([
      { egress: "native-codex-websocket", payloadVariant: "initial" },
      { egress: "native-codex-websocket", payloadVariant: "compaction-stripped" },
      { egress: "native-codex-sse", payloadVariant: "compaction-stripped" },
    ]);
  });
});
