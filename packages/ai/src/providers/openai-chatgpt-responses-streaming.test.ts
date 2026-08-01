import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  parseSSEForTest,
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

  it.each(["sse", "websocket"] as const)(
    "preserves failed response identity and provider error details over %s",
    async (transport) => {
      const failedResponse = {
        type: "response.failed",
        response: {
          id: "resp_failed",
          status: "failed",
          error: { code: "invalid_prompt", message: "rejected" },
        },
      };
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

describe("ChatGPT Responses SSE frame boundaries", () => {
  const completedEvent = {
    type: "response.completed",
    response: {
      id: "resp_parser",
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
  const serializedCompletedEvent = JSON.stringify(completedEvent);
  const multilineDataLines = JSON.stringify(completedEvent, null, 2)
    .split("\n")
    .map((line) => `data: ${line}`);

  it.each([
    { label: "LF", chunks: [`data: ${serializedCompletedEvent}\n\n`] },
    { label: "CRLF", chunks: [`data: ${serializedCompletedEvent}\r\n\r\n`] },
    { label: "lone CR", chunks: [`data: ${serializedCompletedEvent}\r\r`] },
    {
      label: "mixed line endings",
      chunks: [`event: response.completed\r\ndata: ${serializedCompletedEvent}\n\r\n`],
    },
    {
      label: "chunk-split CRLF",
      chunks: [
        `event: response.completed\r`,
        `\ndata: ${serializedCompletedEvent}\r`,
        "\n\r",
        "\n",
      ],
    },
    {
      label: "chunk-split lone CR",
      chunks: ["event: response.completed\r", `data: ${serializedCompletedEvent}\r`, "\r"],
    },
    { label: "multiline LF", chunks: [`${multilineDataLines.join("\n")}\n\n`] },
    { label: "multiline CRLF", chunks: [`${multilineDataLines.join("\r\n")}\r\n\r\n`] },
    { label: "multiline lone CR", chunks: [`${multilineDataLines.join("\r")}\r\r`] },
    {
      label: "multiline mixed line endings",
      chunks: [
        `event: response.completed\r\n${multilineDataLines
          .map(
            (line, index) => `${line}${index % 3 === 0 ? "\r\n" : index % 3 === 1 ? "\r" : "\n"}`,
          )
          .join("")}\r\n`,
      ],
    },
    {
      label: "multiline chunk-split CRLF",
      chunks: [...multilineDataLines.flatMap((line) => [`${line}\r`, "\n"]), "\r", "\n"],
    },
    {
      label: "multiline chunk-split lone CR",
      chunks: [...multilineDataLines.flatMap((line) => [line, "\r"]), "\r"],
    },
  ])("parses $label SSE frame boundaries", async ({ chunks }) => {
    let chunkIndex = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[chunkIndex++];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    const events = [];

    for await (const event of parseSSEForTest(new Response(body))) {
      events.push(event);
    }

    expect(events).toEqual([completedEvent]);
  });

  it.each([
    { label: "lone CR", chunks: [`data: ${serializedCompletedEvent}\r\r`] },
    { label: "mixed LF and lone CR", chunks: [`data: ${serializedCompletedEvent}\n\r`] },
    { label: "mixed CRLF and lone CR", chunks: [`data: ${serializedCompletedEvent}\r\n\r`] },
    { label: "chunk-split lone CR", chunks: [`data: ${serializedCompletedEvent}\r`, "\r"] },
    {
      label: "chunk-split mixed LF and lone CR",
      chunks: [`data: ${serializedCompletedEvent}\n`, "\r"],
    },
  ])("dispatches a $label SSE frame before an open response closes", async ({ chunks }) => {
    const cleanup = new AbortController();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        cleanup.signal.addEventListener("abort", () => controller.close(), { once: true });
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
      },
      cancel() {
        canceled = true;
      },
    });
    const iterator = parseSSEForTest(new Response(body))[Symbol.asyncIterator]();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let receivedEvent = false;

    try {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("SSE frame was not dispatched while the response remained open"));
          }, 1_000);
        }),
      ]);
      receivedEvent = true;

      expect(result).toEqual({ done: false, value: completedEvent });
      expect(cleanup.signal.aborted).toBe(false);
      expect(canceled).toBe(false);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!receivedEvent) {
        cleanup.abort();
      }
      await iterator.return(undefined);
    }

    expect(canceled).toBe(true);
  });
});
