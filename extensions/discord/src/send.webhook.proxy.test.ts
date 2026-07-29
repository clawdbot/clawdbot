// Discord tests cover send.webhook.proxy plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordError, RateLimitError } from "./internal/rest-errors.js";
import { sendWebhookMessageDiscord } from "./send.webhook.js";

const makeProxyFetchMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/fetch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/fetch-runtime")>(
    "openclaw/plugin-sdk/fetch-runtime",
  );
  return {
    ...actual,
    makeProxyFetch: makeProxyFetchMock,
  };
});

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

describe("sendWebhookMessageDiscord proxy support", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    makeProxyFetchMock.mockReset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to global fetch when the Discord proxy URL is invalid", async () => {
    makeProxyFetchMock.mockImplementation(() => {
      throw new Error("bad proxy");
    });
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-0" }), { status: 200 }));

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "bad-proxy",
        },
      },
    } as OpenClawConfig;

    await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(makeProxyFetchMock).not.toHaveBeenCalledWith("bad-proxy");
    expect(globalFetchMock).toHaveBeenCalled();
    globalFetchMock.mockRestore();
  });

  it("uses proxy fetch when a Discord proxy is configured", async () => {
    const proxiedFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-1" }), { status: 200 }));
    makeProxyFetchMock.mockReturnValue(proxiedFetch);

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://127.0.0.1:8080",
        },
      },
    } as OpenClawConfig;

    await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://127.0.0.1:8080");
    expect(proxiedFetch).toHaveBeenCalledOnce();
  });

  it("uses proxy fetch when the Discord proxy is a DNS host", async () => {
    const proxiedFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-dns" }), { status: 200 }));
    makeProxyFetchMock.mockReturnValue(proxiedFetch);

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://mitm-proxy:8080",
        },
      },
    } as OpenClawConfig;

    await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://mitm-proxy:8080");
    expect(proxiedFetch).toHaveBeenCalledOnce();
  });

  it("uses proxy fetch when the Discord proxy URL is arbitrary DNS", async () => {
    const proxiedFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-remote" }), { status: 200 }));
    makeProxyFetchMock.mockReturnValue(proxiedFetch);

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://proxy.test:8080",
        },
      },
    } as OpenClawConfig;

    await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(proxiedFetch).toHaveBeenCalledOnce();
  });

  it("uses proxy fetch when the Discord proxy URL is a non-loopback IP", async () => {
    const proxiedFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-remote" }), { status: 200 }));
    makeProxyFetchMock.mockReturnValue(proxiedFetch);

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://10.0.0.10:8080",
        },
      },
    } as OpenClawConfig;

    await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://10.0.0.10:8080");
    expect(proxiedFetch).toHaveBeenCalledOnce();
  });

  it("uses global fetch when no proxy is configured", async () => {
    makeProxyFetchMock.mockReturnValue(undefined);
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-2" }), { status: 200 }));

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(globalFetchMock).toHaveBeenCalled();
    globalFetchMock.mockRestore();
  });

  it("accepts Discord's no-body webhook response when wait is false", async () => {
    const response = new Response(null, { status: 204 });
    const jsonSpy = vi.spyOn(response, "json");
    const globalFetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const result = await sendWebhookMessageDiscord("hello", {
      cfg: { channels: { discord: { token: "Bot test-token" } } } as OpenClawConfig,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: false,
    });

    expect(result.messageId).toBe("unknown");
    expect(jsonSpy).not.toHaveBeenCalled();
    globalFetchMock.mockRestore();
  });

  it("keeps a successful send when the webhook response body exceeds the limit", async () => {
    const tracked = cancelTrackedResponse(`{"id":"${"x".repeat(16 * 1024 * 1024)}"}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const globalFetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(tracked.response);

    const result = await sendWebhookMessageDiscord("hello", {
      cfg: { channels: { discord: { token: "Bot test-token" } } } as OpenClawConfig,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(result.messageId).toBe("unknown");
    expect(tracked.wasCanceled()).toBe(true);
    globalFetchMock.mockRestore();
  });

  it("keeps a successful send when the webhook response body is malformed", async () => {
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("not json", { status: 200 }));

    const result = await sendWebhookMessageDiscord("hello", {
      cfg: { channels: { discord: { token: "Bot test-token" } } } as OpenClawConfig,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(result.messageId).toBe("unknown");
    globalFetchMock.mockRestore();
  });

  it("throws typed rate limit errors for webhook 429 responses", async () => {
    const globalFetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Slow down", retry_after: 0.25, global: false }), {
        status: 429,
      }),
    );

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    const thrown = await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(RateLimitError);
    const error = thrown as RateLimitError;
    expect(error.name).toBe("RateLimitError");
    expect(error.status).toBe(429);
    expect(error.statusCode).toBe(429);
    expect(error.retryAfter).toBe(0.25);
    expect(error.scope).toBeNull();
    expect(error.bucket).toBeNull();
    expect(error.message).toBe("Slow down");
    expect(error.rawBody).toEqual({
      message: "Slow down",
      retry_after: 0.25,
      code: undefined,
      global: false,
    });
    globalFetchMock.mockRestore();
  });

  it("throws typed status errors for webhook server failures", async () => {
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("upstream unavailable", { status: 503 }));

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    const thrown = await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(DiscordError);
    expect(thrown).not.toBeInstanceOf(RateLimitError);
    const error = thrown as DiscordError;
    expect(error.name).toBe("DiscordError");
    expect(error.status).toBe(503);
    expect(error.statusCode).toBe(503);
    expect(error.message).toBe("upstream unavailable");
    expect(error.rawBody).toEqual({ message: "upstream unavailable" });
    globalFetchMock.mockRestore();
  });

  it("bounds webhook error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"upstream unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const globalFetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(tracked.response);

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    const thrown = await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(DiscordError);
    const error = thrown as DiscordError;
    expect(error.message).toContain("upstream unavailable");
    expect(JSON.stringify(error.rawBody)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    globalFetchMock.mockRestore();
  });
});
