// Telegram tests cover api fetch plugin behavior.
import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTelegramChatId, lookupTelegramChatId } from "./api-fetch.js";

const TELEGRAM_GETCHAT_JSON_CAP_BYTES = 4 * 1024 * 1024;

function getChatOkResponse(id: number | string): Response {
  return new Response(JSON.stringify({ ok: true, result: { id } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function oversizedTelegramGetChatJsonResponse(onCancel: () => void): Response {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(TELEGRAM_GETCHAT_JSON_CAP_BYTES + 1));
      },
      cancel() {
        onCancel();
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
  Object.defineProperty(response, "json", {
    value: async () => {
      throw new Error("unbounded json reader was used");
    },
  });
  return response;
}

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    ProxyAgent: proxyMocks.ProxyAgent,
    fetch: proxyMocks.undiciFetch,
    setGlobalDispatcher: proxyMocks.setGlobalDispatcher,
  };
});

describe("fetchTelegramChatId", () => {
  const cases = [
    {
      name: "returns stringified id when Telegram getChat succeeds",
      fetchImpl: vi.fn(async () => getChatOkResponse(12345)),
      expected: "12345",
    },
    {
      name: "returns null when response is not ok",
      fetchImpl: vi.fn(async () => new Response("{}", { status: 404 })),
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
    const fetchMock = vi.fn(async () => getChatOkResponse(12345));
    vi.stubGlobal("fetch", fetchMock);

    await fetchTelegramChatId({ token: "abc", chatId: "@user" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botabc/getChat?chat_id=%40user",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("uses caller-provided fetch impl when present", async () => {
    const customFetch = vi.fn(async () => getChatOkResponse(12345));
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns null for oversized getChat JSON responses and cancels the stream", async () => {
    let cancelCount = 0;
    const fetchImpl = vi.fn(async () =>
      oversizedTelegramGetChatJsonResponse(() => {
        cancelCount += 1;
      }),
    );

    await expect(
      fetchTelegramChatId({
        token: "abc",
        chatId: "@user",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
    expect(cancelCount).toBe(1);
  });

  it("cancels non-success getChat response bodies before returning", async () => {
    const cancel = vi.fn();
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("service unavailable"));
          },
          cancel,
        }),
        { status: 503 },
      );
    });

    const result = await Promise.race([
      fetchTelegramChatId({
        token: "abc",
        chatId: "@user",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      new Promise<"stalled">((resolve) => {
        setTimeout(() => resolve("stalled"), 250);
      }),
    ]);

    expect(result).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not wait for a cloned capture branch before returning", async () => {
    let observedSignal: AbortSignal | undefined;
    let captureSettled = false;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("service unavailable"));
            observedSignal?.addEventListener(
              "abort",
              () => controller.error(observedSignal?.reason),
              { once: true },
            );
          },
        }),
        { status: 503 },
      );
      const clone = response.clone();
      void clone
        .arrayBuffer()
        .catch(() => undefined)
        .finally(() => {
          captureSettled = true;
        });
      return response;
    });

    const result = await Promise.race([
      fetchTelegramChatId({
        token: "abc",
        chatId: "@user",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      new Promise<"stalled">((resolve) => {
        setTimeout(() => resolve("stalled"), 250);
      }),
    ]);

    expect(result).toBeNull();
    await vi.waitFor(() => expect(captureSettled).toBe(true));
    expect(observedSignal?.aborted).toBe(true);
  });

  it("keeps the getChat timeout active until the response body read settles", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    let abortReason: unknown;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            observedSignal?.addEventListener(
              "abort",
              () => {
                abortReason = observedSignal?.reason;
                controller.error(abortReason);
              },
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    });

    const lookup = fetchTelegramChatId({
      token: "abc",
      chatId: "@user",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(lookup).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(abortReason).toBeInstanceOf(Error);
    expect((abortReason as Error).name).toBe("TimeoutError");
    expect((abortReason as Error).message).toBe("request timed out");
  });
});

describe("lookupTelegramChatId", () => {
  it.each([
    {
      name: "success",
      setup: () => proxyMocks.undiciFetch.mockResolvedValueOnce(getChatOkResponse(12345)),
      expected: "12345",
    },
    {
      name: "transport failure",
      setup: () => proxyMocks.undiciFetch.mockRejectedValueOnce(new Error("network failed")),
      expected: null,
    },
  ])("closes its owned transport after $name", async ({ setup, expected }) => {
    proxyMocks.undiciFetch.mockReset();
    setup();

    await expect(
      lookupTelegramChatId({
        token: "abc",
        chatId: "@user",
        network: { autoSelectFamily: false },
      }),
    ).resolves.toBe(expected);

    const init = proxyMocks.undiciFetch.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: { destroyed?: boolean } })
      | undefined;
    expect(init?.dispatcher?.destroyed).toBe(true);
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

    const noProxyConnect = getOwnSymbolValue(noProxyAgent, "options")?.connect as
      | { autoSelectFamily?: boolean; family?: number }
      | undefined;
    expect(noProxyConnect?.family).toBe(connect.family);
    expect(noProxyConnect?.autoSelectFamily).toBe(connect.autoSelectFamily);
    expect(getOwnSymbolValue(httpsProxyAgent, "proxy tls settings")).toBeUndefined();

    const withProxyTls = new EnvHttpProxyAgent({
      connect,
      proxyTls: connect,
    });
    const httpsProxyAgentWithProxyTls = withProxyTls[kHttpsProxyAgent] as Record<
      PropertyKey,
      unknown
    >;

    const proxyTlsSettings = getOwnSymbolValue(
      httpsProxyAgentWithProxyTls,
      "proxy tls settings",
    ) as { autoSelectFamily?: boolean; family?: number } | undefined;
    expect(proxyTlsSettings?.family).toBe(connect.family);
    expect(proxyTlsSettings?.autoSelectFamily).toBe(connect.autoSelectFamily);
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
