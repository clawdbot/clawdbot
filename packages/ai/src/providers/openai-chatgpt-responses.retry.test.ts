// ChatGPT Responses provider tests cover stream handling and timeout behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import {
  closeOpenAICodexWebSocketSessions,
  parseSSEForTest,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";
import { installTestModelWebSocketHost } from "./openai-chatgpt-responses.test-websocket.js";

beforeEach(installTestModelWebSocketHost);

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function stubTimeoutSignal(timeoutMs: number): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
    expect(actualTimeoutMs).toBe(timeoutMs);
    const controller = new AbortController();
    queueMicrotask(() => {
      controller.abort(new DOMException("timed out", "TimeoutError"));
    });
    return controller.signal;
  });
}

function stubHangingFetch(timeoutMs: number): void {
  stubTimeoutSignal(timeoutMs);

  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }

          const abort = () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("aborted", "AbortError"),
            );
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
        }),
    ),
  );
}

describe("streamOpenAICodexResponses transport", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
  });

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

  it("omits ChatGPT tool controls when every tool schema is unreadable", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const stream = streamOpenAICodexResponses(
      model,
      {
        ...context,
        tools: [
          {
            name: "broken",
            description: "Broken tool.",
            get parameters(): never {
              throw new Error("parameters exploded");
            },
          },
        ],
      },
      {
        apiKey: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-1",
          },
        }),
        transport: "sse",
        onPayload: (payload) => {
          capturedPayload = payload as Record<string, unknown>;
          throw new Error("stop after payload");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedPayload).not.toHaveProperty("tools");
    expect(capturedPayload).not.toHaveProperty("tool_choice");
    expect(capturedPayload).not.toHaveProperty("parallel_tool_calls");
  });

  it("does not reread an unreadable ChatGPT tool inventory length", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const tools = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("length exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const stream = streamOpenAICodexResponses(model, { ...context, tools } as never, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      transport: "sse",
      onPayload: (payload) => {
        capturedPayload = payload as Record<string, unknown>;
        throw new Error("stop after payload");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedPayload).not.toHaveProperty("tools");
    expect(capturedPayload).not.toHaveProperty("tool_choice");
    expect(capturedPayload).not.toHaveProperty("parallel_tool_calls");
  });

  it("caps oversized timeoutMs before creating request abort signals", async () => {
    stubHangingFetch(MAX_TIMER_TIMEOUT_MS);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      timeoutMs: Number.MAX_SAFE_INTEGER,
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(`Request timed out after ${MAX_TIMER_TIMEOUT_MS}ms`);
  });

  it("honors timeoutMs for default websocket transport requests", async () => {
    stubTimeoutSignal(5);
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not run before websocket timeout");
    });
    class HangingWebSocket {
      send = vi.fn();
      close = vi.fn();
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", HangingWebSocket);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      timeoutMs: 5,
    });

    const result = await stream.result();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Request timed out after 5ms");
  });

  it("times out default websocket streams when no first event arrives", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => {
        throw new Error("fetch should not run after websocket first-event timeout");
      });
      const sendMock = vi.fn();
      const closeMock = vi.fn();
      class OpenNoMessageWebSocket {
        send = sendMock;
        close = closeMock;
        addEventListener(type: string, listener: (event: unknown) => void): void {
          if (type === "open") {
            queueMicrotask(() => listener({}));
          }
        }
        removeEventListener(): void {}
      }
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("WebSocket", OpenNoMessageWebSocket);
      const onFirstEventTimeout = vi.fn();

      const stream = streamOpenAICodexResponses(model, context, {
        apiKey: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-1",
          },
        }),
        firstEventTimeoutMs: 5,
        onFirstEventTimeout,
      } as Parameters<typeof streamOpenAICodexResponses>[2] & {
        firstEventTimeoutMs: number;
        onFirstEventTimeout: (reason: Error) => void;
      });
      const resultPromise = stream.result();

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5);
      const result = await resultPromise;

      expect(fetchMock).not.toHaveBeenCalled();
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(closeMock).toHaveBeenCalled();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(
        /responses HTTP stream opened but did not deliver a first SSE event within 5ms/,
      );
      expect(onFirstEventTimeout).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send websocket payload after timeout fires during connect", async () => {
    let timeoutController: AbortController | undefined;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
      expect(actualTimeoutMs).toBe(5);
      timeoutController = new AbortController();
      return timeoutController.signal;
    });
    const sendMock = vi.fn();
    class OpeningThenTimedOutWebSocket {
      send = sendMock;
      close = vi.fn();
      addEventListener(type: string, listener: (event: unknown) => void): void {
        if (type === "open") {
          queueMicrotask(() => {
            listener({});
            timeoutController?.abort(new DOMException("timed out", "TimeoutError"));
          });
        }
      }
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", OpeningThenTimedOutWebSocket);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      timeoutMs: 5,
    });

    const result = await stream.result();

    expect(sendMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Request timed out after 5ms");
  });

  it("strips the internal cache boundary marker from request instructions", async () => {
    let capturedPayload: { instructions?: string } | undefined;
    const stream = streamOpenAICodexResponses(
      model,
      {
        systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      },
      {
        apiKey: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-1",
          },
        }),
        transport: "sse",
        onPayload: (payload) => {
          capturedPayload = payload as typeof capturedPayload;
          throw new Error("stop after payload");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedPayload?.instructions).toBe("Stable\nDynamic");
    expect(JSON.stringify(capturedPayload)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });

  it("falls back to the default instructions when no system prompt is set", async () => {
    let capturedPayload: { instructions?: string } | undefined;
    const stream = streamOpenAICodexResponses(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      {
        apiKey: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-1",
          },
        }),
        transport: "sse",
        onPayload: (payload) => {
          capturedPayload = payload as typeof capturedPayload;
          throw new Error("stop after payload");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedPayload?.instructions).toBe("You are a helpful assistant.");
  });

  it("prefers promptCacheKey over sessionId for request cache affinity", async () => {
    let payload: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("usage limit: stop after payload");
      }),
    );

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      sessionId: "run-session",
      promptCacheKey: "stable-cache-key",
      transport: "sse",
      onPayload: (nextPayload) => {
        payload = nextPayload;
      },
    });

    await stream.result();

    expect(payload).toMatchObject({ prompt_cache_key: "stable-cache-key" });
  });

  it("does not retry the ChatGPT transport when maxRetries is zero", async () => {
    const jwt = createJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: jwt,
      maxRetries: 0,
      transport: "sse",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it.each([
    "1.5",
    "0x10",
    "Sun, 31 Feb 2027 00:00:00 GMT",
    "Sunday, 31-Feb-27 00:00:00 GMT",
    "Mon, 06 Nov 1994 08:49:37 GMT",
    "Monday, 06-Nov-94 08:49:37 GMT",
  ])("ignores invalid Retry-After header delay values: %s", async (retryAfter) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": retryAfter },
        }),
      )
      .mockRejectedValueOnce(new Error("usage limit: stop after retry delay"));
    vi.stubGlobal("fetch", fetchMock);
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === "function") {
          callback();
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  it("honors retry-after-ms ahead of Retry-After", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after-ms": "1250", "retry-after": "9" },
        }),
      )
      .mockRejectedValueOnce(new Error("usage limit: stop after retry delay"));
    vi.stubGlobal("fetch", fetchMock);
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === "function") {
          callback();
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1250);
  });

  it("honors RFC 850 Retry-After years within the 50-year future window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-06T00:00:00.000Z"));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "Sunday, 06-Nov-50 00:00:00 GMT" },
        }),
      )
      .mockRejectedValueOnce(new Error("usage limit: stop after retry delay"));
    vi.stubGlobal("fetch", fetchMock);
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === "function") {
          callback();
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("caps oversized Retry-After delays before sleeping", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": String(Number.MAX_SAFE_INTEGER) },
        }),
      )
      .mockRejectedValueOnce(new Error("usage limit: stop after retry delay"));
    vi.stubGlobal("fetch", fetchMock);
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === "function") {
          callback();
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("bounds non-OK ChatGPT response bodies before formatting API errors", async () => {
    const byteLimit = 16 * 1024;
    const totalChunks = 32;
    const prefix = "usage limit ";
    const chunk = new TextEncoder().encode(
      `${prefix}${"x".repeat(byteLimit - prefix.length - 2)}😀tail`,
    );
    let pullCount = 0;
    let canceled = false;
    const overflowing = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount > totalChunks) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(overflowing, {
        status: 400,
        statusText: "Bad Request",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("usage limit");
    expect(result.errorMessage).not.toContain("�");
    expect(result.errorMessage).not.toContain("tail");
    expect(result.errorMessage?.length).toBeLessThanOrEqual(16 * 1024);
    expect(canceled).toBe(true);
    expect(pullCount).toBeGreaterThanOrEqual(1);
    expect(pullCount).toBeLessThanOrEqual(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("parseSSEForTest", () => {
  it("bounds streamed OpenAI ChatGPT Responses success bodies without content-length", async () => {
    // 1 MiB chunks; cap is 16 MiB so the bounded reader cancels well before
    // draining the full 32 MiB advertised body.
    const CHUNK = 1024 * 1024;
    const TOTAL = 32;
    let pullCount = 0;
    let cancelReason: unknown;
    const overflowing = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount > TOTAL) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    let caught: Error | null = null;
    try {
      // parseSSE expects a Response-like; pass the streaming body directly
      // through a minimal Response shim that only exposes .body.
      const response = { body: overflowing } as unknown as Response;
      for await (const event of parseSSEForTest(response)) {
        expect(event).toBeDefined();
      }
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(
      /OpenAI ChatGPT Responses success body exceeded 16777216 bytes/,
    );
    expect(cancelReason).toBeInstanceOf(Error);
    // 16 MiB + a couple of overshoot pulls, well under 32.
    expect(pullCount).toBeGreaterThanOrEqual(17);
    expect(pullCount).toBeLessThanOrEqual(20);
  });
});
