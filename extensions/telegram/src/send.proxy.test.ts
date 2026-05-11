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

const { resolveTelegramFetch } = vi.hoisted(() => ({
  resolveTelegramFetch: vi.fn(),
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
  resolveTelegramFetch,
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
    resolveTelegramFetch.mockReturnValue(fetchImpl as unknown as typeof fetch);
    return { proxyFetch, fetchImpl };
  };

  const expectProxyClient = (params: {
    proxyFetch: ReturnType<typeof vi.fn>;
    fetchImpl: ReturnType<typeof vi.fn>;
  }) => {
    expect(makeProxyFetch).toHaveBeenCalledWith(proxyUrl);
    expect(resolveTelegramFetch).toHaveBeenCalledWith(params.proxyFetch, { network: undefined });
    expect(botCtorSpy).toHaveBeenCalledWith("tok", { client: { fetch: params.fetchImpl } });
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
    resolveTelegramFetch.mockClear();
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
    expect(resolveTelegramFetch).toHaveBeenCalledTimes(1);
    expect(botCtorSpy).toHaveBeenCalledTimes(2);
    expect(resolveTelegramFetch).toHaveBeenCalledWith(proxyFetch, { network: undefined });
    expect(botCtorSpy).toHaveBeenNthCalledWith(1, "tok", { client: { fetch: fetchImpl } });
    expect(botCtorSpy).toHaveBeenNthCalledWith(2, "tok", { client: { fetch: fetchImpl } });
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
    const { proxyFetch, fetchImpl } = prepareProxyFetch();

    await testCase.run();

    expectProxyClient({ proxyFetch, fetchImpl });
  });
});
