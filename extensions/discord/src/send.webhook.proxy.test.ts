import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendWebhookMessageDiscord } from "./send.outbound.js";

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
});
