import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

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

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

const apiKey = (() => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
  ).toString("base64url");
  return `${header}.${body}.signature`;
})();

function completedSseResponse(options: {
  responseId: string;
  headers?: HeadersInit;
  payloadModel?: string;
  eventHeaders?: Record<string, string>;
  eventsBefore?: Record<string, unknown>[];
}): Response {
  const event = {
    type: "response.completed",
    response: {
      id: options.responseId,
      status: "completed",
      ...(options.payloadModel ? { model: options.payloadModel } : {}),
      ...(options.eventHeaders ? { headers: options.eventHeaders } : {}),
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
  const headers = new Headers(options.headers);
  headers.set("content-type", "text/event-stream");
  return new Response(
    [...(options.eventsBefore ?? []), event]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join(""),
    { status: 200, headers },
  );
}

function stream(transport: "sse" | "websocket") {
  return streamOpenAICodexResponses(model, context, { apiKey, transport }).result();
}

function expectConflict(result: Awaited<ReturnType<typeof stream>>): void {
  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: "Conflicting OpenAI response model attestations",
  });
  expect(result.responseModel).toBeUndefined();
}

describe("ChatGPT response model attestations", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
  });

  it("preserves the concrete model reported by the SSE response header", async () => {
    const responseModel = "gpt-5.5-rerouted";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        completedSseResponse({
          responseId: "resp_model",
          headers: { "openai-model": responseModel },
        }),
      ),
    );

    expect((await stream("sse")).responseModel).toBe(responseModel);
  });

  it("preserves the provider model reported by a Responses lifecycle event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        completedSseResponse({ responseId: "resp_payload_model", payloadModel: model.id }),
      ),
    );

    expect((await stream("sse")).responseModel).toBe(model.id);
  });

  it("fails closed when a lifecycle model conflicts with response headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        completedSseResponse({
          responseId: "resp_payload_header_conflict",
          payloadModel: "gpt-5.6-sol",
          headers: { "openai-model": "gpt-5.6-terra" },
        }),
      ),
    );

    expectConflict(await stream("sse"));
  });

  it("fails closed when HTTP and SSE model attestations conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        completedSseResponse({
          responseId: "resp_model_conflict",
          headers: { "openai-model": "gpt-5.6-sol" },
          eventHeaders: { "x-openai-model": "gpt-5.6-terra-2026-08-01" },
        }),
      ),
    );

    expectConflict(await stream("sse"));
  });

  it("fails closed on conflicting model evidence from a typeless SSE event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        completedSseResponse({
          responseId: "resp_typeless_model_conflict",
          eventHeaders: { "x-openai-model": "gpt-5.6-terra-2026-08-01" },
          eventsBefore: [{ headers: { "openai-model": "gpt-5.6-sol" } }],
        }),
      ),
    );

    expectConflict(await stream("sse"));
  });

  it("preserves the concrete model reported by websocket event headers", async () => {
    const responseModel = "gpt-5.5-rerouted";
    installWebSocketEvents([
      {
        type: "response.completed",
        response: completedWebSocketResponse("resp_ws_model", {
          "x-openai-model": responseModel,
        }),
      },
    ]);

    expect((await stream("websocket")).responseModel).toBe(responseModel);
  });

  it("fails closed when one websocket event has conflicting model attestations", async () => {
    installWebSocketEvents([
      {
        type: "response.completed",
        headers: { "openai-model": "gpt-5.6-sol" },
        response: completedWebSocketResponse("resp_ws_model_conflict", {
          "x-openai-model": "gpt-5.6-terra-2026-08-01",
        }),
      },
    ]);

    expectConflict(await stream("websocket"));
  });

  it("fails closed on conflicting model evidence from a typeless websocket event", async () => {
    installWebSocketEvents([
      { headers: { "openai-model": "gpt-5.6-sol" } },
      {
        type: "response.completed",
        response: completedWebSocketResponse("resp_ws_typeless_model_conflict", {
          "x-openai-model": "gpt-5.6-terra-2026-08-01",
        }),
      },
    ]);

    expectConflict(await stream("websocket"));
  });
});

function completedWebSocketResponse(id: string, headers: Record<string, string>) {
  return {
    id,
    status: "completed",
    headers,
    output: [],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };
}

function installWebSocketEvents(events: Record<string, unknown>[]): void {
  class ModelHeaderWebSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send(): void {
      queueMicrotask(() => {
        for (const event of events) {
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
        }
      });
    }

    close(): void {}
  }
  vi.stubGlobal("WebSocket", ModelHeaderWebSocket);
}
