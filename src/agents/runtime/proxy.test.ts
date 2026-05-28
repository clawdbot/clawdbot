import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model, Usage } from "../../llm/types.js";
import { streamProxy } from "./proxy.js";

const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model = {
  id: "test-model",
  name: "Test Model",
  provider: "test",
  api: "openai-responses",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1024,
  maxTokens: 1024,
};

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function responseFromText(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe("streamProxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flushes a final SSE frame without a trailing newline", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      responseFromText(
        `data: ${JSON.stringify({
          type: "done",
          reason: "stop",
          usage,
        })}`,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const options = {
      authToken: "token",
      headers: { Authorization: "Bearer upstream", "x-api-key": "secret" },
      proxyUrl: "https://proxy.example",
    };
    const stream = streamProxy(model, context, options);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("done");
    await expect(stream.result()).resolves.toMatchObject({
      role: "assistant",
      stopReason: "stop",
      usage,
    });
    const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body = JSON.parse(rawBody as string) as {
      model?: { headers?: unknown };
      options?: { headers?: unknown; promptCacheKey?: string };
    };
    expect(body.options).not.toHaveProperty("headers");
    expect(body.options?.promptCacheKey).toBeUndefined();
    expect(body.model).not.toHaveProperty("headers");
  });

  it("forwards prompt cache affinity separately from session identity", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      responseFromText(
        `data: ${JSON.stringify({
          type: "done",
          reason: "stop",
          usage,
        })}`,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
      sessionId: "run-session",
      promptCacheKey: "stable-cache-key",
    }).result();

    const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body = JSON.parse(rawBody as string) as {
      options?: { promptCacheKey?: string; sessionId?: string };
    };
    expect(body.options).toMatchObject({
      sessionId: "run-session",
      promptCacheKey: "stable-cache-key",
    });
  });

  it("returns an error result when EOF arrives without a terminal event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFromText(`data: ${JSON.stringify({ type: "start" })}`)),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("error");
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy stream ended before terminal event",
    });
  });
});
