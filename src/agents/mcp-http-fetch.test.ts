/**
 * Regression coverage for MCP HTTP fetch wrappers.
 * Verifies SSRF-guarded fetch, scoped dispatcher behavior, and same-origin headers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "../infra/net/undici-runtime.js";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
  type FetchLike,
} from "./mcp-http-fetch.js";

const testGlobal = globalThis as Record<string, unknown>;
const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

class TestAgent {
  constructor(readonly options: unknown) {}
}

class TestEnvHttpProxyAgent {
  constructor(readonly options: unknown) {}
}

class TestProxyAgent {
  constructor(readonly options: unknown) {}
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { location },
  });
}

function getDispatcher(init: unknown): unknown {
  if (typeof init !== "object" || init === null || !("dispatcher" in init)) {
    return undefined;
  }
  return (init as { dispatcher?: unknown }).dispatcher;
}

function getDispatcherConnectOptions(init: unknown): Record<string, unknown> | undefined {
  const dispatcher = getDispatcher(init);
  if (!(dispatcher instanceof TestAgent)) {
    return undefined;
  }
  const options = dispatcher.options as { connect?: Record<string, unknown> };
  return options.connect;
}

describe("MCP HTTP fetch helpers", () => {
  const fetchCalls: Array<{
    url: string | URL | Request;
    init: unknown;
  }> = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("ALL_PROXY", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("all_proxy", "");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async (url: string | URL | Request, init?: unknown) => {
        fetchCalls.push({ url, init });
        return new Response("ok");
      },
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY];
  });

  it("scopes TLS overrides to the MCP resource origin", async () => {
    const fetch = buildMcpHttpFetch({
      sslVerify: false,
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await fetch("https://mcp.example.com/token");
    await fetch("https://auth.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestAgent);
    expect(getDispatcherConnectOptions(fetchCalls[0]?.init)).toMatchObject({
      rejectUnauthorized: false,
    });
    expect(getDispatcher(fetchCalls[1]?.init)).toBeInstanceOf(TestAgent);
    expect(
      getDispatcherConnectOptions(fetchCalls[1]?.init)?.["rejectUnauthorized"],
    ).toBeUndefined();
  });

  it("uses configured env proxy for ordinary MCP HTTP requests", async () => {
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await fetch("https://mcp.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestEnvHttpProxyAgent);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("keeps same-origin TLS overrides ahead of configured env proxy", async () => {
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    const fetch = buildMcpHttpFetch({
      sslVerify: false,
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await fetch("https://mcp.example.com/token");
    await fetch("https://auth.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestAgent);
    expect(getDispatcherConnectOptions(fetchCalls[0]?.init)).toMatchObject({
      rejectUnauthorized: false,
    });
    expect(getDispatcher(fetchCalls[1]?.init)).toBeInstanceOf(TestEnvHttpProxyAgent);
  });

  it("uses configured env proxy for redirected targets after a NO_PROXY first hop", async () => {
    vi.stubEnv("https_proxy", "http://proxy.example:8080");
    vi.stubEnv("no_proxy", "mcp.example.com");
    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async (url: string | URL | Request, init?: unknown) => {
        fetchCalls.push({ url, init });
        return fetchCalls.length === 1
          ? redirectResponse("https://auth.example.com/token")
          : new Response("ok");
      },
    };
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
    });

    await fetch("https://mcp.example.com/token");

    expect(getDispatcher(fetchCalls[0]?.init)).toBeInstanceOf(TestAgent);
    expect(getDispatcher(fetchCalls[1]?.init)).toBeInstanceOf(TestEnvHttpProxyAgent);
  });

  it("removes static Authorization headers for OAuth-backed runtime requests", () => {
    expect(
      withoutMcpAuthorizationHeader({
        Authorization: "Bearer static",
        "X-Tenant": "docs",
      }),
    ).toEqual({
      "X-Tenant": "docs",
    });
  });

  it("adds MCP headers only to same-origin OAuth requests", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push([url, init]);
      return new Response("ok");
    };
    const fetch = withSameOriginMcpHttpHeaders({
      fetchFn,
      resourceUrl: "https://mcp.example.com/mcp",
      headers: {
        "X-Tenant": "docs",
      },
    });

    await fetch("https://mcp.example.com/.well-known/oauth-protected-resource", {
      headers: { "MCP-Protocol-Version": "2025-06-18" },
    });
    await fetch("https://auth.example.com/token");

    expect(new Headers(calls[0]?.[1]?.headers).get("x-tenant")).toBe("docs");
    expect(new Headers(calls[0]?.[1]?.headers).get("mcp-protocol-version")).toBe("2025-06-18");
    expect(calls[1]?.[1]?.headers).toBeUndefined();
  });
});
