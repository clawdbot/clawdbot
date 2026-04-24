import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithSsrFGuard,
  GUARDED_FETCH_MODE,
  retainSafeHeadersForCrossOriginRedirectHeaders,
} from "./fetch-guard.js";
import {
  ensureGlobalUndiciStreamTimeouts,
  resetGlobalUndiciStreamTimeoutsForTests,
} from "./undici-global-dispatcher.js";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "./undici-runtime.js";

const { agentCtor, envHttpProxyAgentCtor, proxyAgentCtor } = vi.hoisted(() => ({
  agentCtor: vi.fn(function MockAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
  envHttpProxyAgentCtor: vi.fn(function MockEnvHttpProxyAgent(
    this: { options: unknown },
    options: unknown,
  ) {
    this.options = options;
  }),
  proxyAgentCtor: vi.fn(function MockProxyAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
}));
const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock("../../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../../logger.js")>("../../logger.js");
  return {
    ...actual,
    logWarn: logWarnMock,
  };
});

function createPinnedDispatcherCompatibilityError(): Error {
  const cause = Object.assign(new Error("invalid onRequestStart method"), {
    code: "UND_ERR_INVALID_ARG",
  });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location },
  });
}

function okResponse(body = "ok"): Response {
  return new Response(body, { status: 200 });
}

function getDispatcherClassName(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const ctor = (value as { constructor?: unknown }).constructor;
  return typeof ctor === "function" && ctor.name ? ctor.name : null;
}

function getSecondRequestHeaders(fetchImpl: ReturnType<typeof vi.fn>): Headers {
  const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
  return new Headers(secondInit.headers);
}

function getSecondRequestInit(fetchImpl: ReturnType<typeof vi.fn>): RequestInit {
  const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
  return secondInit;
}

async function expectRedirectFailure(params: {
  url: string;
  responses: Response[];
  expectedError: RegExp;
  lookupFn?: NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;
  maxRedirects?: number;
}) {
  const fetchImpl = vi.fn();
  for (const response of params.responses) {
    fetchImpl.mockResolvedValueOnce(response);
  }

  await expect(
    fetchWithSsrFGuard({
      url: params.url,
      fetchImpl,
      ...(params.lookupFn ? { lookupFn: params.lookupFn } : {}),
      ...(params.maxRedirects === undefined ? {} : { maxRedirects: params.maxRedirects }),
    }),
  ).rejects.toThrow(params.expectedError);
  return fetchImpl;
}

describe("fetchWithSsrFGuard hardening", () => {
  const PROXY_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ] as const;

  type LookupFn = NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;
  const CROSS_ORIGIN_REDIRECT_STRIPPED_HEADERS = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "cookie2",
    "x-api-key",
    "private-token",
    "x-trace",
  ] as const;
  const CROSS_ORIGIN_REDIRECT_PRESERVED_HEADERS = [
    ["accept", "application/json"],
    ["content-type", "application/json"],
    ["user-agent", "OpenClaw-Test/1.0"],
  ] as const;

  const createPublicLookup = (): LookupFn =>
    vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;

  function clearProxyEnv(): void {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  }

  async function runProxyModeDispatcherTest(params: {
    mode: (typeof GUARDED_FETCH_MODE)[keyof typeof GUARDED_FETCH_MODE];
    expectEnvProxy: boolean;
  }): Promise<void> {
    clearProxyEnv();
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: agentCtor,
      EnvHttpProxyAgent: envHttpProxyAgentCtor,
      ProxyAgent: proxyAgentCtor,
      fetch: vi.fn(async () => okResponse()),
    };
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      if (params.expectEnvProxy) {
        expect(requestInit.dispatcher).toBeDefined();
      } else {
        expect(requestInit.dispatcher).toBeDefined();
        expect(getDispatcherClassName(requestInit.dispatcher)).not.toBe("EnvHttpProxyAgent");
      }
      return okResponse();
    });

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn,
      mode: params.mode,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    if (params.expectEnvProxy) {
      expect(envHttpProxyAgentCtor).toHaveBeenCalledTimes(1);
      expect(envHttpProxyAgentCtor).toHaveBeenCalledWith({
        allowH2: false,
      });
    }
    await result.release();
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    agentCtor.mockClear();
    envHttpProxyAgentCtor.mockClear();
    proxyAgentCtor.mockClear();
    logWarnMock.mockClear();
    resetGlobalUndiciStreamTimeoutsForTests();
    Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
  });

  it("blocks private and legacy loopback literals before fetch", async () => {
    const blockedUrls = [
      "http://127.0.0.1:8080/internal",
      "http://[ff02::1]/internal",
      "http://0177.0.0.1:8080/internal",
      "http://0x7f000001/internal",
    ];
    for (const url of blockedUrls) {
      const fetchImpl = vi.fn();
      await expect(
        fetchWithSsrFGuard({
          url,
          fetchImpl,
        }),
      ).rejects.toThrow(/private|internal|blocked/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("blocks special-use IPv4 literal URLs before fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "http://198.18.0.1:8080/internal",
        fetchImpl,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("logs blocked URL fetches without path/query metadata", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "http://127.0.0.1:8080/private/secret?token=abc#frag",
        fetchImpl,
        auditContext: "qa-audit",
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    const [warning] = logWarnMock.mock.calls[0] as [string];
    expect(warning).toContain(
      "security: blocked URL fetch (qa-audit) targetOrigin=http://127.0.0.1:8080",
    );
    expect(warning).not.toContain("/private/secret");
    expect(warning).not.toContain("token=abc");
    expect(warning).not.toContain("#frag");
  });

  it("allows RFC2544 benchmark range IPv4 literal URLs when explicitly opted in", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await fetchWithSsrFGuard({
      url: "http://198.18.0.153/file",
      fetchImpl,
      policy: { allowRfc2544BenchmarkRange: true },
    });
    expect(result.response.status).toBe(200);
  });

  it("fails closed for plain HTTP targets when explicit proxy mode requires pinned DNS", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "http://public.example/resource",
        fetchImpl,
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "http://127.0.0.1:7890",
        },
      }),
    ).rejects.toThrow(/explicit proxy ssrf pinning requires https targets/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks explicit proxies that resolve to private hosts by default", async () => {
    const lookupFn = vi.fn(async (hostname: string) => [
      {
        address: hostname === "proxy.internal" ? "127.0.0.1" : "93.184.216.34",
        family: 4,
      },
    ]) as unknown as LookupFn;
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "https://public.example/resource",
        fetchImpl,
        lookupFn,
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "http://proxy.internal:7890",
        },
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows explicit private proxies only when the SSRF policy allows private network access", async () => {
    const lookupFn = vi.fn(async (hostname: string) => [
      {
        address: hostname === "proxy.internal" ? "127.0.0.1" : "93.184.216.34",
        family: 4,
      },
    ]) as unknown as LookupFn;
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn,
      policy: { allowPrivateNetwork: true },
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://proxy.internal:7890",
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.release();
  });

  it("uses runtime undici fetch when attaching a dispatcher", async () => {
    const runtimeFetch = vi.fn(async () => okResponse());
    const originalGlobalFetch = globalThis.fetch;
    let globalFetchCalls = 0;
    const globalFetch = async () => {
      globalFetchCalls += 1;
      throw new Error("global fetch should not be used when a dispatcher is attached");
    };

    class MockAgent {
      constructor(readonly options: unknown) {}
    }
    class MockEnvHttpProxyAgent {
      constructor(readonly options: unknown) {}
    }
    class MockProxyAgent {
      constructor(readonly options: unknown) {}
    }

    (globalThis as Record<string, unknown>).fetch = globalFetch as typeof fetch;
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      ProxyAgent: MockProxyAgent,
      fetch: runtimeFetch,
    };

    try {
      const result = await fetchWithSsrFGuard({
        url: "https://public.example/resource",
        lookupFn: createPublicLookup(),
      });

      expect(runtimeFetch).toHaveBeenCalledTimes(1);
      expect(globalFetchCalls).toBe(0);
      await result.release();
    } finally {
      (globalThis as Record<string, unknown>).fetch = originalGlobalFetch;
    }
  });

  it("uses mocked global fetch when tests stub it", async () => {
    const runtimeFetch = vi.fn(async () => {
      throw new Error("runtime fetch should not be used when global fetch is mocked");
    });
    const originalGlobalFetch = globalThis.fetch;
    const globalFetch = vi.fn(async () => okResponse());

    class MockAgent {
      constructor(readonly options: unknown) {}
    }
    class MockEnvHttpProxyAgent {
      constructor(readonly options: unknown) {}
    }
    class MockProxyAgent {
      constructor(readonly options: unknown) {}
    }

    (globalThis as Record<string, unknown>).fetch = globalFetch as typeof fetch;
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      ProxyAgent: MockProxyAgent,
      fetch: runtimeFetch,
    };

    try {
      const result = await fetchWithSsrFGuard({
        url: "https://public.example/resource",
        lookupFn: createPublicLookup(),
      });

      expect(globalFetch).toHaveBeenCalledTimes(1);
      expect(runtimeFetch).not.toHaveBeenCalled();
      await result.release();
    } finally {
      (globalThis as Record<string, unknown>).fetch = originalGlobalFetch;
    }
  });

  it("fails closed when the runtime rejects the pinned dispatcher shape", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      if (requestInit.dispatcher) {
        throw createPinnedDispatcherCompatibilityError();
      }
      return okResponse();
    });

    await expect(
      fetchWithSsrFGuard({
        url: "https://public.example/resource",
        fetchImpl,
        lookupFn: createPublicLookup(),
      }),
    ).rejects.toThrow("fetch failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ignores dispatcher support markers on ambient global fetch", async () => {
    const runtimeFetch = vi.fn(async () => okResponse());
    const originalGlobalFetch = globalThis.fetch;
    let globalFetchCalls = 0;
    const flaggedGlobalFetch = Object.assign(
      async () => {
        globalFetchCalls += 1;
        throw new Error("ambient global fetch should not be used when a dispatcher is attached");
      },
      { __openclawAcceptsDispatcher: true as const },
    );

    class MockAgent {
      constructor(readonly options: unknown) {}
    }
    class MockEnvHttpProxyAgent {
      constructor(readonly options: unknown) {}
    }
    class MockProxyAgent {
      constructor(readonly options: unknown) {}
    }

    (globalThis as Record<string, unknown>).fetch = flaggedGlobalFetch as typeof fetch;
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      ProxyAgent: MockProxyAgent,
      fetch: runtimeFetch,
    };

    try {
      const result = await fetchWithSsrFGuard({
        url: "https://public.example/resource",
        lookupFn: createPublicLookup(),
      });

      expect(runtimeFetch).toHaveBeenCalledTimes(1);
      expect(globalFetchCalls).toBe(0);
      await result.release();
    } finally {
      (globalThis as Record<string, unknown>).fetch = originalGlobalFetch;
    }
  });

  it("treats explicit fetchImpl equal to ambient global fetch as non-dispatcher-capable", async () => {
    const runtimeFetch = vi.fn(async () => okResponse());
    const originalGlobalFetch = globalThis.fetch;
    let globalFetchCalls = 0;
    const globalFetch = async () => {
      globalFetchCalls += 1;
      throw new Error("ambient global fetch should not be used when a dispatcher is attached");
    };

    class MockAgent {
      constructor(readonly options: unknown) {}
    }
    class MockEnvHttpProxyAgent {
      constructor(readonly options: unknown) {}
    }
    class MockProxyAgent {
      constructor(readonly options: unknown) {}
    }

    (globalThis as Record<string, unknown>).fetch = globalFetch as typeof fetch;
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      ProxyAgent: MockProxyAgent,
      fetch: runtimeFetch,
    };

    try {
      const result = await fetchWithSsrFGuard({
        url: "https://public.example/resource",
        fetchImpl: globalThis.fetch,
        lookupFn: createPublicLookup(),
      });

      expect(runtimeFetch).toHaveBeenCalledTimes(1);
      expect(globalFetchCalls).toBe(0);
      await result.release();
    } finally {
      (globalThis as Record<string, unknown>).fetch = originalGlobalFetch;
    }
  });

  it("keeps explicit proxy transport policy when DNS pinning is disabled", async () => {
    const lookupFn = createPublicLookup();
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: agentCtor,
      EnvHttpProxyAgent: envHttpProxyAgentCtor,
      ProxyAgent: proxyAgentCtor,
      fetch: vi.fn(async () => okResponse()),
    };
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn,
      pinDns: false,
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://proxy.example:7890",
        proxyTls: {
          servername: "public.example",
        },
      },
    });

    expect(proxyAgentCtor).toHaveBeenCalledWith({
      uri: "http://proxy.example:7890",
      allowH2: false,
      requestTls: {
        servername: "public.example",
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://public.example/resource",
      expect.objectContaining({
        dispatcher: expect.any(Object),
      }),
    );
    await result.release();
  });

  it("blocks redirect chains that hop to private hosts", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = await expectRedirectFailure({
      url: "https://public.example/start",
      responses: [redirectResponse("http://127.0.0.1:6379/")],
      expectedError: /private|internal|blocked/i,
      lookupFn,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("enforces hostname allowlist policies", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "https://evil.example.org/file.txt",
        fetchImpl,
        policy: { hostnameAllowlist: ["cdn.example.com", "*.assets.example.com"] },
      }),
    ).rejects.toThrow(/allowlist/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not let wildcard allowlists match the apex host", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "https://assets.example.com/pic.png",
        fetchImpl,
        policy: { hostnameAllowlist: ["*.assets.example.com"] },
      }),
    ).rejects.toThrow(/allowlist/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows wildcard allowlisted hosts", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const result = await fetchWithSsrFGuard({
      url: "https://img.assets.example.com/pic.png",
      fetchImpl,
      lookupFn,
      policy: { hostnameAllowlist: ["*.assets.example.com"] },
    });

    expect(result.response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.release();
  });

  it("strips sensitive headers when redirect crosses origins", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://cdn.example.com/asset"))
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/start",
      fetchImpl,
      lookupFn,
      init: {
        headers: {
          Authorization: "Bearer secret",
          "Proxy-Authorization": "Basic c2VjcmV0",
          Cookie: "session=abc",
          Cookie2: "legacy=1",
          "X-Api-Key": "custom-secret",
          "Private-Token": "private-secret",
          "X-Trace": "1",
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "OpenClaw-Test/1.0",
        },
      },
    });

    const headers = getSecondRequestHeaders(fetchImpl);
    for (const header of CROSS_ORIGIN_REDIRECT_STRIPPED_HEADERS) {
      expect(headers.get(header)).toBeNull();
    }
    for (const [header, value] of CROSS_ORIGIN_REDIRECT_PRESERVED_HEADERS) {
      expect(headers.get(header)).toBe(value);
    }
    await result.release();
  });

  it("rewrites POST redirects to GET and clears the body for cross-origin 302 responses", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://cdn.example.com/collect"))
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/login",
      fetchImpl,
      lookupFn,
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": "19",
        },
        body: "password=hunter2",
      },
    });

    const secondInit = getSecondRequestInit(fetchImpl);
    const headers = getSecondRequestHeaders(fetchImpl);
    expect(secondInit.method).toBe("GET");
    expect(secondInit.body).toBeUndefined();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    await result.release();
  });

  it("rewrites same-origin 302 POST redirects to GET and preserves auth headers", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://api.example.com/next"))
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/login",
      fetchImpl,
      lookupFn,
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": "19",
        },
        body: "password=hunter2",
      },
    });

    const secondInit = getSecondRequestInit(fetchImpl);
    const headers = getSecondRequestHeaders(fetchImpl);
    expect(secondInit.method).toBe("GET");
    expect(secondInit.body).toBeUndefined();
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    await result.release();
  });

  it("rewrites 303 redirects to GET and clears the body", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 303,
          headers: { location: "https://api.example.com/final" },
        }),
      )
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/start",
      fetchImpl,
      lookupFn,
      init: {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "17",
        },
        body: '{"secret":"123"}',
      },
    });

    const secondInit = getSecondRequestInit(fetchImpl);
    const headers = getSecondRequestHeaders(fetchImpl);
    expect(secondInit.method).toBe("GET");
    expect(secondInit.body).toBeUndefined();
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    await result.release();
  });

  it("preserves method and body for 307 redirects", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://api.example.com/upload-2" },
        }),
      )
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/upload",
      fetchImpl,
      lookupFn,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: '{"secret":"123"}',
      },
    });

    const secondInit = getSecondRequestInit(fetchImpl);
    const headers = getSecondRequestHeaders(fetchImpl);
    expect(secondInit.method).toBe("POST");
    expect(secondInit.body).toBe('{"secret":"123"}');
    expect(headers.get("content-type")).toBe("application/json");
    await result.release();
  });

  it("drops unsafe bodies while stripping auth headers for cross-origin 307 redirects", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://cdn.example.com/upload-2" },
        }),
      )
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/upload",
      fetchImpl,
      lookupFn,
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: '{"secret":"123"}',
      },
    });

    const secondInit = getSecondRequestInit(fetchImpl);
    const headers = getSecondRequestHeaders(fetchImpl);
    expect(secondInit.method).toBe("POST");
    expect(secondInit.body).toBeUndefined();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBeNull();
    await result.release();
  });

  it("preserves unsafe cross-origin 307 bodies only when explicitly enabled", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://cdn.example.com/upload-2" },
        }),
      )
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/upload",
      fetchImpl,
      lookupFn,
      allowCrossOriginUnsafeRedirectReplay: true,
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: '{"secret":"123"}',
      },
    });

    const secondInit = getSecondRequestInit(fetchImpl);
    const headers = getSecondRequestHeaders(fetchImpl);
    expect(secondInit.method).toBe("POST");
    expect(secondInit.body).toBe('{"secret":"123"}');
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    await result.release();
  });

  it("drops unsafe bodies while stripping auth headers for cross-origin 308 redirects", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 308,
          headers: { location: "https://cdn.example.com/upload-2" },
        }),
      )
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/upload",
      fetchImpl,
      lookupFn,
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: '{"secret":"123"}',
      },
    });

    const secondInit = getSecondRequestInit(fetchImpl);
    const headers = getSecondRequestHeaders(fetchImpl);
    expect(secondInit.method).toBe("POST");
    expect(secondInit.body).toBeUndefined();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBeNull();
    await result.release();
  });

  it("preserves unsafe cross-origin 308 bodies only when explicitly enabled", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 308,
          headers: { location: "https://cdn.example.com/upload-2" },
        }),
      )
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/upload",
      fetchImpl,
      lookupFn,
      allowCrossOriginUnsafeRedirectReplay: true,
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: '{"secret":"123"}',
      },
    });

    const secondInit = getSecondRequestInit(fetchImpl);
    const headers = getSecondRequestHeaders(fetchImpl);
    expect(secondInit.method).toBe("POST");
    expect(secondInit.body).toBe('{"secret":"123"}');
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    await result.release();
  });

  it("keeps the exported redirect-header helper functional", () => {
    const headers = retainSafeHeadersForCrossOriginRedirectHeaders({
      Authorization: "Bearer secret",
      Cookie: "session=abc",
      Accept: "application/json",
      "User-Agent": "OpenClaw-Test/1.0",
    });

    expect(headers).toEqual({
      accept: "application/json",
      "user-agent": "OpenClaw-Test/1.0",
    });
  });

  it("keeps headers when redirect stays on same origin", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("/next"))
      .mockResolvedValueOnce(okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.example.com/start",
      fetchImpl,
      lookupFn,
      init: {
        headers: {
          Authorization: "Bearer secret",
        },
      },
    });

    const headers = getSecondRequestHeaders(fetchImpl);
    expect(headers.get("authorization")).toBe("Bearer secret");
    await result.release();
  });

  it.each([
    {
      name: "rejects redirects without a location header",
      responses: [new Response(null, { status: 302 })],
      expectedError: /missing location header/i,
      maxRedirects: undefined,
    },
    {
      name: "rejects redirect loops",
      responses: [
        redirectResponse("https://public.example/next"),
        redirectResponse("https://public.example/next"),
      ],
      expectedError: /redirect loop/i,
      maxRedirects: undefined,
    },
    {
      name: "rejects too many redirects",
      responses: [
        redirectResponse("https://public.example/one"),
        redirectResponse("https://public.example/two"),
      ],
      expectedError: /too many redirects/i,
      maxRedirects: 1,
    },
  ])("$name", async ({ responses, expectedError, maxRedirects }) => {
    await expectRedirectFailure({
      url: "https://public.example/start",
      responses,
      expectedError,
      lookupFn: createPublicLookup(),
      maxRedirects,
    });
  });

  it("rejects redirect loops that return to the original URL", async () => {
    await expectRedirectFailure({
      url: "https://public.example/start",
      responses: [
        redirectResponse("https://public.example/next"),
        redirectResponse("https://public.example/start"),
      ],
      expectedError: /redirect loop/i,
      lookupFn: createPublicLookup(),
    });
  });

  it("blocks URLs that use credentials to obscure a private host", async () => {
    const fetchImpl = vi.fn();
    // http://attacker.com@127.0.0.1:8080/ — URL parser extracts hostname as 127.0.0.1
    await expect(
      fetchWithSsrFGuard({
        url: "http://attacker.com@127.0.0.1:8080/internal",
        fetchImpl,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks private IPv6 addresses embedded in URLs with credentials", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchWithSsrFGuard({
        url: "http://user:pass@[::1]:8080/internal",
        fetchImpl,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks redirect to a URL using credentials to obscure a private host", async () => {
    const lookupFn = createPublicLookup();
    const fetchImpl = await expectRedirectFailure({
      url: "https://public.example/start",
      responses: [redirectResponse("http://public@127.0.0.1:6379/")],
      expectedError: /private|internal|blocked/i,
      lookupFn,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ignores env proxy by default to preserve DNS-pinned destination binding", async () => {
    await runProxyModeDispatcherTest({
      mode: GUARDED_FETCH_MODE.STRICT,
      expectEnvProxy: false,
    });
  });

  it("routes through env proxy when trusted proxy mode is explicitly enabled", async () => {
    await runProxyModeDispatcherTest({
      mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
      expectEnvProxy: true,
    });
  });

  it("applies explicit timeoutMs to guarded direct dispatchers", async () => {
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: agentCtor,
      EnvHttpProxyAgent: envHttpProxyAgentCtor,
      ProxyAgent: proxyAgentCtor,
      fetch: vi.fn(async () => okResponse()),
    };
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn: createPublicLookup(),
      timeoutMs: 123_456,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(agentCtor).toHaveBeenCalledWith({
      connect: expect.objectContaining({
        lookup: expect.any(Function),
      }),
      allowH2: false,
      bodyTimeout: 123_456,
      headersTimeout: 123_456,
    });
    await result.release();
  });

  it("inherits the configured global stream timeout for guarded direct dispatchers", async () => {
    const { getGlobalDispatcher, setGlobalDispatcher } = await import("undici");
    const previousDispatcher = getGlobalDispatcher();
    try {
      ensureGlobalUndiciStreamTimeouts({ timeoutMs: 1_900_000 });
      (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
        Agent: agentCtor,
        EnvHttpProxyAgent: envHttpProxyAgentCtor,
        ProxyAgent: proxyAgentCtor,
        fetch: vi.fn(async () => okResponse()),
      };
      const fetchImpl = vi.fn(async () => okResponse());

      const result = await fetchWithSsrFGuard({
        url: "https://public.example/resource",
        fetchImpl,
        lookupFn: createPublicLookup(),
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(agentCtor).toHaveBeenCalledWith({
        connect: expect.objectContaining({
          lookup: expect.any(Function),
        }),
        allowH2: false,
        bodyTimeout: 1_900_000,
        headersTimeout: 1_900_000,
      });
      await result.release();
    } finally {
      setGlobalDispatcher(previousDispatcher);
      resetGlobalUndiciStreamTimeoutsForTests();
    }
  });

  it("allows explicit proxy on localhost when allowPrivateProxy is true even with restrictive hostnameAllowlist", async () => {
    // Reproduces #61906: Telegram media downloads fail because the SSRF guard
    // checks the proxy hostname (localhost) against a target-scoped allowlist
    // (api.telegram.org) and rejects it.
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: agentCtor,
      EnvHttpProxyAgent: envHttpProxyAgentCtor,
      ProxyAgent: proxyAgentCtor,
      fetch: vi.fn(async () => okResponse()),
    };
    const lookupFn: LookupFn = vi.fn(async (hostname: string) => {
      if (hostname === "localhost") {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      return [{ address: "149.154.167.220", family: 4 }];
    }) as unknown as LookupFn;
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.telegram.org/file/bot123/photos/test.jpg",
      fetchImpl,
      lookupFn,
      policy: { hostnameAllowlist: ["api.telegram.org"] },
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://localhost:6152",
        allowPrivateProxy: true,
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(proxyAgentCtor).toHaveBeenCalled();
    await result.release();
  });

  it("skips target DNS pinning in trusted explicit-proxy mode after hostname-policy checks", async () => {
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: agentCtor,
      EnvHttpProxyAgent: envHttpProxyAgentCtor,
      ProxyAgent: proxyAgentCtor,
      fetch: vi.fn(async () => okResponse()),
    };
    const lookupFn: LookupFn = vi.fn(async (hostname: string) => {
      if (hostname === "localhost") {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      throw new Error(`unexpected target DNS lookup for ${hostname}`);
    }) as unknown as LookupFn;
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await fetchWithSsrFGuard({
      url: "https://api.telegram.org/file/bot123/photos/test.jpg",
      fetchImpl,
      lookupFn,
      mode: GUARDED_FETCH_MODE.TRUSTED_EXPLICIT_PROXY,
      policy: { hostnameAllowlist: ["api.telegram.org"] },
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://localhost:6152",
        allowPrivateProxy: true,
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lookupFn).toHaveBeenCalledOnce();
    expect(lookupFn).toHaveBeenCalledWith("localhost", { all: true });
    await result.release();
  });

  it("still blocks off-allowlist targets in trusted explicit-proxy mode", async () => {
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: agentCtor,
      EnvHttpProxyAgent: envHttpProxyAgentCtor,
      ProxyAgent: proxyAgentCtor,
      fetch: vi.fn(async () => okResponse()),
    };
    const lookupFn: LookupFn = vi.fn(async (hostname: string) => {
      if (hostname === "localhost") {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      throw new Error(`unexpected target DNS lookup for ${hostname}`);
    }) as unknown as LookupFn;
    const fetchImpl = vi.fn(async () => okResponse());

    await expect(
      fetchWithSsrFGuard({
        url: "https://cdn.telegram.org/file/bot123/photos/test.jpg",
        fetchImpl,
        lookupFn,
        mode: GUARDED_FETCH_MODE.TRUSTED_EXPLICIT_PROXY,
        policy: { hostnameAllowlist: ["api.telegram.org"] },
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "http://localhost:6152",
          allowPrivateProxy: true,
        },
      }),
    ).rejects.toThrow(/allowlist|blocked/i);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookupFn).toHaveBeenCalledOnce();
    expect(lookupFn).toHaveBeenCalledWith("localhost", { all: true });
  });

  it("still blocks explicit proxy on localhost when allowPrivateProxy is false", async () => {
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: agentCtor,
      EnvHttpProxyAgent: envHttpProxyAgentCtor,
      ProxyAgent: proxyAgentCtor,
      fetch: vi.fn(async () => okResponse()),
    };
    const lookupFn: LookupFn = vi.fn(async (hostname: string) => {
      if (hostname === "localhost") {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      return [{ address: "149.154.167.220", family: 4 }];
    }) as unknown as LookupFn;
    const fetchImpl = vi.fn();

    await expect(
      fetchWithSsrFGuard({
        url: "https://api.telegram.org/file/bot123/photos/test.jpg",
        fetchImpl,
        lookupFn,
        policy: { hostnameAllowlist: ["api.telegram.org"] },
        dispatcherPolicy: {
          mode: "explicit-proxy",
          proxyUrl: "http://localhost:6152",
          allowPrivateProxy: false,
        },
      }),
    ).rejects.toThrow(/blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to DNS pinning in trusted proxy mode when no proxy env var is configured", async () => {
    clearProxyEnv();
    const lookupFn = createPublicLookup();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      expect(requestInit.dispatcher).toBeDefined();
      expect(getDispatcherClassName(requestInit.dispatcher)).not.toBe("EnvHttpProxyAgent");
      return okResponse();
    });

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      fetchImpl,
      lookupFn,
      mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lookupFn).toHaveBeenCalledOnce();
    await result.release();
  });
});
