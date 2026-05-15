import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    config: { use: vi.fn() },
    sendMessage: vi.fn(),
    setMessageReaction: vi.fn(),
    deleteMessage: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));

const { makeProxyFetch } = vi.hoisted(() => ({
  makeProxyFetch: vi.fn(),
}));

const { resolveTelegramTransport } = vi.hoisted(() => ({
  resolveTelegramTransport: vi.fn(),
}));

const resolveTelegramApiBase = vi.hoisted(
  () => (apiRoot?: string) => apiRoot?.trim()?.replace(/\/+$/, "") || "https://api.telegram.org",
);

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return {
    ...actual,
    requireRuntimeConfig: (cfg: unknown) => cfg ?? loadConfig(),
  };
});

vi.mock("./proxy.js", () => ({
  makeProxyFetch,
}));

vi.mock("./fetch.js", () => ({
  resolveTelegramTransport,
  resolveTelegramApiBase,
}));

vi.mock("grammy", () => ({
  API_CONSTANTS: {
    DEFAULT_UPDATE_TYPES: ["message"],
    ALL_UPDATE_TYPES: ["message"],
  },
  Bot: class {
    api = botApi;
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch; timeoutSeconds?: number } },
    ) {
      botCtorSpy(token, options);
    }
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
  InputFile: function InputFile() {},
}));

let deleteMessageTelegram: typeof import("./send.js").deleteMessageTelegram;
let reactMessageTelegram: typeof import("./send.js").reactMessageTelegram;
let resetTelegramClientOptionsCacheForTests: typeof import("./send.js").resetTelegramClientOptionsCacheForTests;
let sendMessageTelegram: typeof import("./send.js").sendMessageTelegram;

describe("telegram proxy client", () => {
  const proxyUrl = "http://proxy.test:8080";
  const TELEGRAM_PROXY_CFG = {
    channels: { telegram: { accounts: { foo: { proxy: proxyUrl } } } },
  };

  const prepareProxyFetch = () => {
    const proxyFetch = vi.fn();
    const fetchImpl = vi.fn();
    makeProxyFetch.mockReturnValue(proxyFetch as unknown as typeof fetch);
    resolveTelegramTransport.mockReturnValue({
      fetch: fetchImpl as unknown as typeof fetch,
      sourceFetch: fetchImpl as unknown as typeof fetch,
      close: vi.fn(async () => undefined),
    });
    return { proxyFetch, fetchImpl };
  };

  const expectProxyClient = (params: { proxyFetch: ReturnType<typeof vi.fn> }) => {
    expect(makeProxyFetch).toHaveBeenCalledWith(proxyUrl);
    expect(resolveTelegramTransport).toHaveBeenCalledWith(params.proxyFetch, {
      network: undefined,
    });
    expect(botCtorSpy).toHaveBeenCalledWith("tok", {
      client: { fetch: expect.any(Function) },
    });
  };

  beforeAll(async () => {
    ({
      deleteMessageTelegram,
      reactMessageTelegram,
      resetTelegramClientOptionsCacheForTests,
      sendMessageTelegram,
    } = await import("./send.js"));
  });

  beforeEach(() => {
    resetTelegramClientOptionsCacheForTests();
    vi.unstubAllEnvs();
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    botApi.setMessageReaction.mockResolvedValue(undefined);
    botApi.deleteMessage.mockResolvedValue(true);
    botApi.config.use.mockClear();
    botCtorSpy.mockClear();
    loadConfig.mockReturnValue(TELEGRAM_PROXY_CFG);
    makeProxyFetch.mockClear();
    resolveTelegramTransport.mockClear();
  });

  it("reuses cached Telegram client options for repeated sends with same account transport settings", async () => {
    const { proxyFetch, fetchImpl } = prepareProxyFetch();
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");

    await sendMessageTelegram("123", "first", {
      cfg: TELEGRAM_PROXY_CFG,
      token: "tok",
      accountId: "foo",
    });
    await sendMessageTelegram("123", "second", {
      cfg: TELEGRAM_PROXY_CFG,
      token: "tok",
      accountId: "foo",
    });

    expect(makeProxyFetch).toHaveBeenCalledTimes(1);
    expect(resolveTelegramTransport).toHaveBeenCalledTimes(1);
    expect(botCtorSpy).toHaveBeenCalledTimes(2);
    expect(resolveTelegramTransport).toHaveBeenCalledWith(proxyFetch, { network: undefined });
    const firstOptions = botCtorSpy.mock.calls[0]?.[1];
    expect(firstOptions).toEqual({ client: { fetch: expect.any(Function) } });
    expect(botCtorSpy).toHaveBeenNthCalledWith(2, "tok", firstOptions);
  });

  it.each([
    {
      name: "sendMessage",
      run: () =>
        sendMessageTelegram("123", "hi", {
          cfg: TELEGRAM_PROXY_CFG,
          token: "tok",
          accountId: "foo",
        }),
    },
    {
      name: "reactions",
      run: () =>
        reactMessageTelegram("123", "456", "✅", {
          cfg: TELEGRAM_PROXY_CFG,
          token: "tok",
          accountId: "foo",
        }),
    },
    {
      name: "deleteMessage",
      run: () =>
        deleteMessageTelegram("123", "456", {
          cfg: TELEGRAM_PROXY_CFG,
          token: "tok",
          accountId: "foo",
        }),
    },
  ])("uses proxy fetch for $name", async (testCase) => {
    const { proxyFetch } = prepareProxyFetch();

    await testCase.run();

    expectProxyClient({ proxyFetch });
  });

  it("wraps direct delete clients with the Telegram deleteMessage request timeout", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = prepareProxyFetch();
    fetchImpl.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    await deleteMessageTelegram("123", "456", {
      cfg: TELEGRAM_PROXY_CFG,
      token: "tok",
      accountId: "foo",
    });
    const clientFetch = (botCtorSpy.mock.calls.at(-1)?.[1] as { client?: { fetch?: unknown } })
      ?.client?.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>;

    const resultPromise = clientFetch("https://api.telegram.org/bot123456:ABC/deleteMessage");
    const rejection = expect(resultPromise).rejects.toThrow(
      "Telegram deletemessage timed out after 15000ms",
    );
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
