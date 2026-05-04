import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { probeTelegram, resetTelegramProbeFetcherCacheForTests } from "./probe.js";

const resolveTelegramFetch = vi.hoisted(() => vi.fn());
const makeProxyFetch = vi.hoisted(() => vi.fn());

vi.mock("./fetch.js", () => ({
  resolveTelegramFetch,
  resolveTelegramApiBase: (apiRoot?: string) =>
    apiRoot?.trim()?.replace(/\/+$/, "") || "https://api.telegram.org",
}));

vi.mock("./proxy.js", () => ({
  makeProxyFetch,
}));

describe("probeTelegram retry logic", () => {
  const token = "test-token";
  const timeoutMs = 5000;
  const originalFetch = global.fetch;

  const installFetchMock = (): Mock => {
    const fetchMock = vi.fn();
    global.fetch = withFetchPreconnect(fetchMock);
    resolveTelegramFetch.mockImplementation((proxyFetch?: typeof fetch) => proxyFetch ?? fetch);
    makeProxyFetch.mockImplementation(() => fetchMock as unknown as typeof fetch);
    return fetchMock;
  };

  function mockGetMeSuccess(fetchMock: Mock) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          id: 123,
          is_bot: true,
          first_name: "Test",
          username: "test_bot",
          can_join_groups: true,
          can_read_all_group_messages: false,
          can_manage_bots: false,
          supports_inline_queries: false,
          can_connect_to_business: false,
          has_main_web_app: false,
          has_topics_enabled: false,
          allows_users_to_create_topics: false,
        },
      }),
    });
  }

  function mockGetWebhookInfoSuccess(fetchMock: Mock) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, result: { url: "" } }),
    });
  }

  async function expectSuccessfulProbe(fetchMock: Mock, expectedCalls: number, retryCount = 0) {
    const probePromise = probeTelegram(token, timeoutMs);
    if (retryCount > 0) {
      await vi.advanceTimersByTimeAsync(retryCount * 1000);
    }

    const result = await probePromise;
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(expectedCalls);
    expect(result.bot?.username).toBe("test_bot");
  }

  afterEach(() => {
    resetTelegramProbeFetcherCacheForTests();
    resolveTelegramFetch.mockReset();
    makeProxyFetch.mockReset();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });

  it.each([
    {
      errors: [],
      expectedCalls: 2,
      retryCount: 0,
    },
    {
      errors: ["Network timeout"],
      expectedCalls: 3,
      retryCount: 1,
    },
    {
      errors: ["Network error 1", "Network error 2"],
      expectedCalls: 4,
      retryCount: 2,
    },
  ])("succeeds after retry pattern %#", async ({ errors, expectedCalls, retryCount }) => {
    const fetchMock = installFetchMock();
    vi.useFakeTimers();
    try {
      for (const message of errors) {
        fetchMock.mockRejectedValueOnce(new Error(message));
      }

      mockGetMeSuccess(fetchMock);
      mockGetWebhookInfoSuccess(fetchMock);
      await expectSuccessfulProbe(fetchMock, expectedCalls, retryCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should fail after 3 unsuccessful attempts", async () => {
    const fetchMock = installFetchMock();
    vi.useFakeTimers();
    const errorMsg = "Final network error";
    try {
      fetchMock.mockRejectedValue(new Error(errorMsg));

      const probePromise = probeTelegram(token, timeoutMs);

      // Fast-forward for all retries
      await vi.advanceTimersByTimeAsync(2000);

      const result = await probePromise;

      expect(result.ok).toBe(false);
      expect(result.error).toBe(errorMsg);
      expect(fetchMock).toHaveBeenCalledTimes(3); // 3 attempts at getMe
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects timeout budget across retries", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new Error("Request aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("Request aborted")), {
          once: true,
        });
      });
    });
    global.fetch = withFetchPreconnect(fetchMock as unknown as typeof fetch);
    resolveTelegramFetch.mockImplementation((proxyFetch?: typeof fetch) => proxyFetch ?? fetch);
    makeProxyFetch.mockImplementation(() => fetchMock as unknown as typeof fetch);
    vi.useFakeTimers();
    try {
      const probePromise = probeTelegram(`${token}-budget`, 500);
      await vi.advanceTimersByTimeAsync(600);
      const result = await probePromise;

      expect(result.ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should NOT retry if getMe returns a 401 Unauthorized", async () => {
    const fetchMock = installFetchMock();
    const mockResponse = {
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({
        ok: false,
        description: "Unauthorized",
      }),
    };
    fetchMock.mockResolvedValueOnce(mockResponse);

    const result = await probeTelegram(token, timeoutMs);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("Unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1); // Should not retry
  });

  it("can skip webhook info when caller only needs bot identity", async () => {
    const fetchMock = installFetchMock();
    mockGetMeSuccess(fetchMock);

    const result = await probeTelegram(token, timeoutMs, { includeWebhookInfo: false });

    expect(result.ok).toBe(true);
    expect(result.webhook).toBeUndefined();
    expect(result.botInfo).toEqual(
      expect.objectContaining({
        id: 123,
        is_bot: true,
        first_name: "Test",
        username: "test_bot",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.telegram.org/bottest-token/getMe");
  });

  it("uses resolver-scoped Telegram fetch with probe network options", async () => {
    const fetchMock = installFetchMock();
    mockGetMeSuccess(fetchMock);
    mockGetWebhookInfoSuccess(fetchMock);

    await probeTelegram(token, timeoutMs, {
      proxyUrl: "http://127.0.0.1:8888",
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });

    expect(makeProxyFetch).toHaveBeenCalledWith("http://127.0.0.1:8888");
    expect(resolveTelegramFetch).toHaveBeenCalledWith(fetchMock, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });
  });

  it("reuses probe fetcher across repeated probes for the same account transport settings", async () => {
    const fetchMock = installFetchMock();
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");

    mockGetMeSuccess(fetchMock);
    mockGetWebhookInfoSuccess(fetchMock);
    await probeTelegram(`${token}-cache`, timeoutMs, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    mockGetMeSuccess(fetchMock);
    mockGetWebhookInfoSuccess(fetchMock);
    await probeTelegram(`${token}-cache`, timeoutMs, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    expect(resolveTelegramFetch).toHaveBeenCalledTimes(1);
  });

  it("does not reuse probe fetcher cache when network settings differ", async () => {
    const fetchMock = installFetchMock();
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");

    mockGetMeSuccess(fetchMock);
    mockGetWebhookInfoSuccess(fetchMock);
    await probeTelegram(`${token}-cache-variant`, timeoutMs, {
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    mockGetMeSuccess(fetchMock);
    mockGetWebhookInfoSuccess(fetchMock);
    await probeTelegram(`${token}-cache-variant`, timeoutMs, {
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });

    expect(resolveTelegramFetch).toHaveBeenCalledTimes(2);
  });

  it("reuses probe fetcher cache across token rotation when accountId is stable", async () => {
    const fetchMock = installFetchMock();
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");

    mockGetMeSuccess(fetchMock);
    mockGetWebhookInfoSuccess(fetchMock);
    await probeTelegram(`${token}-old`, timeoutMs, {
      accountId: "main",
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    mockGetMeSuccess(fetchMock);
    mockGetWebhookInfoSuccess(fetchMock);
    await probeTelegram(`${token}-new`, timeoutMs, {
      accountId: "main",
      network: {
        autoSelectFamily: true,
        dnsResultOrder: "ipv4first",
      },
    });

    expect(resolveTelegramFetch).toHaveBeenCalledTimes(1);
  });
});
