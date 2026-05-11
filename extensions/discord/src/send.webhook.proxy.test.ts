import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("sendWebhookMessageDiscord proxy support", () => {
  beforeEach(() => {
    makeProxyFetchMock.mockReset();
    vi.restoreAllMocks();
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

  it("uses global fetch when the Discord proxy URL is remote", async () => {
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-remote" }), { status: 200 }));

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

    expect(makeProxyFetchMock).not.toHaveBeenCalledWith("http://proxy.test:8080");
    expect(globalFetchMock).toHaveBeenCalled();
    globalFetchMock.mockRestore();
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
});
