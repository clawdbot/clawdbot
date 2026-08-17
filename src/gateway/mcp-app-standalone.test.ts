import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, request as requestHttp } from "node:http";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../packages/gateway-client/src/timeouts.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const mocks = vi.hoisted(() => ({
  completeRetirement: vi.fn(),
  getMcpAppViewLease: vi.fn(),
  peekSessionMcpRuntime: vi.fn(),
}));

vi.mock("../agents/agent-bundle-mcp-runtime.js", () => ({
  completeDeferredSessionMcpRuntimeRetirement: mocks.completeRetirement,
  peekSessionMcpRuntime: mocks.peekSessionMcpRuntime,
}));
vi.mock("../agents/mcp-ui-resource.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/mcp-ui-resource.js")>()),
  getMcpAppViewLease: mocks.getMcpAppViewLease,
}));

import {
  createMcpAppStandaloneTicket,
  handleMcpAppStandaloneHttpRequest,
  mcpAppStandaloneTesting,
  verifyMcpAppStandaloneTicket,
} from "./mcp-app-standalone.js";

function issueTicket(params: Parameters<typeof createMcpAppStandaloneTicket>[0]) {
  const issued = createMcpAppStandaloneTicket(params);
  if (!issued) {
    throw new Error("ticket capacity unexpectedly exhausted");
  }
  return issued;
}

const nowMs = 1_800_000_000_000;
const secret = Buffer.alloc(32, 7);
const viewOperationTimeoutMs = 10 * 60_000;
const releaseRuntimeLease = vi.fn();
const runtime = {
  sessionId: "runtime-session",
  mcpAppsEnabled: true,
  markUsed: vi.fn(),
  acquireLease: vi.fn(() => releaseRuntimeLease),
  getCatalog: vi.fn(async () => ({
    tools: [
      { serverName: "demo", toolName: "shared" },
      { serverName: "demo", toolName: "app-only", uiVisibility: ["app"] },
      { serverName: "demo", toolName: "model-only", uiVisibility: ["model"] },
      { serverName: "other", toolName: "cross-only", uiVisibility: ["app"] },
    ],
  })),
  callTool: vi.fn(async (serverName: string, toolName: string) => ({
    content: [{ type: "text", text: `${serverName}:${toolName}` }],
  })),
  listTools: vi.fn(async () => ({
    tools: [
      { name: "shared", inputSchema: { type: "object" } },
      { name: "app-only", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
      {
        name: "model-only",
        inputSchema: { type: "object" },
        _meta: { ui: { visibility: ["model"] } },
      },
    ],
  })),
  listResources: vi.fn(async () => [{ uri: "ui://demo/state", name: "state" }]),
  listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
  readResource: vi.fn(async (serverName: string, uri: string) => ({
    contents: [{ uri, text: `${serverName}:${uri}` }],
  })),
};
const view = {
  viewId: "mcp-app-view",
  agentId: "main",
  sessionId: runtime.sessionId,
  runtime,
  serverName: "demo",
  toolName: "weather",
  uiResourceUri: "ui://demo/app",
  html: "<!doctype html><p>private fixture</p>",
  csp: { connectDomains: ["https://api.example.com"] },
  allowedAppToolNames: new Set(["shared", "app-only"]),
  toolInput: { city: "Paris" },
  toolResult: { content: [{ type: "text", text: "sunny" }] },
  operationTimeoutMs: viewOperationTimeoutMs,
  expiresAtMs: nowMs + 10 * 60_000,
  requestWindowStartedAtMs: nowMs,
  requestCount: 0,
  toolCallCount: 0,
  activeRequests: 0,
  byteSize: 100,
};

async function request(params: {
  url: string;
  method?: "GET" | "HEAD" | "POST";
  authorization?: string;
  clock?: () => number;
  now?: number;
  body?: unknown;
}) {
  const { res, end, setHeader } = makeMockHttpResponse();
  const socket = new EventEmitter();
  Object.assign(res, { socket });
  const serialized = params.body === undefined ? undefined : JSON.stringify(params.body);
  const req = Object.assign(Readable.from(serialized === undefined ? [] : [serialized]), {
    url: params.url,
    method: params.method ?? "GET",
    headers: {
      ...(params.authorization ? { authorization: params.authorization } : {}),
      ...(serialized ? { "content-type": "application/json" } : {}),
    },
    socket,
  }) as IncomingMessage;
  const handled = await handleMcpAppStandaloneHttpRequest(req, res, {
    gatewayPort: 18_789,
    sandboxPort: 18_790,
    now: params.clock,
    nowMs: params.now ?? nowMs,
    ticketSecret: secret,
  });
  return { handled, res, end, setHeader };
}

async function launchStandaloneHostWithStalledFetch(stallPhase: "fetch" | "body" = "fetch") {
  const shell = await request({ url: "/__openclaw__/mcp-app" });
  const body = String(shell.end.mock.calls[0]?.[0]);
  const script = body.match(/<script>([\s\S]*)<\/script>/u)?.[1];
  if (!script) {
    throw new Error("standalone host script missing");
  }
  const listeners = new Map<string, Array<() => void>>();
  const replaceChildren = vi.fn();
  let requestSignal: AbortSignal | undefined;
  const requestAbortError = () =>
    requestSignal?.reason instanceof Error ? requestSignal.reason : new Error("request aborted");
  const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    if (stallPhase === "body") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            requestSignal?.addEventListener("abort", () => reject(requestAbortError()), {
              once: true,
            });
          }),
      } as Response);
    }
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => reject(requestAbortError()), { once: true });
    });
  });
  runInNewContext(script, {
    AbortController,
    AbortSignal,
    URL,
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    clearTimeout,
    document: {
      createElement: () => ({
        className: "",
        contentWindow: undefined,
        referrerPolicy: "",
        remove: vi.fn(),
        setAttribute: vi.fn(),
        src: "",
        style: { height: "" },
        textContent: "",
        title: "",
      }),
      getElementById: () => ({ replaceChildren }),
    },
    fetch,
    innerWidth: 1024,
    location: { hash: "#ticket", origin: "http://127.0.0.1:18789" },
    matchMedia: () => ({ matches: false }),
    navigator: { language: "en-US" },
    setTimeout,
  });
  return {
    emit: (type: string) => {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    },
    fetch,
    getRequestSignal: () => requestSignal,
    replaceChildren,
  };
}

async function launchStandaloneHostWithStalledOperation(operationTimeoutMs: number) {
  const shell = await request({ url: "/__openclaw__/mcp-app" });
  const body = String(shell.end.mock.calls[0]?.[0]);
  const script = body.match(/<script>([\s\S]*)<\/script>/u)?.[1];
  if (!script) {
    throw new Error("standalone host script missing");
  }
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  const frameWindow = { postMessage: vi.fn() };
  let requestSignal: AbortSignal | undefined;
  const requestAbortError = () =>
    requestSignal?.reason instanceof Error ? requestSignal.reason : new Error("request aborted");
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        sandboxUrl: "/mcp-app-sandbox",
        sandboxPort: 18_790,
        html: "<!doctype html><p>private fixture</p>",
        toolInput: {},
        toolResult: {},
        serverTools: true,
        operationTimeoutMs,
      }),
    } as Response)
    .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestAbortError()), { once: true });
      });
    });
  runInNewContext(script, {
    AbortController,
    URL,
    addEventListener: (type: string, listener: (event?: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    clearTimeout,
    document: {
      createElement: () => ({
        className: "",
        contentWindow: frameWindow,
        referrerPolicy: "",
        remove: vi.fn(),
        setAttribute: vi.fn(),
        src: "",
        style: { height: "" },
        textContent: "",
        title: "",
      }),
      getElementById: () => ({ replaceChildren: vi.fn() }),
    },
    fetch,
    innerWidth: 1024,
    location: { hash: "#ticket", origin: "http://127.0.0.1:18789" },
    matchMedia: () => ({ matches: false }),
    navigator: { language: "en-US" },
    setTimeout,
  });
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
  const emitMessage = (data: unknown) => {
    for (const listener of listeners.get("message") ?? []) {
      listener({ data, origin: "http://127.0.0.1:18790", source: frameWindow });
    }
  };
  emitMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "ui/initialize",
    params: {
      protocolVersion: "2026-01-26",
      appInfo: { name: "test", version: "1.0.0" },
      appCapabilities: {},
    },
  });
  emitMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  emitMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow" } });
  return { fetch, getRequestSignal: () => requestSignal };
}

describe("MCP App standalone host", () => {
  beforeEach(() => {
    mcpAppStandaloneTesting.clearTickets();
    vi.clearAllMocks();
    mocks.completeRetirement.mockResolvedValue(undefined);
    Object.assign(view, {
      allowedAppToolNames: new Set(["shared", "app-only"]),
      readOnly: undefined,
      operationTimeoutMs: viewOperationTimeoutMs,
      requestWindowStartedAtMs: nowMs,
      requestCount: 0,
      toolCallCount: 0,
      activeRequests: 0,
    });
    mocks.peekSessionMcpRuntime.mockReturnValue(runtime);
    mocks.getMcpAppViewLease.mockReturnValue(view);
  });

  it("mints an opaque ticket bound to the session, runtime, view, and lease", () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    expect(issued.ticket).toMatch(/^v1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/u);
    expect(issued.ticket).not.toContain("agent:main:main");
    expect(issued.expiresAtMs).toBe(nowMs + 2 * 60_000);
    expect(issueTicket({ sessionKey: "agent:main:main", view, nowMs: nowMs + 1, secret })).toEqual(
      issued,
    );
    expect(
      verifyMcpAppStandaloneTicket(issued.ticket, {
        sessionKey: "agent:main:main",
        sessionId: runtime.sessionId,
        viewId: view.viewId,
        nowMs,
        secret,
      }),
    ).toBeDefined();
    for (const expected of [
      { sessionKey: "agent:other:main" },
      { sessionId: "other-runtime" },
      { viewId: "mcp-app-other" },
    ]) {
      expect(
        verifyMcpAppStandaloneTicket(issued.ticket, { ...expected, nowMs, secret }),
      ).toBeUndefined();
    }
    expect(
      verifyMcpAppStandaloneTicket(`${issued.ticket.slice(0, -1)}x`, { nowMs, secret }),
    ).toBeUndefined();
    expect(
      verifyMcpAppStandaloneTicket(issued.ticket, { nowMs: issued.expiresAtMs + 1, secret }),
    ).toBeUndefined();
  });

  it("bounds ticket lifetime and omits issuance at capacity", () => {
    const shortView = { ...view, expiresAtMs: nowMs + 1_000 };
    expect(issueTicket({ sessionKey: "short", view: shortView, nowMs, secret }).expiresAtMs).toBe(
      nowMs + 1_000,
    );
    mcpAppStandaloneTesting.clearTickets();
    for (let index = 0; index < 256; index += 1) {
      expect(
        createMcpAppStandaloneTicket({
          sessionKey: `agent:${index}`,
          view: { ...view, viewId: `mcp-app-${index}` },
          nowMs,
          secret,
        }),
      ).toBeDefined();
    }
    expect(
      createMcpAppStandaloneTicket({
        sessionKey: "agent:overflow",
        view: { ...view, viewId: "mcp-app-overflow" },
        nowMs,
        secret,
      }),
    ).toBeUndefined();
  });

  it("serves a hash-protected static shell without per-view data", async () => {
    const result = await request({ url: "/__openclaw__/mcp-app" });
    expect(result.handled).toBe(true);
    expect(result.res.statusCode).toBe(200);
    const body = String(result.end.mock.calls[0]?.[0]);
    expect(body).toContain("location.hash");
    expect(body).toContain("event.origin");
    expect(body).toContain("if (!initializeAccepted)");
    expect(body).not.toContain("MCP_APP_STANDALONE_INITIAL_LOAD_TIMEOUT_MS");
    expect(body).not.toContain('postMessage(message, "*")');
    expect(body).not.toContain(view.html);
    expect(body).not.toContain("agent:main:main");
    expect(result.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(result.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringMatching(/script-src 'sha256-[^']+';.*connect-src 'self'/u),
    );
  });

  it.each(["fetch", "body"] as const)(
    "leaves the stalled standalone view %s to the server deadline and page lifecycle",
    async (stallPhase) => {
      vi.useFakeTimers();
      try {
        const host = await launchStandaloneHostWithStalledFetch(stallPhase);
        expect(host.fetch).toHaveBeenCalledOnce();
        expect(host.getRequestSignal()).toBeDefined();
        await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
        expect(host.getRequestSignal()?.aborted).toBe(false);
        expect(host.replaceChildren).not.toHaveBeenCalled();
        host.emit("pagehide");
        expect(host.getRequestSignal()?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("cancels a running standalone operation when the HTTP client disconnects", async () => {
    view.operationTimeoutMs = 300;
    let operationSignal: AbortSignal | undefined;
    let resolveOperationStarted: (() => void) | undefined;
    const operationStarted = new Promise<void>((resolve) => {
      resolveOperationStarted = resolve;
    });
    runtime.callTool.mockImplementationOnce(async (_serverName, _toolName, _args, options) => {
      operationSignal = options?.signal;
      resolveOperationStarted?.();
      return await new Promise((resolve, reject) => {
        operationSignal?.addEventListener(
          "abort",
          () => {
            reject(
              operationSignal?.reason instanceof Error
                ? operationSignal.reason
                : new Error("standalone MCP App operation aborted"),
            );
          },
          { once: true },
        );
      });
    });

    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    let resolveHandled: ((handled: boolean) => void) | undefined;
    let rejectHandled: ((error: unknown) => void) | undefined;
    const handled = new Promise<boolean>((resolve, reject) => {
      resolveHandled = resolve;
      rejectHandled = reject;
    });
    const server = createServer((req, res) => {
      void handleMcpAppStandaloneHttpRequest(req, res, {
        gatewayPort: 18_789,
        sandboxPort: 18_790,
        nowMs,
        ticketSecret: secret,
      }).then(resolveHandled, rejectHandled);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("standalone disconnect test server did not bind a TCP port");
      }
      const client = requestHttp({
        host: "127.0.0.1",
        port: address.port,
        path: "/__openclaw__/mcp-app/view",
        method: "POST",
        headers: {
          Authorization: `MCP-App ${issued.ticket}`,
          "Content-Type": "application/json",
        },
      });
      client.on("error", () => {});
      client.end(
        JSON.stringify({
          method: "tools/call",
          params: { name: "shared", arguments: {} },
        }),
      );

      await operationStarted;
      expect(view.activeRequests).toBe(1);
      client.destroy();

      const abortedPromptly = await Promise.race([
        new Promise<boolean>((resolve) => {
          operationSignal?.addEventListener("abort", () => resolve(true), { once: true });
        }),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 100);
        }),
      ]);
      expect(abortedPromptly).toBe(true);
      await expect(handled).resolves.toBe(true);
      expect(operationSignal?.aborted).toBe(true);
      expect(view.activeRequests).toBe(0);
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    } finally {
      await handled.catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      view.operationTimeoutMs = viewOperationTimeoutMs;
    }
  });

  it("keeps slow standalone operations within the MCP deadline alive past the gateway default", async () => {
    vi.useFakeTimers();
    try {
      const operationTimeoutMs = DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS * 3;
      const host = await launchStandaloneHostWithStalledOperation(operationTimeoutMs);
      expect(host.fetch).toHaveBeenCalledTimes(2);
      expect(host.getRequestSignal()).toBeDefined();
      await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
      expect(host.getRequestSignal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(operationTimeoutMs - DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
      expect(host.getRequestSignal()?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns capabilities only for handlers installed on the live view", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    const route = "/__openclaw__/mcp-app/view";
    expect((await request({ url: route })).res.statusCode).toBe(401);
    expect((await request({ url: `${route}?ticket=${issued.ticket}` })).res.statusCode).toBe(401);
    const accepted = await request({ url: route, authorization: `MCP-App ${issued.ticket}` });
    expect(accepted.res.statusCode).toBe(200);
    expect(JSON.parse(String(accepted.end.mock.calls[0]?.[0]))).toMatchObject({
      html: view.html,
      sandboxPort: 18_790,
      serverTools: true,
      serverResources: true,
      operationTimeoutMs: addTimerTimeoutGraceMs(viewOperationTimeoutMs),
    });
    expect(
      (await request({ url: route, authorization: `MCP-App ${issued.ticket}` })).res.statusCode,
    ).toBe(200);
    mocks.getMcpAppViewLease.mockReturnValue({ ...view, viewId: "mcp-app-replaced" });
    expect(
      (await request({ url: route, authorization: `MCP-App ${issued.ticket}` })).res.statusCode,
    ).toBe(401);
  });

  it("returns the view-owned operation deadline without consulting the runtime catalog", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    const accepted = await request({
      url: "/__openclaw__/mcp-app/view",
      authorization: `MCP-App ${issued.ticket}`,
    });

    expect(accepted.res.statusCode).toBe(200);
    expect(JSON.parse(String(accepted.end.mock.calls[0]?.[0]))).toMatchObject({
      operationTimeoutMs: addTimerTimeoutGraceMs(viewOperationTimeoutMs),
    });
    expect(runtime.getCatalog).not.toHaveBeenCalled();
  });

  it("executes only owning-server app-visible allowed tools and resources", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    const invoke = (body: unknown) =>
      request({
        url: "/__openclaw__/mcp-app/view",
        method: "POST",
        authorization: `MCP-App ${issued.ticket}`,
        body,
      });

    const tool = await invoke({
      method: "tools/call",
      params: { name: "app-only", arguments: {} },
    });
    expect(tool.res.statusCode).toBe(200);
    expect(runtime.callTool).toHaveBeenCalledWith(
      "demo",
      "app-only",
      {},
      {
        signal: expect.any(AbortSignal),
      },
    );
    const toolSignal = runtime.callTool.mock.calls[0]?.[3]?.signal;
    expect(runtime.getCatalog).toHaveBeenCalledWith({ signal: toolSignal });
    const resource = await invoke({ method: "resources/read", params: { uri: "ui://demo/state" } });
    expect(resource.res.statusCode).toBe(200);
    expect(runtime.readResource).toHaveBeenCalledWith("demo", "ui://demo/state", {
      signal: expect.any(AbortSignal),
    });

    for (const name of ["model-only", "not-allowed", "cross-only"]) {
      expect(
        (await invoke({ method: "tools/call", params: { name, arguments: {} } })).res.statusCode,
      ).toBe(403);
    }
    expect(runtime.callTool).toHaveBeenCalledTimes(1);
    expect(releaseRuntimeLease).toHaveBeenCalled();
    expect(mocks.completeRetirement).toHaveBeenCalledWith(runtime);
  });

  it("keeps reconstructed views read-only while preserving resource reads", async () => {
    Object.assign(view, { readOnly: true });
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    const invoke = (body: unknown) =>
      request({
        url: "/__openclaw__/mcp-app/view",
        method: "POST",
        authorization: `MCP-App ${issued.ticket}`,
        body,
      });
    expect(
      (await invoke({ method: "tools/call", params: { name: "app-only", arguments: {} } })).res
        .statusCode,
    ).toBe(403);
    expect(
      (await invoke({ method: "resources/read", params: { uri: "ui://demo/state" } })).res
        .statusCode,
    ).toBe(200);
  });

  it("does not accept standalone tool operations without explicit run authority", async () => {
    Object.assign(view, { allowedAppToolNames: undefined });
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    const invoke = (body: unknown) =>
      request({
        url: "/__openclaw__/mcp-app/view",
        method: "POST",
        authorization: `MCP-App ${issued.ticket}`,
        body,
      });

    expect((await invoke({ method: "tools/list", params: {} })).res.statusCode).toBe(403);
    expect(
      (await invoke({ method: "tools/call", params: { name: "app-only", arguments: {} } })).res
        .statusCode,
    ).toBe(403);
    expect(
      (await invoke({ method: "resources/read", params: { uri: "ui://demo/state" } })).res
        .statusCode,
    ).toBe(200);
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it("revalidates expiry and enforces request concurrency through the ticket boundary", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    const invoke = (now: number) =>
      request({
        url: "/__openclaw__/mcp-app/view",
        method: "POST",
        authorization: `MCP-App ${issued.ticket}`,
        now,
        body: { method: "resources/list", params: {} },
      });
    view.activeRequests = 4;
    expect(
      (
        await request({
          url: "/__openclaw__/mcp-app/view",
          authorization: `MCP-App ${issued.ticket}`,
          now: nowMs,
        })
      ).res.statusCode,
    ).toBe(429);
    expect((await invoke(nowMs)).res.statusCode).toBe(403);
    view.activeRequests = 0;
    expect((await invoke(issued.expiresAtMs + 1)).res.statusCode).toBe(401);

    const clock = vi
      .fn<() => number>()
      .mockReturnValueOnce(nowMs)
      .mockReturnValueOnce(issued.expiresAtMs + 1);
    expect(
      (
        await request({
          url: "/__openclaw__/mcp-app/view",
          method: "POST",
          authorization: `MCP-App ${issued.ticket}`,
          clock,
          body: { method: "resources/list", params: {} },
        })
      ).res.statusCode,
    ).toBe(401);
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("is path-scoped and rejects malformed operations", async () => {
    const issued = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret });
    expect((await request({ url: "/__openclaw__/mcp-app", method: "POST" })).res.statusCode).toBe(
      404,
    );
    expect((await request({ url: "/__openclaw__/mcp-app/other" })).handled).toBe(false);
    expect(
      (
        await request({
          url: "/__openclaw__/mcp-app/view",
          method: "POST",
          authorization: `MCP-App ${issued.ticket}`,
          body: { method: "gateway.call", params: {} },
        })
      ).res.statusCode,
    ).toBe(400);
  });

});
