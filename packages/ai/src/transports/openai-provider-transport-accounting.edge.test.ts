import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiModelTransportEvent } from "../host.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamOpenAICodexResponses } from "../providers/openai-chatgpt-responses.js";
import {
  attemptEvents,
  azureModel,
  chatGptModel,
  completedSseResponse,
  configureAttestedTransportObserver,
  configureTransportObserver,
  connectionEvents,
  context,
  createJwt,
  fallbackEvents,
  openAIModel,
  resetOpenAITransportAccountingTestState,
  submissionEvents,
} from "./openai-provider-transport-accounting.test-support.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";

afterEach(resetOpenAITransportAccountingTestState);

describe("OpenAI transport accounting edge cases", () => {
  it("isolates throwing transport observers from provider success", async () => {
    configureTransportObserver([], () => vi.fn(async () => completedSseResponse()));
    configureAiTransportHost({
      ...getAiTransportHost(),
      observeModelTransportEvent: () => {
        throw new Error("observer failure");
      },
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-throwing-observer",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
  });

  it("keeps event identities route-scoped when request IDs repeat", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => completedSseResponse()));

    const openAIStream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "reused-call-id",
      }),
    );
    const azureStream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(azureModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "reused-call-id",
      }),
    );
    await Promise.all([openAIStream.result(), azureStream.result()]);

    const ids = attemptEvents(events).map((event) => event.eventId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("emits no uncorrelated transport events when requestId is absent", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => completedSseResponse()));

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(events).toEqual([]);
  });

  it("leaves SDK egress uninstrumented when the embedding host supplies no guarded fetch", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => undefined,
      observeModelTransportEvent: (event) => events.push(event),
    });
    const networkFetch = vi.fn(async () => completedSseResponse());
    vi.stubGlobal("fetch", networkFetch);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-default-host-fetch",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(networkFetch).toHaveBeenCalledOnce();
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("emits zero submission when SDK retry backoff ends in caller abort", async () => {
    const events: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureAttestedTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setTimeout(() => controller.abort(), 0);
        return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after-ms": "20" },
        });
      }),
    );

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        requestId: "call-sdk-retry-abort",
        signal: controller.signal,
      }),
    );

    expect((await stream.result()).stopReason).toBe("aborted");
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed", statusCode: 503 },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "responses-sdk", outcome: "aborted", total: 0 },
    ]);
  });

  it("emits zero submission when native SSE retry backoff is caller-aborted", async () => {
    const events: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureAttestedTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("overloaded", { status: 503 })),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 1,
      requestId: "call-native-retry-abort",
      signal: controller.signal,
      onResponse: () => controller.abort(),
    }).result();

    expect(result.stopReason).toBe("aborted");
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed", statusCode: 503 },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "native-codex-sse", outcome: "aborted", total: 0 },
    ]);
  });

  it("emits zero submission when a WebSocket reconnect fails before resend", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    class ReconnectFailingWebSocket extends EventTarget {
      private static connectionCount = 0;
      private readonly connection = ++ReconnectFailingWebSocket.connectionCount;
      constructor() {
        super();
        if (this.connection === 2) {
          throw new Error("reconnect failed");
        }
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify({
                type: "error",
                error: { code: "websocket_connection_limit_reached" },
              }),
            }),
          ),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", ReconnectFailingWebSocket);
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      maxRetries: 1,
      transport: "websocket",
      requestId: "call-ws-reconnect-failure",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed" },
    ]);
    expect(connectionEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "completed" },
      { ordinal: 2, reason: "reconnect", outcome: "failed" },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "native-codex-websocket", outcome: "failed", total: 0 },
    ]);
  });

  it("does not count a synchronous native SSE fetch throw as a submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch invocation failed");
      }),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-sync-fetch-throw",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("counts an asynchronously rejected native SSE fetch as a failed submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network request rejected"))),
    );

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-async-fetch-reject",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(attemptEvents(events)).toMatchObject([
      { transport: "native-codex-sse", outcome: "failed", reason: "initial" },
    ]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("preserves hostless native SSE failures without fabricating accounting", async () => {
    const nonOkEvents: AiModelTransportEvent[] = [];
    const onResponse = vi.fn();
    configureTransportObserver(nonOkEvents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("overloaded", { status: 503 })),
    );

    const nonOkResult = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-hostless-non-ok",
      onResponse,
    }).result();

    expect(nonOkResult.stopReason).toBe("error");
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }), chatGptModel);
    expect(attemptEvents(nonOkEvents)).toEqual([]);
    expect(submissionEvents(nonOkEvents)).toEqual([]);

    const rejectionEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(rejectionEvents);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network request rejected"))),
    );

    const rejectionResult = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "sse",
      maxRetries: 0,
      requestId: "call-native-hostless-rejection",
    }).result();

    expect(rejectionResult.stopReason).toBe("error");
    expect(attemptEvents(rejectionEvents)).toEqual([]);
    expect(submissionEvents(rejectionEvents)).toEqual([]);
  });

  it("falls back when the installed host WebSocket connector declines the route", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );

    const result = await streamOpenAICodexResponses(
      { ...chatGptModel, baseUrl: "http://127.0.0.1:9" },
      context,
      {
        apiKey: createJwt(),
        maxRetries: 0,
        transport: "auto",
        requestId: "call-server-runtime-guarded-sse",
      },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(fallbackEvents(events)).toMatchObject([{ reason: "unsupported" }]);
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        reason: "transport_fallback",
        outcome: "completed",
      },
    ]);
    expect(submissionEvents(events)).toEqual([]);
  });
});
