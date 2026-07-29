// Discord tests cover api plugin behavior.
import { createServer, type Server } from "node:http";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordApiError, fetchDiscord, requestDiscord } from "./api.js";
import { jsonResponse } from "./test-http-helpers.js";

const DISCORD_SUCCESS_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function stubDiscordFetchToLoopback(
  baseUrl: string,
  onResponse?: (response: Response) => void,
): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal(
    "fetch",
    withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
      const originalUrl = new URL(input instanceof Request ? input.url : String(input));
      expect(originalUrl.origin).toBe("https://discord.com");
      expect(originalUrl.pathname).toMatch(/^\/api\/v10\//);
      const loopbackUrl = new URL(`${originalUrl.pathname}${originalUrl.search}`, baseUrl);
      const response = await realFetch(loopbackUrl, init);
      onResponse?.(response);
      return response;
    }),
  );
}

describe("fetchDiscord", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("formats rate limit payloads without raw JSON", async () => {
    const fetcher = withFetchPreconnect(async () =>
      jsonResponse(
        {
          message: "You are being rate limited.",
          retry_after: 0.631,
          global: false,
        },
        429,
      ),
    );

    let error: unknown;
    try {
      await fetchDiscord("/users/@me/guilds", "test", fetcher, {
        retry: { attempts: 1 },
      });
    } catch (err) {
      error = err;
    }

    const message = String(error);
    expect(message).toContain("Discord API /users/@me/guilds failed (429)");
    expect(message).toContain("You are being rate limited.");
    expect(message).toContain("retry after 0.6s");
    expect(message).not.toContain("{");
    expect(message).not.toContain("retry_after");
  });

  it("preserves non-JSON error text", async () => {
    const fetcher = withFetchPreconnect(async () => new Response("Not Found", { status: 404 }));
    await expect(
      fetchDiscord("/users/@me/guilds", "test", fetcher, {
        retry: { attempts: 1 },
      }),
    ).rejects.toThrow("Discord API /users/@me/guilds failed (404): Not Found");
  });

  it("bounds Discord API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"discord api unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetcher = withFetchPreconnect(async () => tracked.response);

    let error: unknown;
    try {
      await fetchDiscord("/users/@me/guilds", "test", fetcher, {
        retry: { attempts: 1 },
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(DiscordApiError);
    expect(String(error)).toContain("Discord API /users/@me/guilds failed (503)");
    expect(String(error)).toContain("discord api unavailable");
    expect(String(error)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("sanitizes Cloudflare HTML rate limits and applies a fallback cooldown", async () => {
    const fetcher = withFetchPreconnect(
      async () =>
        new Response(
          "<!doctype html><html><head><title>Error 1015</title></head><body><h1>You are being rate limited</h1><script>raw()</script></body></html>",
          { status: 429, headers: { "content-type": "text/html" } },
        ),
    );

    let error: unknown;
    try {
      await fetchDiscord("/users/@me/guilds", "test", fetcher, {
        retry: { attempts: 1 },
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).retryAfter).toBe(60);
    const message = String(error);
    expect(message).toContain("Discord API /users/@me/guilds failed (429)");
    expect(message).toContain("rate limited by Discord upstream");
    expect(message).toContain("Error 1015");
    expect(message).not.toContain("<html");
    expect(message).not.toContain("<script");
  });

  it("honors Retry-After for Cloudflare HTML application lookup rate limits", async () => {
    const fetcher = withFetchPreconnect(
      async () =>
        new Response("<html><title>Error 1015</title><body>rate limited</body></html>", {
          status: 429,
          headers: { "content-type": "text/html", "retry-after": "7" },
        }),
    );

    let error: unknown;
    try {
      await fetchDiscord("/oauth2/applications/@me", "test", fetcher, {
        retry: { attempts: 1 },
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).retryAfter).toBe(7);
    const message = String(error);
    expect(message).toContain("Discord API /oauth2/applications/@me failed (429)");
    expect(message).toContain("Error 1015");
    expect(message).not.toContain("<html");
  });

  it.each([
    ["hex", "0x10"],
    ["fractional", "1.5"],
    ["unsafe-ms", "9007199254741"],
    ["unsafe-integer", "9007199254740993"],
    ["overflow", `1${"0".repeat(309)}`],
  ])("rejects invalid Retry-After header values: %s", async (_label, header) => {
    const fetcher = withFetchPreconnect(
      async () =>
        new Response("<html><title>Error 1015</title><body>rate limited</body></html>", {
          status: 429,
          headers: { "content-type": "text/html", "retry-after": header },
        }),
    );

    let error: unknown;
    try {
      await fetchDiscord("/oauth2/applications/@me", "test", fetcher, {
        retry: { attempts: 1 },
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).retryAfter).toBe(60);
  });

  it("ignores unsafe retry_after body values and falls back to Retry-After", async () => {
    const fetcher = withFetchPreconnect(
      async () =>
        new Response(
          JSON.stringify({
            message: "You are being rate limited.",
            retry_after: 9_007_199_254_741,
            global: false,
          }),
          { status: 429, headers: { "retry-after": "7" } },
        ),
    );

    let error: unknown;
    try {
      await fetchDiscord("/users/@me/guilds", "test", fetcher, {
        retry: { attempts: 1 },
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).retryAfter).toBe(7);
    expect(String(error)).not.toContain("retry after");
  });

  it("retries rate limits before succeeding", async () => {
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          {
            message: "You are being rate limited.",
            retry_after: 0,
            global: false,
          },
          429,
        );
      }
      return jsonResponse([{ id: "1", name: "Guild" }], 200);
    });

    const result = await fetchDiscord<Array<{ id: string; name: string }>>(
      "/users/@me/guilds",
      "test",
      fetcher,
      { retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 } },
    );

    expect(result).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("sends JSON request bodies through the shared retry helper", async () => {
    let request: RequestInit | undefined;
    const fetcher = withFetchPreconnect(async (_url, init) => {
      request = init;
      return jsonResponse({ id: "42" }, 200);
    });

    const result = await requestDiscord<{ id: string }>("/channels/c/messages", "test", {
      body: { content: "hello" },
      fetcher,
      retry: { attempts: 1 },
    });

    expect(result).toEqual({ id: "42" });
    if (!request) {
      throw new Error("expected Discord request init");
    }
    expect(request.method).toBe("POST");
    expect(request.body).toBe(JSON.stringify({ content: "hello" }));
    expect(new Headers(request.headers).get("content-type")).toBe("application/json");
  });

  it("caps oversized request timeouts before creating abort signals", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let request: RequestInit | undefined;
    const fetcher = withFetchPreconnect(async (_url, init) => {
      request = init;
      return jsonResponse({ id: "42" }, 200);
    });

    await requestDiscord<{ id: string }>("/channels/c/messages", "test", {
      fetcher,
      retry: { attempts: 1 },
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[0]?.value);
  });

  it("throws DiscordApiError on malformed JSON success response body", async () => {
    const fetcher = withFetchPreconnect(async () => new Response("NOT JSON {{{", { status: 200 }));

    let error: unknown;
    try {
      await fetchDiscord("/users/@me/guilds", "test", fetcher, {
        retry: { attempts: 1 },
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(DiscordApiError);
    expect(String(error)).toContain("Discord API /users/@me/guilds returned malformed JSON");
  });

  it("returns under-cap requestDiscord responses from a real loopback HTTP server", async () => {
    const payload = { id: "channel-42", name: "loopback", type: 0 };
    let contentLength: string | null | undefined;
    let requestUrl: string | undefined;
    let authorization: string | undefined;
    const server = createServer((req, res) => {
      requestUrl = req.url;
      authorization = req.headers.authorization;
      const body = JSON.stringify(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.write(body.slice(0, 12));
      res.end(body.slice(12));
    });
    const port = await listenLoopbackServer(server);

    try {
      stubDiscordFetchToLoopback(`http://127.0.0.1:${port}`, (response) => {
        contentLength = response.headers.get("content-length");
      });

      const result = await requestDiscord<typeof payload>("/channels/channel-42", "test-token", {
        retry: { attempts: 1 },
      });

      expect(result).toEqual(payload);
      expect(requestUrl).toBe("/api/v10/channels/channel-42");
      expect(authorization).toBe("Bot test-token");
      expect(contentLength).toBeNull();
      console.log(
        `[discord requestDiscord loopback proof] normal path: returned=${JSON.stringify(result)} content_length=${contentLength ?? "none"}`,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("rejects oversized valid JSON requestDiscord responses from a real loopback HTTP server", async () => {
    const oversizedPayloadBytes = DISCORD_SUCCESS_RESPONSE_LIMIT_BYTES + 256 * 1024;
    let contentLength: string | null | undefined;
    let requestUrl: string | undefined;
    let streamedBytes = 0;
    const server = createServer((req, res) => {
      requestUrl = req.url;
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"id":"');

      const writeMore = () => {
        while (streamedBytes < oversizedPayloadBytes) {
          if (res.destroyed) {
            return;
          }
          streamedBytes += chunk.byteLength;
          if (!res.write(chunk)) {
            res.once("drain", writeMore);
            return;
          }
        }
        res.end('"}');
      };

      writeMore();
    });
    const port = await listenLoopbackServer(server);

    try {
      stubDiscordFetchToLoopback(`http://127.0.0.1:${port}`, (response) => {
        contentLength = response.headers.get("content-length");
      });

      let error: unknown;
      try {
        await requestDiscord("/channels/123/messages", "test-token", {
          retry: { attempts: 1 },
        });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Discord API /channels/123/messages response body too large");
      expect(String(error)).toContain(`limit: ${DISCORD_SUCCESS_RESPONSE_LIMIT_BYTES} bytes`);
      expect(requestUrl).toBe("/api/v10/channels/123/messages");
      expect(contentLength).toBeNull();
      console.log(
        `[discord requestDiscord loopback proof] oversized path: cap=${DISCORD_SUCCESS_RESPONSE_LIMIT_BYTES} streamed>=${streamedBytes} content_length=${contentLength ?? "none"} rejected=${String(error)}`,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("aborts promptly during 429 retry backoff when the caller signal fires", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () =>
        jsonResponse({ message: "rate limited", retry_after: 30, global: false }, 429),
      );
      const controller = new AbortController();
      const request = requestDiscord("/users/@me/guilds", "test-token", {
        fetcher: withFetchPreconnect(fetcher),
        retry: { attempts: 3 },
        signal: controller.signal,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      controller.abort();

      await expect(request).rejects.toThrow(/abort/i);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
