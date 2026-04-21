import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-support/browser-security-runtime.mock.js";
import type { BrowserDispatchResponse } from "./routes/dispatcher.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: {
      url: string;
      init?: RequestInit;
      signal?: AbortSignal;
    }) => ({
      response: await fetch(params.url, {
        ...params.init,
        signal: params.signal,
      }),
      finalUrl: params.url,
      release: async () => {},
    }),
  };
});

function okDispatchResponse(): BrowserDispatchResponse {
  return { status: 200, body: { ok: true } };
}

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    gateway: {
      auth: {
        token: "loopback-token",
      },
    },
  })),
  resolveBrowserControlAuth: vi.fn(() => ({
    token: "loopback-token",
    password: undefined,
  })),
  getBridgeAuthForPort: vi.fn(() => null),
  startBrowserControlServiceFromConfig: vi.fn(async () => ({ ok: true })),
  dispatch: vi.fn(async (): Promise<BrowserDispatchResponse> => okDispatchResponse()),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("./control-service.js", () => ({
  createBrowserControlContext: vi.fn(() => ({})),
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
}));

vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: mocks.resolveBrowserControlAuth,
}));

vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: mocks.getBridgeAuthForPort,
}));

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: mocks.dispatch,
  })),
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

function stubJsonFetchOk() {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function expectThrownBrowserFetchError(
  request: () => Promise<unknown>,
  params: {
    contains: string[];
    omits?: string[];
  },
) {
  const thrown = await request().catch((err: unknown) => err);
  expect(thrown).toBeInstanceOf(Error);
  if (!(thrown instanceof Error)) {
    throw new Error(`Expected Error, got ${String(thrown)}`);
  }
  for (const snippet of params.contains) {
    expect(thrown.message).toContain(snippet);
  }
  for (const snippet of params.omits ?? []) {
    expect(thrown.message).not.toContain(snippet);
  }
  return thrown;
}

describe("fetchBrowserJson loopback auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const key of [
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
    ]) {
      vi.stubEnv(key, "");
    }
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "loopback-token");
    mocks.loadConfig.mockClear();
    mocks.loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "loopback-token",
        },
      },
    });
    mocks.startBrowserControlServiceFromConfig.mockReset().mockResolvedValue({ ok: true });
    mocks.dispatch.mockReset().mockResolvedValue(okDispatchResponse());
    mocks.resolveBrowserControlAuth.mockReset().mockReturnValue({
      token: "loopback-token",
      password: undefined,
    });
    mocks.getBridgeAuthForPort.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("adds bearer auth for loopback absolute HTTP URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    const res = await fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/");
    expect(res.ok).toBe(true);

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("does not inject auth for non-loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://example.com/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("keeps caller-supplied auth header", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://localhost:18888/", {
      headers: {
        Authorization: "Bearer caller-token",
      },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer caller-token");
  });

  it("injects auth for IPv6 loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://[::1]:18888/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("injects auth for IPv4-mapped IPv6 loopback URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://[::ffff:127.0.0.1]:18888/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("preserves dispatcher error context while keeping no-retry hint", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: ["Chrome CDP handshake timeout", "Do NOT retry the browser tool"],
      omits: ["Can't reach the OpenClaw browser control service"],
    });
  });

  it("surfaces 429 from HTTP URL as rate-limit error with no-retry hint", async () => {
    const response = new Response("max concurrent sessions exceeded", { status: 429 });
    const text = vi.spyOn(response, "text");
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/"),
      {
        contains: ["Browser service rate limit reached", "Do NOT retry the browser tool"],
        omits: ["max concurrent sessions exceeded"],
      },
    );
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("surfaces 429 from HTTP URL without body detail when empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 429 })),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/"),
      {
        contains: ["rate limit reached", "Do NOT retry the browser tool"],
      },
    );
  });

  it("keeps Browserbase-specific wording for Browserbase 429 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("max concurrent sessions exceeded", { status: 429 })),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("https://connect.browserbase.com/session"),
      {
        contains: ["Browserbase rate limit reached", "upgrade your plan"],
        omits: ["max concurrent sessions exceeded"],
      },
    );
  });

  it("non-429 errors still produce generic messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("internal error", { status: 500 })),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/"),
      {
        contains: ["internal error"],
        omits: ["rate limit"],
      },
    );
  });

  it("surfaces 429 from dispatcher path as rate-limit error", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: 429,
      body: { error: "too many sessions" },
    });

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: ["Browser service rate limit reached", "Do NOT retry the browser tool"],
      omits: ["too many sessions"],
    });
  });

  it("keeps absolute URL failures wrapped as reachability errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://example.com/"),
      {
        contains: [
          "Can't reach the OpenClaw browser control service",
          "Do NOT retry the browser tool",
        ],
      },
    );
  });
});
