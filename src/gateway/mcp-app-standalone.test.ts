import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  const serialized = params.body === undefined ? undefined : JSON.stringify(params.body);
  const req = Object.assign(Readable.from(serialized === undefined ? [] : [serialized]), {
    url: params.url,
    method: params.method ?? "GET",
    headers: {
      ...(params.authorization ? { authorization: params.authorization } : {}),
      ...(serialized ? { "content-type": "application/json" } : {}),
    },
    socket: {},
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

describe("MCP App standalone host", () => {
  beforeEach(() => {
    mcpAppStandaloneTesting.clearTickets();
    vi.clearAllMocks();
    mocks.completeRetirement.mockResolvedValue(undefined);
    Object.assign(view, {
      allowedAppToolNames: new Set(["shared", "app-only"]),
      readOnly: undefined,
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
    expect(body).not.toContain('postMessage(message, "*")');
    expect(body).not.toContain(view.html);
    expect(body).not.toContain("agent:main:main");
    expect(result.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(result.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringMatching(/script-src 'sha256-[^']+';.*connect-src 'self'/u),
    );
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
    });
    expect(
      (await request({ url: route, authorization: `MCP-App ${issued.ticket}` })).res.statusCode,
    ).toBe(200);
    mocks.getMcpAppViewLease.mockReturnValue({ ...view, viewId: "mcp-app-replaced" });
    expect(
      (await request({ url: route, authorization: `MCP-App ${issued.ticket}` })).res.statusCode,
    ).toBe(401);
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
    expect(runtime.callTool).toHaveBeenCalledWith("demo", "app-only", {});
    const resource = await invoke({ method: "resources/read", params: { uri: "ui://demo/state" } });
    expect(resource.res.statusCode).toBe(200);
    expect(runtime.readResource).toHaveBeenCalledWith("demo", "ui://demo/state");

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
