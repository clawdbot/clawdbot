import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveManagedProxyStateForTests,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./proxy/active-proxy-state.js";

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;

const ORIGINAL_PROXY_ENV = Object.fromEntries(
  PROXY_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

const {
  EnvHttpProxyAgent,
  MockUndiciFormData,
  undiciFetch,
  proxyAgentSpy,
  envAgentSpy,
  getLastAgent,
  loadUndiciRuntimeDeps,
} = vi.hoisted(() => {
  const undiciFetch = vi.fn();
  const proxyAgentSpy = vi.fn();
  const envAgentSpy = vi.fn();
  class MockUndiciFormData {
    readonly [Symbol.toStringTag] = "FormData";
    readonly entriesList: [string, unknown, string | undefined][] = [];

    append(key: string, value: unknown, filename?: string): void {
      this.entriesList.push([key, value, filename]);
    }

    get(key: string): unknown {
      return this.entriesList.find(([entryKey]) => entryKey === key)?.[1] ?? null;
    }
  }
  class ProxyAgent {
    static lastCreated: ProxyAgent | undefined;
    readonly proxyUrl: string | undefined;
    constructor(public readonly options: { uri?: string; proxyTls?: unknown } | string) {
      this.proxyUrl = typeof options === "string" ? options : options.uri;
      ProxyAgent.lastCreated = this;
      proxyAgentSpy(options);
    }
  }
  class EnvHttpProxyAgent {
    static lastCreated: EnvHttpProxyAgent | undefined;
    constructor(public readonly options?: Record<string, unknown>) {
      EnvHttpProxyAgent.lastCreated = this;
      envAgentSpy(options);
    }
  }
  const loadUndiciRuntimeDeps = vi.fn(() => ({
    ProxyAgent,
    EnvHttpProxyAgent,
    FormData: MockUndiciFormData,
    fetch: undiciFetch,
  }));

  return {
    ProxyAgent,
    EnvHttpProxyAgent,
    MockUndiciFormData,
    undiciFetch,
    proxyAgentSpy,
    envAgentSpy,
    getLastAgent: () => ProxyAgent.lastCreated,
    loadUndiciRuntimeDeps,
  };
});

const mockedModuleIds = ["./undici-runtime.js"] as const;

vi.mock("./undici-runtime.js", () => ({
  loadUndiciRuntimeDeps,
}));

let getProxyUrlFromFetch: typeof import("./proxy-fetch.js").getProxyUrlFromFetch;
let makeProxyFetch: typeof import("./proxy-fetch.js").makeProxyFetch;
let PROXY_FETCH_PROXY_URL: typeof import("./proxy-fetch.js").PROXY_FETCH_PROXY_URL;
let resolveProxyFetchFromEnv: typeof import("./proxy-fetch.js").resolveProxyFetchFromEnv;

function requireProxyFetch(
  fetchFn: ReturnType<typeof resolveProxyFetchFromEnv>,
): NonNullable<ReturnType<typeof resolveProxyFetchFromEnv>> {
  if (!fetchFn) {
    throw new Error("expected proxy env to resolve a fetch function");
  }
  return fetchFn;
}

function requireUndiciFetchCall(index = 0): unknown[] {
  const call = undiciFetch.mock.calls[index];
  if (!call) {
    throw new Error(`expected undici fetch call at index ${index}`);
  }
  return call;
}

function requireUndiciFetchInit(index = 0): Record<string, unknown> {
  const init = requireUndiciFetchCall(index)[1];
  if (!init || typeof init !== "object" || Array.isArray(init)) {
    throw new Error(`expected undici fetch init at index ${index}`);
  }
  return init as Record<string, unknown>;
}

function requireHeadersInit(value: unknown, label: string): HeadersInit {
  if (value === undefined || value instanceof Headers || Array.isArray(value)) {
    return value as HeadersInit;
  }
  if (value && typeof value === "object") {
    return value as HeadersInit;
  }
  throw new Error(`expected ${label} headers`);
}

function clearProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreProxyEnv(): void {
  clearProxyEnv();
  for (const key of PROXY_ENV_KEYS) {
    const value = ORIGINAL_PROXY_ENV[key];
    if (typeof value === "string") {
      process.env[key] = value;
    }
  }
}

describe("makeProxyFetch", () => {
  beforeAll(async () => {
    ({ getProxyUrlFromFetch, makeProxyFetch, PROXY_FETCH_PROXY_URL, resolveProxyFetchFromEnv } =
      await import("./proxy-fetch.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    _resetActiveManagedProxyStateForTests();
  });

  afterEach(() => {
    _resetActiveManagedProxyStateForTests();
  });

  it("uses undici fetch with ProxyAgent dispatcher", async () => {
    const proxyUrl = "http://proxy.test:8080";
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    expect(proxyAgentSpy).not.toHaveBeenCalled();
    await proxyFetch("https://api.example.com/v1/audio");

    expect(proxyAgentSpy).toHaveBeenCalledWith({ uri: proxyUrl });
    expect(undiciFetch).toHaveBeenCalledOnce();
    const [input] = requireUndiciFetchCall();
    const init = requireUndiciFetchInit();
    expect(input).toBe("https://api.example.com/v1/audio");
    expect(init.dispatcher).toBe(getLastAgent());
  });

  it("adds active managed proxy CA trust to explicit proxy fetch dispatchers", async () => {
    const registration = registerActiveManagedProxyUrl(new URL("https://proxy.test:8443"), {
      proxyTls: { ca: "explicit-proxy-fetch-ca" },
    });
    undiciFetch.mockResolvedValue({ ok: true });

    try {
      const proxyFetch = makeProxyFetch("https://proxy.test:8443");

      await proxyFetch("https://api.example.com/v1/audio");

      expect(proxyAgentSpy).toHaveBeenCalledWith({
        uri: "https://proxy.test:8443",
        proxyTls: { ca: "explicit-proxy-fetch-ca" },
      });
    } finally {
      stopActiveManagedProxyRegistration(registration);
    }
  });

  it("reuses the same ProxyAgent across calls", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("http://proxy.test:8080");

    await proxyFetch("https://api.example.com/one");
    const firstDispatcher = requireUndiciFetchInit().dispatcher;
    await proxyFetch("https://api.example.com/two");
    const secondDispatcher = requireUndiciFetchInit(1).dispatcher;

    expect(proxyAgentSpy).toHaveBeenCalledOnce();
    expect(secondDispatcher).toBe(firstDispatcher);
  });

  it("converts global FormData bodies before dispatching through undici", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("http://proxy.test:8080");
    const form = new globalThis.FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([new Uint8Array(4)], { type: "audio/ogg" }), "voice.ogg");

    await proxyFetch("https://api.example.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "content-length": "999",
        "content-type": "multipart/form-data; boundary=stale",
      },
      body: form,
    });

    const passedInit = requireUndiciFetchInit();
    expect(passedInit.body).toBeInstanceOf(MockUndiciFormData);
    const passedBody = passedInit.body as InstanceType<typeof MockUndiciFormData>;
    expect(passedBody.get("model")).toBe("whisper-1");
    expect(passedBody.get("file")).toBeInstanceOf(Blob);
    expect(passedBody.entriesList.find(([key]) => key === "file")?.[2]).toBe("voice.ogg");
    const sentHeaders = new Headers(requireHeadersInit(passedInit.headers, "FormData proxy"));
    expect(sentHeaders.has("content-length")).toBe(false);
    expect(sentHeaders.has("content-type")).toBe(false);
  });

  it("keeps non-FormData bodies unchanged", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("http://proxy.test:8080");
    const body = JSON.stringify({ hello: "world" });

    await proxyFetch("https://api.example.com/json", {
      method: "POST",
      body,
    });

    expect(requireUndiciFetchInit().body).toBe(body);
  });

  it("drops symbol metadata from plain header dictionaries before undici fetch", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("http://proxy.test:8080");
    const headers = { "Content-Type": "application/json" } as Record<string, string> & {
      [key: symbol]: unknown;
    };
    Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
      value: new Set(["content-type"]),
      enumerable: false,
    });

    await proxyFetch("https://api.example.com/json", {
      method: "POST",
      headers,
      body: "{}",
    });

    const passedHeaders = requireUndiciFetchInit().headers;
    expect(passedHeaders).not.toBe(headers);
    expect(Object.getOwnPropertySymbols(passedHeaders as object)).toStrictEqual([]);
    expect(
      new Headers(requireHeadersInit(passedHeaders, "plain dictionary proxy")).get("content-type"),
    ).toBe("application/json");
    expect(Object.getOwnPropertySymbols(headers)).toHaveLength(1);
  });

  it("keeps undici FormData instances unchanged", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("http://proxy.test:8080");
    const form = new MockUndiciFormData();
    form.append("key", "value");

    await proxyFetch("https://api.example.com/upload", {
      method: "POST",
      body: form as unknown as BodyInit,
    });

    expect(requireUndiciFetchInit().body).toBe(form);
  });

  it("converts FormData-like bodies from another implementation", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch("http://proxy.test:8080");
    const formLike = {
      [Symbol.toStringTag]: "FormData",
      *entries(): IterableIterator<[string, FormDataEntryValue]> {
        yield ["model", "whisper-1"];
      },
    };

    await proxyFetch("https://api.example.com/upload", {
      method: "POST",
      body: formLike as unknown as BodyInit,
    });

    const passedBody = requireUndiciFetchInit().body;
    expect(passedBody).toBeInstanceOf(MockUndiciFormData);
    expect((passedBody as InstanceType<typeof MockUndiciFormData>).get("model")).toBe("whisper-1");
  });
});

describe("getProxyUrlFromFetch", () => {
  it("returns the trimmed proxy url from proxy fetch wrappers", () => {
    expect(getProxyUrlFromFetch(makeProxyFetch("  http://proxy.test:8080  "))).toBe(
      "http://proxy.test:8080",
    );
  });

  it("returns undefined for plain fetch functions or blank metadata", () => {
    const plainFetch = vi.fn() as unknown as typeof fetch;
    const blankMetadataFetch = vi.fn() as unknown as typeof fetch;
    Object.defineProperty(blankMetadataFetch, PROXY_FETCH_PROXY_URL, {
      value: "   ",
      enumerable: false,
      configurable: true,
      writable: true,
    });

    expect(getProxyUrlFromFetch(plainFetch)).toBeUndefined();
    expect(getProxyUrlFromFetch(blankMetadataFetch)).toBeUndefined();
  });
});

describe("resolveProxyFetchFromEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    _resetActiveManagedProxyStateForTests();
    clearProxyEnv();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetActiveManagedProxyStateForTests();
    restoreProxyEnv();
  });

  it("returns undefined when no proxy env vars are set", () => {
    expect(resolveProxyFetchFromEnv({})).toBeUndefined();
    expect(loadUndiciRuntimeDeps).not.toHaveBeenCalled();
  });

  it("returns proxy fetch using EnvHttpProxyAgent when HTTPS_PROXY is set", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const fetchFn = requireProxyFetch(
      resolveProxyFetchFromEnv({
        HTTP_PROXY: "",
        HTTPS_PROXY: "http://proxy.test:8080",
      }),
    );
    expect(envAgentSpy).toHaveBeenCalledWith({ httpsProxy: "http://proxy.test:8080" });

    await fetchFn("https://api.example.com");
    expect(undiciFetch).toHaveBeenCalledOnce();
    const [input] = requireUndiciFetchCall();
    const init = requireUndiciFetchInit();
    expect(input).toBe("https://api.example.com");
    expect(init.dispatcher).toBe(EnvHttpProxyAgent.lastCreated);
  });

  it("adds active managed proxy CA trust to env proxy fetch dispatchers", () => {
    const registration = registerActiveManagedProxyUrl(new URL("https://proxy.test:8443"), {
      proxyTls: { ca: "proxy-fetch-ca" },
    });

    try {
      const fetchFn = requireProxyFetch(
        resolveProxyFetchFromEnv({
          HTTP_PROXY: "",
          HTTPS_PROXY: "https://proxy.test:8443",
        }),
      );

      expect(fetchFn).toBeTypeOf("function");
      expect(envAgentSpy).toHaveBeenCalledWith({
        httpsProxy: "https://proxy.test:8443",
        proxyTls: { ca: "proxy-fetch-ca" },
      });
    } finally {
      stopActiveManagedProxyRegistration(registration);
    }
  });

  it("converts global FormData bodies when using proxy env fetch", async () => {
    undiciFetch.mockResolvedValue({ ok: true });

    const fetchFn = requireProxyFetch(
      resolveProxyFetchFromEnv({
        HTTP_PROXY: "",
        HTTPS_PROXY: "http://proxy.test:8080",
      }),
    );

    const form = new globalThis.FormData();
    form.append("file", new Blob([new Uint8Array(8)], { type: "audio/wav" }), "test.wav");
    form.append("model", "test-model");

    await fetchFn("https://api.example.com/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });

    const passedBody = requireUndiciFetchInit().body;
    expect(passedBody).toBeInstanceOf(MockUndiciFormData);
    expect((passedBody as InstanceType<typeof MockUndiciFormData>).get("model")).toBe("test-model");
    expect((passedBody as InstanceType<typeof MockUndiciFormData>).get("file")).toBeInstanceOf(
      Blob,
    );
  });

  it("returns proxy fetch when HTTP_PROXY is set", () => {
    const fetchFn = requireProxyFetch(
      resolveProxyFetchFromEnv({
        HTTPS_PROXY: "",
        HTTP_PROXY: "http://fallback.test:3128",
      }),
    );
    expect(fetchFn).toBeTypeOf("function");
    expect(envAgentSpy).toHaveBeenCalledWith({
      httpProxy: "http://fallback.test:3128",
      httpsProxy: "http://fallback.test:3128",
    });
  });

  it("returns proxy fetch when lowercase https_proxy is set", () => {
    const fetchFn = requireProxyFetch(
      resolveProxyFetchFromEnv({
        HTTPS_PROXY: "",
        HTTP_PROXY: "",
        http_proxy: "",
        https_proxy: "http://lower.test:1080",
      }),
    );
    expect(fetchFn).toBeTypeOf("function");
    expect(envAgentSpy).toHaveBeenCalledWith({ httpsProxy: "http://lower.test:1080" });
  });

  it("returns proxy fetch when lowercase http_proxy is set", () => {
    const fetchFn = requireProxyFetch(
      resolveProxyFetchFromEnv({
        HTTPS_PROXY: "",
        HTTP_PROXY: "",
        https_proxy: "",
        http_proxy: "http://lower-http.test:1080",
      }),
    );
    expect(fetchFn).toBeTypeOf("function");
    expect(envAgentSpy).toHaveBeenCalledWith({
      httpProxy: "http://lower-http.test:1080",
      httpsProxy: "http://lower-http.test:1080",
    });
  });

  it("returns proxy fetch when ALL_PROXY is set", () => {
    const fetchFn = requireProxyFetch(
      resolveProxyFetchFromEnv({
        HTTPS_PROXY: "",
        HTTP_PROXY: "",
        https_proxy: "",
        http_proxy: "",
        ALL_PROXY: "socks5://all-proxy.test:1080",
      }),
    );
    expect(fetchFn).toBeTypeOf("function");
    expect(envAgentSpy).toHaveBeenCalledWith({
      httpProxy: "socks5://all-proxy.test:1080",
      httpsProxy: "socks5://all-proxy.test:1080",
    });
  });

  it("returns undefined when EnvHttpProxyAgent constructor throws", () => {
    envAgentSpy.mockImplementationOnce(() => {
      throw new Error("Invalid URL");
    });

    const fetchFn = resolveProxyFetchFromEnv({
      HTTP_PROXY: "",
      https_proxy: "",
      http_proxy: "",
      HTTPS_PROXY: "not-a-valid-url",
    });
    expect(fetchFn).toBeUndefined();
  });
});

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
});
