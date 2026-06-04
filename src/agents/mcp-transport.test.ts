import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMcpTransport } from "./mcp-transport.js";

type StreamableTransportOptions = {
  requestInit?: RequestInit;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  authProvider?: unknown;
};

const { lookupMock, runtimeFetchMock, streamableTransportConstructorMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  runtimeFetchMock: vi.fn(),
  streamableTransportConstructorMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

vi.mock("../infra/net/undici-runtime.js", () => ({
  createHttp1Agent: (options: unknown) => ({ options }),
  createHttp1EnvHttpProxyAgent: (options: unknown) => ({ options }),
  createHttp1ProxyAgent: (options: unknown) => ({ options }),
  loadUndiciRuntimeDeps: () => ({
    fetch: runtimeFetchMock,
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: function MockStreamableHTTPClientTransport(
    this: unknown,
    url: URL,
    options?: StreamableTransportOptions,
  ) {
    streamableTransportConstructorMock(url, options);
  },
}));

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { location },
  });
}

function redirectWithoutLocationResponse(status = 302): Response {
  return new Response(null, { status });
}

function latestStreamableTransportOptions(): StreamableTransportOptions {
  const latestCall = streamableTransportConstructorMock.mock.calls[
    streamableTransportConstructorMock.mock.calls.length - 1
  ] as unknown[] | undefined;
  const options = latestCall?.[1];
  if (!options || typeof options !== "object") {
    throw new Error("Expected streamable HTTP transport options");
  }
  return options as StreamableTransportOptions;
}

function latestStreamableFetch() {
  const fetch = latestStreamableTransportOptions().fetch;
  if (typeof fetch !== "function") {
    throw new Error("Expected streamable HTTP transport fetch");
  }
  return fetch;
}

function runtimeFetchCall(index: number): [RequestInfo | URL, RequestInit | undefined] {
  const call = runtimeFetchMock.mock.calls[index] as
    | [RequestInfo | URL, RequestInit | undefined]
    | undefined;
  if (!call) {
    throw new Error(`Expected runtime fetch call ${index}`);
  }
  return call;
}

describe("resolveMcpTransport", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    runtimeFetchMock.mockReset();
    streamableTransportConstructorMock.mockClear();
  });

  it("scrubs custom headers when streamable HTTP follows a cross-origin redirect", async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://redirect.example/next"))
      .mockResolvedValueOnce(new Response("ok"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      headers: {
        "X-Api-Key": "secret",
      },
    });

    const options = latestStreamableTransportOptions();
    expect(options.requestInit).toEqual({
      headers: {
        "X-Api-Key": "secret",
      },
    });
    expect(options.fetch).toBeTypeOf("function");

    await options.fetch?.("https://mcp.example.com/mcp", {
      method: "GET",
      headers: {
        accept: "application/json, text/event-stream",
        "user-agent": "node",
        "x-api-key": "secret",
      },
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeFetchCall(0)?.[0]).toBe("https://mcp.example.com/mcp");
    expect(runtimeFetchCall(0)?.[1]?.redirect).toBe("manual");
    expect(runtimeFetchCall(1)?.[0]).toBe("https://redirect.example/next");
    expect(runtimeFetchCall(1)?.[1]?.redirect).toBe("manual");

    const redirectedHeaders = new Headers(runtimeFetchCall(1)?.[1]?.headers);
    expect(redirectedHeaders.get("x-api-key")).toBeNull();
    expect(redirectedHeaders.get("accept")).toBe("application/json, text/event-stream");
    expect(redirectedHeaders.get("user-agent")).toBe("node");
  });

  it("blocks streamable HTTP redirects to private network targets", async () => {
    runtimeFetchMock.mockResolvedValueOnce(redirectResponse("http://169.254.169.254/latest"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
    });

    await expect(latestStreamableFetch()("https://mcp.example.com/mcp")).rejects.toThrow(
      "Blocked hostname or private/internal/special-use IP address",
    );

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves replayable request bodies for cross-origin streamable HTTP redirects", async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://redirect.example/mcp", 307))
      .mockResolvedValueOnce(new Response("ok"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      headers: {
        "X-Api-Key": "secret",
      },
    });

    const options = latestStreamableTransportOptions();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    await options.fetch?.("https://mcp.example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "secret",
      },
      body,
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeFetchCall(1)?.[0]).toBe("https://redirect.example/mcp");
    expect(runtimeFetchCall(1)?.[1]?.method).toBe("POST");
    expect(runtimeFetchCall(1)?.[1]?.body).toBe(body);

    const redirectedHeaders = new Headers(runtimeFetchCall(1)?.[1]?.headers);
    expect(redirectedHeaders.get("x-api-key")).toBeNull();
    expect(redirectedHeaders.get("content-type")).toBe("application/json");
  });

  it("allows same-url redirects when the request method changes", async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(redirectResponse("https://mcp.example.com/mcp", 303))
      .mockResolvedValueOnce(new Response("ok"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
    });

    const options = latestStreamableTransportOptions();

    await options.fetch?.("https://mcp.example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeFetchCall(1)?.[0]).toBe("https://mcp.example.com/mcp");
    expect(runtimeFetchCall(1)?.[1]?.method).toBe("GET");
    expect(runtimeFetchCall(1)?.[1]?.body).toBeUndefined();

    const redirectedHeaders = new Headers(runtimeFetchCall(1)?.[1]?.headers);
    expect(redirectedHeaders.get("content-type")).toBeNull();
  });

  it("rejects streamable HTTP redirect loops", async () => {
    runtimeFetchMock.mockResolvedValueOnce(redirectResponse("https://mcp.example.com/mcp"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
    });

    await expect(latestStreamableFetch()("https://mcp.example.com/mcp")).rejects.toThrow(
      "Redirect loop detected",
    );

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects streamable HTTP redirect chains beyond the limit", async () => {
    for (let index = 0; index <= 20; index += 1) {
      runtimeFetchMock.mockResolvedValueOnce(
        redirectResponse(`https://mcp.example.com/redirect-${index}`),
      );
    }

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
    });

    await expect(latestStreamableFetch()("https://mcp.example.com/mcp")).rejects.toThrow(
      "Too many redirects (limit: 20)",
    );

    expect(runtimeFetchMock).toHaveBeenCalledTimes(21);
  });

  it("rejects streamable HTTP redirect responses that do not include a location", async () => {
    const response = redirectWithoutLocationResponse();
    runtimeFetchMock.mockResolvedValueOnce(response);

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
    });

    await expect(latestStreamableFetch()("https://mcp.example.com/mcp")).rejects.toThrow(
      "Redirect missing location header (302)",
    );

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes OAuth providers and TLS options into HTTP transports", () => {
    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      auth: "oauth",
      headers: {
        Authorization: "Bearer static",
        "X-Tenant": "docs",
      },
      sslVerify: false,
    });

    const options = latestStreamableTransportOptions();
    expect(options.authProvider).toBeTypeOf("object");
    expect(options.fetch).toBeTypeOf("function");
    expect(options.requestInit).toBeUndefined();
  });

  it("keeps OAuth runtime headers scoped to the MCP resource origin", async () => {
    runtimeFetchMock.mockImplementation(async () => new Response("ok"));

    resolveMcpTransport("probe", {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      auth: "oauth",
      headers: {
        "X-Tenant": "docs",
      },
    });

    const options = latestStreamableTransportOptions();
    await options.fetch?.("https://mcp.example.com/mcp");
    await options.fetch?.("https://auth.example.com/token");

    expect(new Headers(runtimeFetchCall(0)?.[1]?.headers).get("x-tenant")).toBe("docs");
    expect(new Headers(runtimeFetchCall(1)?.[1]?.headers).get("x-tenant")).toBeNull();
  });
});
