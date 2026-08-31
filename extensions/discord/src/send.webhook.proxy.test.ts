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
    vi.useRealTimers();
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

  it.each([
    {
      title: "uses proxy fetch when a Discord proxy is configured",
      messageId: "msg-1",
      proxyUrl: "http://127.0.0.1:8080",
    },
    {
      title: "uses proxy fetch when the Discord proxy is a DNS host",
      messageId: "msg-dns",
      proxyUrl: "http://mitm-proxy:8080",
    },
    {
      title: "uses proxy fetch when the Discord proxy URL is arbitrary DNS",
      messageId: "msg-remote",
      proxyUrl: "http://proxy.test:8080",
    },
    {
      title: "uses proxy fetch when the Discord proxy URL is a non-loopback IP",
      messageId: "msg-remote",
      proxyUrl: "http://10.0.0.10:8080",
    },
  ])("$title", async ({ messageId, proxyUrl }) => {
    const proxiedFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: messageId }), { status: 200 }));
    makeProxyFetchMock.mockReturnValue(proxiedFetch);

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: proxyUrl,
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

    expect(makeProxyFetchMock).toHaveBeenCalledWith(proxyUrl);
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

  it.each([
    { input: "Run `notify @OpsLead", expected: "Run `notify @OpsLead" },
    {
      input: "literal \\` ping @OpsLead",
      expected: "literal \\` ping <@123456789012345678>",
    },
  ])("only rewrites webhook mentions outside inline code: $input", async ({ input, expected }) => {
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-code" }), { status: 200 }));

    await sendWebhookMessageDiscord(input, {
      cfg: {
        channels: {
          discord: {
            token: "Bot test-token",
            mentionAliases: { opslead: "123456789012345678" },
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(globalFetchMock.mock.calls[0]?.[1]?.body).toContain(
      `"content":${JSON.stringify(expected)}`,
    );
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

  it("retries rate-limited webhook sends after the Discord retry-after delay", async () => {
    vi.useFakeTimers();
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Slow down", retry_after: 0.75, global: false }), {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-retried", channel_id: "thread-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const sent = sendWebhookMessageDiscord("hello", {
      cfg: { channels: { discord: { token: "Bot test-token" } } } as OpenClawConfig,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      threadId: "thread-1",
      wait: true,
    });
    const outcome = sent.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await vi.advanceTimersByTimeAsync(749);
    expect(globalFetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(outcome).resolves.toMatchObject({
      ok: true,
      value: { messageId: "msg-retried", channelId: "thread-1" },
    });
    expect(globalFetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries proven pre-connect webhook failures", async () => {
    vi.useFakeTimers();
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg-connected", channel_id: "thread-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const sent = sendWebhookMessageDiscord("hello", {
      cfg: { channels: { discord: { token: "Bot test-token" } } } as OpenClawConfig,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });
    const outcome = sent.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(outcome).resolves.toMatchObject({
      ok: true,
      value: { messageId: "msg-connected" },
    });
    expect(globalFetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries ambiguous webhook server failures that could duplicate a message", async () => {
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "unexpected-duplicate" }), { status: 200 }),
      );

    await expect(
      sendWebhookMessageDiscord("hello", {
        cfg: { channels: { discord: { token: "Bot test-token" } } } as OpenClawConfig,
        accountId: "default",
        webhookId: "123",
        webhookToken: "abc",
        wait: true,
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(globalFetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws typed rate limit errors for webhook 429 responses", async () => {
    const globalFetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({ message: "Slow down", retry_after: 0.25, global: false }),
        {
          status: 429,
        },
      );
    });

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
