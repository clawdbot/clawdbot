import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTelegramChatId } from "./api-fetch.js";

const require = createRequire(import.meta.url);
const EnvHttpProxyAgent = require("undici/lib/dispatcher/env-http-proxy-agent.js") as {
  new (opts?: Record<string, unknown>): Record<PropertyKey, unknown>;
};
const { kHttpsProxyAgent, kNoProxyAgent } = require("undici/lib/core/symbols.js") as {
  kHttpsProxyAgent: symbol;
  kNoProxyAgent: symbol;
};
const proxyMocks = vi.hoisted(() => {
  const undiciFetch = vi.fn();
  const proxyAgentSpy = vi.fn();
  const setGlobalDispatcher = vi.fn();
  class ProxyAgent {
    static lastCreated: ProxyAgent | undefined;
    proxyUrl: string;
    constructor(proxyUrl: string) {
      this.proxyUrl = proxyUrl;
      ProxyAgent.lastCreated = this;
      proxyAgentSpy(proxyUrl);
    }
  }

  return {
    ProxyAgent,
    undiciFetch,
    proxyAgentSpy,
    setGlobalDispatcher,
    getLastAgent: () => ProxyAgent.lastCreated,
  };
});

let getProxyUrlFromFetch: typeof import("./proxy.js").getProxyUrlFromFetch;
let makeProxyFetch: typeof import("./proxy.js").makeProxyFetch;

function getOwnSymbolValue(
  target: Record<PropertyKey, unknown>,
  description: string,
): Record<string, unknown> | undefined {
  const symbol = Object.getOwnPropertySymbols(target).find(
    (entry) => entry.description === description,
  );
  const value = symbol ? target[symbol] : undefined;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

vi.mock("undici", () => ({
  ProxyAgent: proxyMocks.ProxyAgent,
  fetch: proxyMocks.undiciFetch,
  setGlobalDispatcher: proxyMocks.setGlobalDispatcher,
}));

describe("fetchTelegramChatId", () => {
  const cases = [
    {
      name: "returns stringified id when Telegram getChat succeeds",
      fetchImpl: vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, result: { id: 12345 } }),
      })),
      expected: "12345",
    },
    {
      name: "returns null when response is not ok",
      fetchImpl: vi.fn(async () => ({
        ok: false,
        json: async () => ({}),
      })),
      expected: null,
    },
    {
      name: "returns null on transport failures",
      fetchImpl: vi.fn(async () => {
        throw new Error("network failed");
      }),
      expected: null,
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, async () => {
      vi.stubGlobal("fetch", testCase.fetchImpl);

      const id = await fetchTelegramChatId({
        token: "abc",
        chatId: "@user",
      });

      expect(id).toBe(testCase.expected);
    });
  }

  it("calls Telegram getChat endpoint", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 12345 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchTelegramChatId({ token: "abc", chatId: "@user" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botabc/getChat?chat_id=%40user",
      undefined,
    );
  });

  it("uses caller-provided fetch impl when present", async () => {
    const customFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 12345 } }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("global fetch should not be called");
      }),
    );

    await fetchTelegramChatId({
      token: "abc",
      chatId: "@user",
      fetchImpl: customFetch as unknown as typeof fetch,
    });

    expect(customFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botabc/getChat?chat_id=%40user",
      undefined,
    );
  });
});

describe("undici env proxy semantics", () => {
  it("uses proxyTls rather than connect for proxied HTTPS transport settings", () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    const connect = {
      family: 4,
      autoSelectFamily: false,
    };

    const withoutProxyTls = new EnvHttpProxyAgent({ connect });
    const noProxyAgent = withoutProxyTls[kNoProxyAgent] as Record<PropertyKey, unknown>;
    const httpsProxyAgent = withoutProxyTls[kHttpsProxyAgent] as Record<PropertyKey, unknown>;

    expect(getOwnSymbolValue(noProxyAgent, "options")?.connect).toEqual(
      expect.objectContaining(connect),
    );
    expect(getOwnSymbolValue(httpsProxyAgent, "proxy tls settings")).toBeUndefined();

    const withProxyTls = new EnvHttpProxyAgent({
      connect,
      proxyTls: connect,
    });
    const httpsProxyAgentWithProxyTls = withProxyTls[kHttpsProxyAgent] as Record<
      PropertyKey,
      unknown
    >;

    expect(getOwnSymbolValue(httpsProxyAgentWithProxyTls, "proxy tls settings")).toEqual(
      expect.objectContaining(connect),
    );
  });
});

describe("makeProxyFetch", () => {
  beforeAll(async () => {
    ({ getProxyUrlFromFetch, makeProxyFetch } = await import("./proxy.js"));
  });

  beforeEach(() => {
    proxyMocks.undiciFetch.mockReset();
    proxyMocks.proxyAgentSpy.mockClear();
    proxyMocks.setGlobalDispatcher.mockClear();
  });

  it("attaches proxy metadata for resolver transport handling", () => {
    const proxyUrl = "http://proxy.test:8080";
    const proxyFetch = makeProxyFetch(proxyUrl);

    expect(getProxyUrlFromFetch(proxyFetch)).toBe(proxyUrl);
  });
});
