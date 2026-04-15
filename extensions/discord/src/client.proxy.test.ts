import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { createDiscordRestClient } from "./client.js";

const makeProxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/infra-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/infra-runtime")>(
    "openclaw/plugin-sdk/infra-runtime",
  );
  makeProxyFetchMock.mockImplementation((proxyUrl: string) => {
    if (proxyUrl === "bad-proxy") {
      throw new Error("bad proxy");
    }
    return actual.makeProxyFetch(proxyUrl);
  });
  return {
    ...actual,
    makeProxyFetch: makeProxyFetchMock,
  };
});

describe("createDiscordRestClient proxy support", () => {
  beforeEach(() => {
    makeProxyFetchMock.mockClear();
  });

  it("injects a custom fetch into RequestClient when a Discord proxy is configured", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://127.0.0.1:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({}, cfg);
    const requestClient = rest as unknown as {
      customFetch?: typeof fetch;
      options?: { fetch?: typeof fetch };
    };

    expect(requestClient.options?.fetch).toEqual(expect.any(Function));
    expect(requestClient.customFetch).toBe(requestClient.options?.fetch);
  });

  it("does not inject fetch when no proxy is configured", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({}, cfg);
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(requestClient.options?.fetch).toBeUndefined();
  });

  it("falls back to direct fetch when the Discord proxy URL is invalid", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "bad-proxy",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({}, cfg);
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).not.toHaveBeenCalledWith("bad-proxy");
    expect(requestClient.options?.fetch).toBeUndefined();
  });

  it("falls back to direct fetch when the Discord proxy URL is remote", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://proxy.test:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({}, cfg);
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).not.toHaveBeenCalledWith("http://proxy.test:8080");
    expect(requestClient.options?.fetch).toBeUndefined();
  });

  it("accepts IPv6 loopback Discord proxy URLs", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://[::1]:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({}, cfg);
    const requestClient = rest as unknown as {
      options?: { fetch?: typeof fetch };
    };

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://[::1]:8080");
    expect(requestClient.options?.fetch).toEqual(expect.any(Function));
  });
});
