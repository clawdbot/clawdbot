import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiModelTransportEvent } from "../host.js";
import { streamOpenAICodexResponses } from "../providers/openai-chatgpt-responses.js";
import {
  attemptEvents,
  chatGptModel,
  completedSseEvent,
  completedSseResponse,
  configureAttestedTransportObserver,
  connectionEvents,
  context,
  coverageEvents,
  createJwt,
  fallbackEvents,
  resetOpenAITransportAccountingTestState,
  submissionEvents,
} from "./openai-provider-transport-accounting.test-support.js";

afterEach(resetOpenAITransportAccountingTestState);

describe("OpenAI native transport accounting", () => {
  it("treats a host-attested synchronous WebSocket send rejection as zero submission", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class SendRejectingWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        throw new Error("private synchronous send failure");
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SendRejectingWebSocket);
    const fetch = vi.fn(async () => completedSseResponse());
    vi.stubGlobal("fetch", fetch);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      maxRetries: 0,
      transport: "auto",
      requestId: "call-sync-send-fallback",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(fetch).toHaveBeenCalledOnce();
    expect(connectionEvents(events)).toMatchObject([{ outcome: "completed" }]);
    expect(submissionEvents(events)).toMatchObject([
      {
        transport: "native-codex-websocket",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
    ]);
    expect(fallbackEvents(events)).toMatchObject([
      {
        fromTransport: "native-codex-websocket",
        toTransport: "native-codex-sse",
        reason: "submission_failure",
      },
    ]);
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        ordinal: 1,
        reason: "transport_fallback",
        outcome: "completed",
      },
    ]);
    expect(coverageEvents(events)).toMatchObject([
      {
        transport: "native-codex-sse",
        scope: "provider_fallbacks",
        state: "lower_bound",
        reason: "terminal_metadata_unavailable",
      },
    ]);
  });

  it("does not retry or fallback after visible WebSocket output", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class SendThenFailWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify({
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  id: "msg_partial",
                  type: "message",
                  role: "assistant",
                  status: "in_progress",
                  content: [],
                },
              }),
            }),
          );
          queueMicrotask(() =>
            this.dispatchEvent(
              Object.assign(new Event("error"), { message: "private post-output failure" }),
            ),
          );
        });
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SendThenFailWebSocket);
    const fetch = vi.fn(async () => completedSseResponse());
    vi.stubGlobal("fetch", fetch);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      requestId: "call-post-send-fallback",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-websocket",
        reason: "initial",
        outcome: "failed",
      },
    ]);
    expect(fallbackEvents(events)).toEqual([]);
  });

  it("does not retry or fallback deterministic response.failed errors", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    let connections = 0;
    class InvalidPromptWebSocket extends EventTarget {
      constructor() {
        super();
        connections += 1;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify({
                type: "response.failed",
                response: {
                  id: "resp_invalid_prompt",
                  status: "failed",
                  error: { code: "invalid_prompt", message: "rejected" },
                },
              }),
            }),
          );
        });
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", InvalidPromptWebSocket);
    const fetch = vi.fn(async () => completedSseResponse());
    vi.stubGlobal("fetch", fetch);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      requestId: "call-invalid-prompt-no-retry",
    }).result();

    expect(result).toMatchObject({
      stopReason: "error",
      responseId: "resp_invalid_prompt",
      errorMessage: "invalid_prompt: rejected",
    });
    expect(connections).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed" },
    ]);
    expect(fallbackEvents(events)).toEqual([]);
  });

  it("retries after metadata-only WebSocket output without duplicating stream start", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    let connectionCount = 0;
    class MetadataThenCompleteWebSocket extends EventTarget {
      constructor() {
        super();
        connectionCount += 1;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() => {
          if (connectionCount === 1) {
            this.dispatchEvent(
              Object.assign(new Event("message"), {
                data: JSON.stringify({
                  type: "response.created",
                  response: { id: "resp_metadata", output: [], status: "in_progress" },
                }),
              }),
            );
            queueMicrotask(() =>
              this.dispatchEvent(
                Object.assign(new Event("error"), { message: "private metadata-only failure" }),
              ),
            );
            return;
          }
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completedSseEvent("resp_metadata_retry")),
            }),
          );
        });
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", MetadataThenCompleteWebSocket);
    const fetch = vi.fn(async () => completedSseResponse());
    vi.stubGlobal("fetch", fetch);

    const stream = streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      maxRetries: 1,
      transport: "auto",
      requestId: "call-metadata-only-retry",
    });
    const streamEvents: Array<{ type: string }> = [];
    for await (const event of stream) {
      streamEvents.push(event);
    }

    expect(streamEvents.filter((event) => event.type === "start")).toHaveLength(1);
    expect(streamEvents.at(-1)?.type).toBe("done");
    expect(fetch).not.toHaveBeenCalled();
    expect(connectionCount).toBe(2);
    expect(attemptEvents(events)).toMatchObject([
      { transport: "native-codex-websocket", reason: "initial", outcome: "failed" },
      { transport: "native-codex-websocket", reason: "retry", outcome: "completed" },
    ]);
    expect(fallbackEvents(events)).toEqual([]);
  });

  it("records submitted WebSocket caller abort as an aborted attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureAttestedTransportObserver(events);
    class AbortedWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() => controller.abort());
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", AbortedWebSocket);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-ws-submitted-abort",
      signal: controller.signal,
    }).result();

    expect(result.stopReason).toBe("aborted");
    expect(attemptEvents(events)).toMatchObject([{ outcome: "aborted", reason: "initial" }]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("counts cached WebSocket reuse as a new attempt without a new connection", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    let connections = 0;
    let submissions = 0;
    class CachedWebSocket extends EventTarget {
      readyState = 1;
      constructor() {
        super();
        connections += 1;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        submissions += 1;
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completedSseEvent(`resp_cached_${submissions}`)),
            }),
          );
        });
      }
      close(): void {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", CachedWebSocket);
    const baseOptions = {
      apiKey: createJwt(),
      sessionId: "cached-transport-accounting",
      transport: "websocket-cached" as const,
    };

    await streamOpenAICodexResponses(chatGptModel, context, {
      ...baseOptions,
      requestId: "call-cached-one",
    }).result();
    await streamOpenAICodexResponses(
      chatGptModel,
      {
        ...context,
        messages: [...context.messages, { role: "user", content: "follow-up", timestamp: 2 }],
      },
      { ...baseOptions, requestId: "call-cached-two" },
    ).result();

    expect(connections).toBe(1);
    expect(submissions).toBe(2);
    expect(connectionEvents(events)).toHaveLength(1);
    expect(attemptEvents(events)).toMatchObject([
      { callId: "call-cached-one", outcome: "completed" },
      { callId: "call-cached-two", outcome: "completed" },
    ]);
  });

  it("records connection-limit recovery as retry plus reconnect, not fallback", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class ConnectionLimitWebSocket extends EventTarget {
      private static connectionCount = 0;
      private readonly connection = ++ConnectionLimitWebSocket.connectionCount;
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        const event =
          this.connection === 1
            ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
            : completedSseEvent("resp_connection_retry");
        queueMicrotask(() =>
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) })),
        );
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", ConnectionLimitWebSocket);
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "websocket",
      requestId: "call-connection-limit",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed" },
      { ordinal: 2, reason: "retry", outcome: "completed" },
    ]);
    expect(connectionEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "completed" },
      { ordinal: 2, reason: "reconnect", outcome: "completed" },
    ]);
    expect(fallbackEvents(events)).toEqual([]);
  });

  it("retries an admitted no-output stream failure before completing", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class RetryableStreamWebSocket extends EventTarget {
      private static connectionCount = 0;
      private readonly connection = ++RetryableStreamWebSocket.connectionCount;
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() => {
          if (this.connection === 1) {
            this.dispatchEvent(
              Object.assign(new Event("close"), {
                code: 1011,
                reason: "upstream reset",
                wasClean: false,
              }),
            );
            return;
          }
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completedSseEvent("resp_stream_retry")),
            }),
          );
        });
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", RetryableStreamWebSocket);
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
      requestId: "call-stream-retry",
    }).result();

    expect(result).toMatchObject({ stopReason: "stop", responseId: "resp_stream_retry" });
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed" },
      { ordinal: 2, reason: "retry", outcome: "completed" },
    ]);
    expect(connectionEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "completed" },
      { ordinal: 2, reason: "reconnect", outcome: "completed" },
    ]);
    expect(fallbackEvents(events)).toEqual([]);
  });

  it("falls back only after an admitted no-output stream failure exhausts retries", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class FailingStreamWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("close"), {
              code: 1011,
              reason: "upstream reset",
              wasClean: false,
            }),
          );
        });
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", FailingStreamWebSocket);
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const fetch = vi.fn(async () => completedSseResponse());
    vi.stubGlobal("fetch", fetch);

    const result = await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      maxRetries: 1,
      transport: "auto",
      requestId: "call-stream-fallback",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fallbackEvents(events)).toMatchObject([{ reason: "stream_failure" }]);
    expect(attemptEvents(events)).toMatchObject([
      {
        transport: "native-codex-websocket",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
      },
      {
        transport: "native-codex-websocket",
        ordinal: 2,
        reason: "retry",
        outcome: "failed",
      },
      {
        transport: "native-codex-sse",
        ordinal: 3,
        reason: "transport_fallback",
        outcome: "completed",
      },
    ]);
    expect(connectionEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "completed" },
      { ordinal: 2, reason: "reconnect", outcome: "completed" },
    ]);
    expect(fallbackEvents(events)).toHaveLength(1);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("records sticky-session policy fallback before the target SSE attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAttestedTransportObserver(events);
    class FailingWebSocket {
      constructor() {
        throw new Error("connect failed");
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );
    const sessionId = "sticky-policy-accounting";

    await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      sessionId,
      requestId: "call-policy-prime",
    }).result();
    await streamOpenAICodexResponses(chatGptModel, context, {
      apiKey: createJwt(),
      transport: "auto",
      sessionId,
      requestId: "call-policy-sticky",
    }).result();

    expect(
      fallbackEvents(events).filter((event) => event.callId === "call-policy-sticky"),
    ).toMatchObject([{ reason: "policy" }]);
    expect(
      attemptEvents(events).filter((event) => event.callId === "call-policy-sticky"),
    ).toMatchObject([{ reason: "transport_fallback", outcome: "completed" }]);
  });
});
