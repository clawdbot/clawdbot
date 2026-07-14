import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseErrorResponse } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
/**
 * Regression coverage for MCP HTTP fetch wrappers.
 * Verifies SSRF-guarded fetch, scoped dispatcher behavior, and same-origin headers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpHttpFetch,
  withoutMcpAuthorizationHeader,
  withSameOriginMcpHttpHeaders,
} from "./mcp-http-fetch.js";

const testGlobal = globalThis as Record<string, unknown>;
const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
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

function useBodylessForeignResponse(params: { text: string; contentLength?: string }) {
  const text = vi.fn(async () => params.text);
  const headers = new Headers({ "content-type": "application/json" });
  if (params.contentLength !== undefined) {
    headers.set("content-length", params.contentLength);
  }
  testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: TestAgent,
    EnvHttpProxyAgent: TestEnvHttpProxyAgent,
    ProxyAgent: TestProxyAgent,
    fetch: async () =>
      ({
        status: 400,
        statusText: "Bad Request",
        headers,
        body: null,
        ok: false,
        text,
      }) as unknown as Response,
  };
  return text;
}

async function fetchOAuthRegistrationError(): Promise<Response> {
  const fetch = buildMcpHttpFetch({ resourceUrl: "https://mcp.example.com/mcp" });
  return await fetch("https://auth.example.com/oauth/register", { method: "POST" });
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

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeLoopbackServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
}

function expectBoundedTimeout(error: unknown, undiciCode: string): void {
  if (error instanceof Error && error.name === "TimeoutError") {
    return;
  }
  expect(error).toMatchObject({
    name: "TypeError",
    cause: expect.objectContaining({ code: undiciCode }),
  });
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
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

  it.each([204, 205, 304])("preserves bodyless HTTP %s responses", async (status) => {
    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async () => new Response(null, { status }),
    };
    const fetch = buildMcpHttpFetch({ resourceUrl: "https://mcp.example.com/mcp" });

    const response = await fetch("https://mcp.example.com/mcp");

    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
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

  it.each([undefined, "64", "1048577"])(
    "drops body-less foreign OAuth text without trusting Content-Length %s",
    async (contentLength) => {
      const text = useBodylessForeignResponse({
        text: '{"error_description":"unbounded"}',
        contentLength,
      });

      const response = await fetchOAuthRegistrationError();

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(400);
      expect(response.body).toBeNull();
      expect(text).not.toHaveBeenCalled();
      const error = await parseErrorResponse(response);
      expect(error.message).toContain("HTTP 400");
    },
  );

  it("never materializes a body-less foreign response with a lying safe length", async () => {
    const text = useBodylessForeignResponse({
      text: "x".repeat(1024 * 1024 + 1),
      contentLength: "64",
    });

    const response = await fetchOAuthRegistrationError();

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(400);
    expect(response.body).toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  it.each(["headers", "body"] as const)(
    "aborts a hung OAuth request while awaiting %s",
    async (stage) => {
      delete testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY];
      const server = createServer((_request, response) => {
        if (stage === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"access_token":');
        }
      });
      const baseUrl = await listenOnLoopback(server);
      const fetch = buildMcpHttpFetch({ resourceUrl: `${baseUrl}/mcp`, timeoutMs: 500 });

      try {
        const pending = fetch(`${baseUrl}/token`, { method: "POST" });
        if (stage === "headers") {
          const error = await captureRejection(pending);
          expect(error).toBeDefined();
          expectBoundedTimeout(error, "UND_ERR_HEADERS_TIMEOUT");
          return;
        }
        const response = await pending;
        const error = await captureRejection(response.json());
        expect(error).toBeDefined();
        expectBoundedTimeout(error, "UND_ERR_BODY_TIMEOUT");
      } finally {
        await closeLoopbackServer(server);
      }
    },
  );

  it("composes caller cancellation with the configured timeout", async () => {
    const controller = new AbortController();
    testGlobal[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: TestAgent,
      EnvHttpProxyAgent: TestEnvHttpProxyAgent,
      ProxyAgent: TestProxyAgent,
      fetch: async (_url: string | URL | Request, init?: unknown) => {
        const signal =
          typeof init === "object" && init !== null && "signal" in init
            ? (init as { signal?: AbortSignal }).signal
            : undefined;
        controller.abort();
        expect(signal?.aborted).toBe(true);
        return new Response(null, { status: 204 });
      },
    };
    const fetch = buildMcpHttpFetch({
      resourceUrl: "https://mcp.example.com/mcp",
      timeoutMs: 60_000,
    });

    await fetch("https://mcp.example.com/token", { signal: controller.signal });
  });
});
