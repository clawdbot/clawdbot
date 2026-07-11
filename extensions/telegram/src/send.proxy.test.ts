// Telegram tests cover send.proxy plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: (() => {
    const sendMessage = vi.fn();
    type RichMessageParams = {
      chat_id?: string | number;
      rich_message?: {
        markdown?: string;
        html?: string;
      };
      [key: string]: unknown;
    };
    return {
      config: { use: vi.fn() },
      getChat: vi.fn(),
      sendMessage,
      sendDocument: vi.fn(),
      setMessageReaction: vi.fn(),
      deleteMessage: vi.fn(),
      raw: {
        sendRichMessage: vi.fn(async (params: RichMessageParams) =>
          sendMessage(
            params.chat_id,
            params.rich_message?.markdown ?? params.rich_message?.html ?? "",
            Object.fromEntries(
              Object.entries(params).filter(([key]) => key !== "chat_id" && key !== "rich_message"),
            ),
          ),
        ),
      },
    };
  })(),
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

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));

const { maybePersistResolvedTelegramTarget } = vi.hoisted(() => ({
  maybePersistResolvedTelegramTarget: vi.fn(),
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

vi.mock("./send.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./send.runtime.js")>("./send.runtime.js");
  return {
    ...actual,
    loadWebMedia,
  };
});

vi.mock("./target-writeback.js", () => ({
  maybePersistResolvedTelegramTarget,
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
    botApi.getChat.mockResolvedValue({ id: "123" });
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    botApi.sendDocument.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    botApi.setMessageReaction.mockResolvedValue(undefined);
    botApi.deleteMessage.mockResolvedValue(true);
    loadWebMedia.mockReset();
    maybePersistResolvedTelegramTarget.mockReset();
    maybePersistResolvedTelegramTarget.mockResolvedValue(undefined);
    botApi.config.use.mockClear();
    botCtorSpy.mockClear();
    loadConfig.mockReturnValue(TELEGRAM_PROXY_CFG);
    makeProxyFetch.mockClear();
    resolveTelegramTransport.mockClear();
  });

  it("reuses cached Telegram client options for repeated sends with same account transport settings", async () => {
    const { proxyFetch, fetchImpl: _fetchImpl } = prepareProxyFetch();
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

  it("closes the evicted Telegram transport when the client options cache exceeds its limit", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    const closeSpies: Array<ReturnType<typeof vi.fn>> = [];
    makeProxyFetch.mockImplementation(() => vi.fn() as unknown as typeof fetch);
    resolveTelegramTransport.mockImplementation(() => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const close = vi.fn(async () => undefined);
      closeSpies.push(close);
      return {
        fetch: fetchImpl,
        sourceFetch: fetchImpl,
        close,
      };
    });
    const cfg = {
      channels: {
        telegram: {
          accounts: Object.fromEntries(
            Array.from({ length: 65 }, (_unused, index) => [
              `acct-${index}`,
              { proxy: `http://proxy-${index}.test:8080` },
            ]),
          ),
        },
      },
    };

    for (let index = 0; index < 65; index += 1) {
      await sendMessageTelegram("123", `message ${index}`, {
        cfg,
        token: "tok",
        accountId: `acct-${index}`,
      });
    }

    expect(resolveTelegramTransport).toHaveBeenCalledTimes(65);
    expect(closeSpies[0]).toHaveBeenCalledTimes(1);
    expect(closeSpies.slice(1).every((close) => close.mock.calls.length === 0)).toBe(true);
  });

  it.each([
    {
      name: "an active send finishes",
      setupFirstSend: () => {
        let resolveFirstSend: (value: {
          message_id: number;
          chat: { id: string };
        }) => void = () => {};
        botApi.sendMessage.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirstSend = resolve;
            }),
        );
        return {
          waitUntilActive: async () => {
            await vi.waitFor(() => expect(botApi.sendMessage).toHaveBeenCalledTimes(1));
          },
          finish: async () => {
            resolveFirstSend({ message_id: 1, chat: { id: "123" } });
          },
        };
      },
    },
    {
      name: "a retryable send is waiting between attempts",
      setupFirstSend: () => {
        vi.useFakeTimers();
        botApi.sendMessage
          .mockRejectedValueOnce({
            error_code: 429,
            description: "Too Many Requests: retry after 1",
            parameters: { retry_after: 1 },
          })
          .mockResolvedValueOnce({ message_id: 1, chat: { id: "123" } });
        return {
          waitUntilActive: async () => {
            await vi.waitFor(() => expect(botApi.sendMessage).toHaveBeenCalledTimes(1));
          },
          finish: async () => {
            await vi.advanceTimersByTimeAsync(1000);
            await vi.waitFor(() => expect(botApi.sendMessage).toHaveBeenCalledTimes(66));
            vi.useRealTimers();
          },
        };
      },
    },
  ])("defers closing an evicted Telegram transport until $name", async ({ setupFirstSend }) => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    const closeSpies: Array<ReturnType<typeof vi.fn>> = [];
    makeProxyFetch.mockImplementation(() => vi.fn() as unknown as typeof fetch);
    resolveTelegramTransport.mockImplementation(() => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const close = vi.fn(async () => undefined);
      closeSpies.push(close);
      return {
        fetch: fetchImpl,
        sourceFetch: fetchImpl,
        close,
      };
    });
    const cfg = {
      channels: {
        telegram: {
          accounts: Object.fromEntries(
            Array.from({ length: 65 }, (_unused, index) => [
              `acct-${index}`,
              { proxy: `http://proxy-${index}.test:8080` },
            ]),
          ),
        },
      },
    };
    botApi.sendMessage.mockClear();
    const firstSendControl = setupFirstSend();

    const firstSend = sendMessageTelegram("123", "first", {
      cfg,
      token: "tok",
      accountId: "acct-0",
      retry: { attempts: 2, minDelayMs: 1000, maxDelayMs: 1000, jitter: 0 },
    });
    await firstSendControl.waitUntilActive();

    await Promise.all(
      Array.from({ length: 64 }, (_unused, index) =>
        sendMessageTelegram("123", `message ${index + 1}`, {
          cfg,
          token: "tok",
          accountId: `acct-${index + 1}`,
        }),
      ),
    );

    expect(resolveTelegramTransport).toHaveBeenCalledTimes(65);
    expect(closeSpies[0]).not.toHaveBeenCalled();

    await firstSendControl.finish();
    await firstSend;

    expect(closeSpies[0]).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("defers closing an evicted Telegram transport while media loads before the first API request", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    const closeSpies: Array<ReturnType<typeof vi.fn>> = [];
    makeProxyFetch.mockImplementation(() => vi.fn() as unknown as typeof fetch);
    resolveTelegramTransport.mockImplementation(() => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const close = vi.fn(async () => undefined);
      closeSpies.push(close);
      return {
        fetch: fetchImpl,
        sourceFetch: fetchImpl,
        close,
      };
    });
    const cfg = {
      channels: {
        telegram: {
          accounts: Object.fromEntries(
            Array.from({ length: 65 }, (_unused, index) => [
              `acct-${index}`,
              { proxy: `http://proxy-${index}.test:8080` },
            ]),
          ),
        },
      },
    };
    let resolveMedia: (value: {
      buffer: Buffer;
      contentType: string;
      fileName: string;
    }) => void = () => {};
    loadWebMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMedia = resolve;
        }),
    );

    const firstSend = sendMessageTelegram("123", "caption", {
      cfg,
      token: "tok",
      accountId: "acct-0",
      mediaUrl: "file:///tmp/example.bin",
      forceDocument: true,
    });
    await vi.waitFor(() => expect(loadWebMedia).toHaveBeenCalledTimes(1));

    await Promise.all(
      Array.from({ length: 64 }, (_unused, index) =>
        sendMessageTelegram("123", `message ${index + 1}`, {
          cfg,
          token: "tok",
          accountId: `acct-${index + 1}`,
        }),
      ),
    );

    expect(resolveTelegramTransport).toHaveBeenCalledTimes(65);
    expect(closeSpies[0]).not.toHaveBeenCalled();

    resolveMedia({
      buffer: Buffer.from("file"),
      contentType: "application/octet-stream",
      fileName: "example.bin",
    });
    await firstSend;

    expect(botApi.sendDocument).toHaveBeenCalledTimes(1);
    expect(closeSpies[0]).toHaveBeenCalledTimes(1);
  });

  it("defers closing an evicted Telegram transport while reactions persist a resolved target before the first action request", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    const closeSpies: Array<ReturnType<typeof vi.fn>> = [];
    makeProxyFetch.mockImplementation(() => vi.fn() as unknown as typeof fetch);
    resolveTelegramTransport.mockImplementation(() => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const close = vi.fn(async () => undefined);
      closeSpies.push(close);
      return {
        fetch: fetchImpl,
        sourceFetch: fetchImpl,
        close,
      };
    });
    const cfg = {
      channels: {
        telegram: {
          accounts: Object.fromEntries(
            Array.from({ length: 65 }, (_unused, index) => [
              `acct-${index}`,
              { proxy: `http://proxy-${index}.test:8080` },
            ]),
          ),
        },
      },
    };
    let resolvePersist: () => void = () => {};
    maybePersistResolvedTelegramTarget.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePersist = resolve;
        }),
    );

    const firstReaction = reactMessageTelegram("@target", "456", "✅", {
      cfg,
      token: "tok",
      accountId: "acct-0",
    });
    await vi.waitFor(() => expect(maybePersistResolvedTelegramTarget).toHaveBeenCalledTimes(1));

    await Promise.all(
      Array.from({ length: 64 }, (_unused, index) =>
        reactMessageTelegram("123", "456", "✅", {
          cfg,
          token: "tok",
          accountId: `acct-${index + 1}`,
        }),
      ),
    );

    expect(resolveTelegramTransport).toHaveBeenCalledTimes(65);
    expect(closeSpies[0]).not.toHaveBeenCalled();

    resolvePersist();
    await firstReaction;

    expect(botApi.setMessageReaction).toHaveBeenCalledTimes(65);
    expect(closeSpies[0]).toHaveBeenCalledTimes(1);
  });

  it("does not allocate cached client transport when a Telegram API override is provided", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");

    await reactMessageTelegram("123", "456", "✅", {
      cfg: TELEGRAM_PROXY_CFG,
      token: "tok",
      accountId: "foo",
      api: botApi as unknown as Parameters<typeof reactMessageTelegram>[3]["api"],
    });

    expect(makeProxyFetch).not.toHaveBeenCalled();
    expect(resolveTelegramTransport).not.toHaveBeenCalled();
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
          signal.addEventListener(
            "abort",
            () => reject(toLintErrorObject(signal.reason, "Non-Error rejection")),
            { once: true },
          );
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

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
