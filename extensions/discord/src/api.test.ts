import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordApiError, fetchDiscord, requestDiscord } from "./api.js";
import { jsonResponse } from "./test-http-helpers.js";

describe("fetchDiscord", () => {
  beforeEach(() => {
    vi.useRealTimers();
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
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
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

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(request?.signal).toBe(timeoutController.signal);
  });
});
