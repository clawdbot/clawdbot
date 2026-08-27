import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import { withProviderAcceptanceObserver } from "../transports/transport-stream-shared.js";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("OpenAI ChatGPT Responses inference streaming", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
  });

  const model = {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    api: "openai-chatgpt-responses",
    provider: "openai",
    baseUrl: "https://chatgpt.test/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
  } satisfies Model<"openai-chatgpt-responses">;

  const context = {
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
  } satisfies Context;

  it("preserves incomplete SSE terminals without exposing truncated tool calls", async () => {
    const terminal = {
      type: "response.incomplete",
      response: {
        id: "resp_incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            id: "msg_partial",
            role: "assistant",
            content: [{ type: "output_text", text: "TERMINAL_PARTIAL" }],
          },
          {
            type: "function_call",
            id: "fc_truncated",
            call_id: "call_truncated",
            name: "write",
            arguments: '{"path":"unfinished',
          },
        ],
        usage: {
          input_tokens: 21,
          output_tokens: 4,
          total_tokens: 25,
          input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "sse",
    }).result();

    expect(result).toMatchObject({
      stopReason: "length",
      responseId: "resp_incomplete",
      content: [{ type: "text", text: "TERMINAL_PARTIAL" }],
      usage: { input: 13, output: 4, cacheRead: 6, cacheWrite: 2, totalTokens: 25 },
    });
    expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
  });

  it.each([
    { label: "without a status", status: undefined },
    { label: "with an incomplete status", status: "incomplete" },
  ])("emits an error for content-filtered incomplete SSE turns $label", async ({ status }) => {
    const terminal = {
      type: "response.incomplete",
      response: {
        id: "resp_filtered",
        ...(status ? { status } : {}),
        incomplete_details: { reason: "content_filter" },
        output: [
          {
            type: "message",
            id: "msg_filtered",
            role: "assistant",
            content: [{ type: "output_text", text: "FILTERED_PARTIAL" }],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "sse",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      error: {
        stopReason: "error",
        responseId: "resp_filtered",
        errorMessage: "Provider incomplete_reason: content_filter",
        content: [],
        usage: { input: 12, output: 3, totalTokens: 15 },
      },
    });
  });

  it("reports acceptance before the default WebSocket stream starts", async () => {
    class AcceptedWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify({
                type: "response.completed",
                response: {
                  id: "resp_ws_accepted",
                  status: "completed",
                  output: [],
                  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
                },
              }),
            }),
          );
        });
      }

      close(): void {}
    }

    const order: string[] = [];
    const acceptanceObserver = vi.fn(() => {
      order.push("accepted");
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("WebSocket", AcceptedWebSocket);
    vi.stubGlobal("fetch", fetchMock);
    const options = withProviderAcceptanceObserver(
      {
        apiKey: createJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
        }),
      },
      acceptanceObserver,
    );

    const stream = streamOpenAICodexResponses(model, context, options);
    for await (const event of stream) {
      order.push(event.type);
    }

    expect(order).toEqual(["accepted", "start", "done"]);
    expect(acceptanceObserver).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits an error for a content-filtered incomplete WebSocket turn", async () => {
    class ContentFilteredWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify({
                type: "response.incomplete",
                response: {
                  id: "resp_ws_filtered",
                  incomplete_details: { reason: "content_filter" },
                  output: [],
                  usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
                },
              }),
            }),
          );
        });
      }

      close(): void {}
    }

    const fetchMock = vi.fn();
    vi.stubGlobal("WebSocket", ContentFilteredWebSocket);
    vi.stubGlobal("fetch", fetchMock);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "websocket",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      error: {
        stopReason: "error",
        responseId: "resp_ws_filtered",
        errorMessage: "Provider incomplete_reason: content_filter",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs the caller abort reason with bounded ChatGPT transport metadata", async () => {
    const logWarn = vi.fn();
    configureAiTransportHost({ logWarn });
    const controller = new AbortController();
    class AbortedWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        controller.abort(new Error("Compaction timed out"));
      }

      close(): void {}
    }
    vi.stubGlobal("WebSocket", AbortedWebSocket);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      signal: controller.signal,
    }).result();

    expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
    expect(logWarn).toHaveBeenCalledWith(
      "openai-transport",
      "ChatGPT Responses stream terminated",
      {
        api: "openai-chatgpt-responses",
        elapsedMs: expect.any(Number),
        failureKind: "caller-abort",
        model: "gpt-5.6-luna",
        provider: "openai",
        stopReason: "aborted",
        transport: "auto",
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a direct HTTP rejection as a provider failure without logging its text", async () => {
    const logWarn = vi.fn();
    configureAiTransportHost({ logWarn });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "hostile prompt echo in a 400 body", code: "invalid_request" },
        }),
        { status: 400, statusText: "Bad Request" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "sse",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(logWarn).toHaveBeenCalledTimes(1);
    const logged = logWarn.mock.calls[0]?.[2];
    expect(logged).toMatchObject({ stopReason: "error", failureKind: "provider-failure" });
    const serialized = JSON.stringify(logged);
    for (const hostile of ["hostile", "invalid_request", "400 body"]) {
      expect(serialized).not.toContain(hostile);
    }
  });

  it.each(["sse", "websocket"] as const)(
    "preserves failed response identity and provider error details over %s",
    async (transport) => {
      const failedResponse = {
        type: "response.failed",
        response: {
          id: "resp_failed",
          status: "failed",
          error: {
            code: "invalid_prompt",
            type: "hostile type: user prompt echoed here",
            message: "rejected",
          },
        },
      };
      const logWarn = vi.fn();
      configureAiTransportHost({ logWarn });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      if (transport === "sse") {
        fetchMock.mockResolvedValue(
          new Response(`data: ${JSON.stringify(failedResponse)}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      } else {
        class FailedResponseWebSocket extends EventTarget {
          constructor() {
            super();
            queueMicrotask(() => this.dispatchEvent(new Event("open")));
          }

          send(): void {
            queueMicrotask(() => {
              this.dispatchEvent(
                Object.assign(new Event("message"), { data: JSON.stringify(failedResponse) }),
              );
            });
          }

          close(): void {}
        }
        vi.stubGlobal("WebSocket", FailedResponseWebSocket);
      }

      const stream = streamOpenAICodexResponses(model, context, {
        apiKey: createJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
        }),
        transport,
      });
      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events.map((event) => event.type)).toEqual(["start", "error"]);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        error: {
          responseId: "resp_failed",
          stopReason: "error",
          errorMessage: "invalid_prompt: rejected",
        },
      });
      // Provider message text reaches the stream consumer only; the transport
      // log keeps timing and classification and never the message body.
      expect(logWarn).toHaveBeenCalledTimes(1);
      const logged = logWarn.mock.calls[0]?.[2];
      expect(logged).toEqual({
        api: "openai-chatgpt-responses",
        elapsedMs: expect.any(Number),
        failureKind: "provider-failure",
        model: "gpt-5.6-luna",
        provider: "openai",
        stopReason: "error",
        transport,
      });
      const serialized = JSON.stringify(logged);
      for (const hostile of ["rejected", "invalid_prompt", "hostile type", "echoed"]) {
        expect(serialized).not.toContain(hostile);
      }
      if (transport === "websocket") {
        expect(fetchMock).not.toHaveBeenCalled();
      }
    },
  );

  it("consumes CRLF-delimited responses through the provider SSE stream", async () => {
    const terminal = {
      type: "response.completed",
      response: {
        id: "resp_crlf",
        status: "completed",
        output: [],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    };
    const dataLines = JSON.stringify(terminal, null, 2)
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\r\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(`event: response.completed\r\n${dataLines}\r\n\r\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "sse",
    }).result();

    expect(result).toMatchObject({
      stopReason: "stop",
      responseId: "resp_crlf",
      usage: { input: 5, output: 3, totalTokens: 8 },
    });
  });
});
