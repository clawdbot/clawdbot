import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_GAXIOS_CONSTRUCTOR_OVERRIDE = "__OPENCLAW_TEST_GAXIOS_CONSTRUCTOR__";
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let ProxyAgent: typeof import("undici").ProxyAgent;
let __testing: typeof import("./gaxios-fetch-compat.js").__testing;
let createGaxiosCompatFetch: typeof import("./gaxios-fetch-compat.js").createGaxiosCompatFetch;
let installGaxiosFetchCompat: typeof import("./gaxios-fetch-compat.js").installGaxiosFetchCompat;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  ({ ProxyAgent } = require("undici") as typeof import("undici"));
  ({ __testing, createGaxiosCompatFetch, installGaxiosFetchCompat } =
    await import("./gaxios-fetch-compat.js"));
});

beforeEach(() => {
  vi.useRealTimers();
  vi.doUnmock("undici");
  __testing.resetGaxiosFetchCompatForTests();
});

describe("gaxios fetch compat", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis as object, TEST_GAXIOS_CONSTRUCTOR_OVERRIDE);
    __testing.resetGaxiosFetchCompatForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses native fetch without defining window or importing node-fetch", async () => {
    type MockRequestConfig = RequestInit & {
      fetchImplementation?: FetchLike;
      responseType?: string;
      url: string;
    };
    let MockGaxiosCtor!: new () => {
      request(config: MockRequestConfig): Promise<{ data: string } & object>;
    };
    const fetchMock = vi.fn<FetchLike>(async () => {
      return new Response("ok", {
        headers: { "content-type": "text/plain" },
        status: 200,
      });
    });

    vi.stubGlobal("fetch", fetchMock);
    class MockGaxios {
      async _defaultAdapter(config: MockRequestConfig): Promise<Response> {
        const fetchImplementation = config.fetchImplementation ?? fetch;
        return await fetchImplementation(config.url, config);
      }

      async request(config: MockRequestConfig) {
        const response = await this._defaultAdapter(config);
        return {
          ...(response as object),
          data: await response.text(),
        };
      }
    }
    MockGaxiosCtor = MockGaxios;

    (globalThis as Record<string, unknown>)[TEST_GAXIOS_CONSTRUCTOR_OVERRIDE] = MockGaxios;

    await installGaxiosFetchCompat();

    const res = await new MockGaxiosCtor().request({
      responseType: "text",
      url: "https://example.com",
    });

    expect(res.data).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect("window" in globalThis).toBe(false);
  });

  it("falls back to a legacy window fetch shim when gaxios is unavailable", async () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    vi.stubGlobal("fetch", vi.fn<FetchLike>());
    Reflect.deleteProperty(globalThis as object, "window");
    (globalThis as Record<string, unknown>)[TEST_GAXIOS_CONSTRUCTOR_OVERRIDE] = null;
    try {
      await expect(installGaxiosFetchCompat()).resolves.toBeUndefined();
      expect((globalThis as { window?: { fetch?: FetchLike } }).window?.fetch).toBe(fetch);
      await expect(installGaxiosFetchCompat()).resolves.toBeUndefined();
    } finally {
      Reflect.deleteProperty(globalThis as object, "window");
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      }
    }
  });

  it("translates proxy-agent-like inputs into undici dispatchers for native fetch", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => {
      return new Response("ok", {
        headers: { "content-type": "text/plain" },
        status: 200,
      });
    });
    const compatFetch = createGaxiosCompatFetch(fetchMock);
    await compatFetch("https://example.com", {
      agent: { proxy: new URL("http://proxy.example:8080") },
    } as RequestInit);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];

    expect(init).not.toHaveProperty("agent");
    expect((init as { dispatcher?: unknown })?.dispatcher).toBeInstanceOf(ProxyAgent);
  });
});
