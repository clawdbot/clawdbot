import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockHttpResponse } from "./test-http-response.js";

const mocks = vi.hoisted(() => ({
  getMcpAppViewLease: vi.fn(),
  peekSessionMcpRuntime: vi.fn(),
}));

vi.mock("../agents/agent-bundle-mcp-runtime.js", () => ({
  peekSessionMcpRuntime: mocks.peekSessionMcpRuntime,
}));
vi.mock("../agents/mcp-ui-resource.js", () => ({
  getMcpAppViewLease: mocks.getMcpAppViewLease,
}));

import {
  createMcpAppStandaloneTicket,
  handleMcpAppStandaloneHttpRequest,
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
const runtime = { sessionId: "runtime-session", mcpAppsEnabled: true };
const view = {
  viewId: "mcp-app-view",
  sessionId: runtime.sessionId,
  runtime,
  html: "<!doctype html><p>private fixture</p>",
  csp: { connectDomains: ["https://api.example.com"] },
  toolInput: { city: "Paris" },
  toolResult: { content: [{ type: "text", text: "sunny" }] },
  expiresAtMs: nowMs + 10 * 60_000,
};

function request(params: {
  url: string;
  method?: "GET" | "HEAD" | "POST";
  authorization?: string;
  now?: number;
}) {
  const { res, end, setHeader } = makeMockHttpResponse();
  const handled = handleMcpAppStandaloneHttpRequest(
    {
      url: params.url,
      method: params.method ?? "GET",
      headers: params.authorization ? { authorization: params.authorization } : {},
      socket: {},
    } as IncomingMessage,
    res,
    {
      gatewayPort: 18_789,
      sandboxPort: 18_790,
      nowMs: params.now ?? nowMs,
      ticketSecret: secret,
    },
  );
  return { handled, res, end, setHeader };
}

describe("MCP App standalone host", () => {
  beforeEach(() => {
    mocks.peekSessionMcpRuntime.mockReset().mockReturnValue(runtime);
    mocks.getMcpAppViewLease.mockReset().mockReturnValue(view);
  });

  it("mints a short-lived opaque ticket bound to the runtime session and view", () => {
    const issued = issueTicket({
      sessionKey: "agent:main:main",
      view,
      nowMs,
      secret,
    });

    expect(issued.ticket).toMatch(/^v1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/u);
    expect(issued.ticket).not.toContain("agent:main:main");
    expect(issued.expiresAtMs).toBe(nowMs + 2 * 60_000);
    expect(
      issueTicket({
        sessionKey: "agent:main:main",
        view,
        nowMs: nowMs + 1,
        secret,
      }),
    ).toEqual(issued);
    const refreshed = issueTicket({
      sessionKey: "agent:main:main",
      view,
      nowMs: issued.expiresAtMs - 10_000,
      secret,
    });
    expect(refreshed.ticket).not.toBe(issued.ticket);
    expect(refreshed.expiresAtMs).toBeGreaterThan(issued.expiresAtMs);
    expect(
      verifyMcpAppStandaloneTicket(issued.ticket, {
        nowMs: issued.expiresAtMs - 10_000,
        secret,
      }),
    ).toBeDefined();
    expect(
      verifyMcpAppStandaloneTicket(issued.ticket, {
        sessionKey: "agent:main:main",
        sessionId: runtime.sessionId,
        viewId: view.viewId,
        nowMs,
        secret,
      }),
    ).toMatchObject({ sessionKey: "agent:main:main", viewId: view.viewId });

    expect(
      verifyMcpAppStandaloneTicket(issued.ticket, {
        sessionKey: "agent:other:main",
        sessionId: runtime.sessionId,
        viewId: view.viewId,
        nowMs,
        secret,
      }),
    ).toBeUndefined();
    expect(
      verifyMcpAppStandaloneTicket(issued.ticket, {
        sessionKey: "agent:main:main",
        sessionId: "other-runtime",
        viewId: view.viewId,
        nowMs,
        secret,
      }),
    ).toBeUndefined();
    expect(
      verifyMcpAppStandaloneTicket(issued.ticket, {
        sessionKey: "agent:main:main",
        sessionId: runtime.sessionId,
        viewId: "mcp-app-other",
        nowMs,
        secret,
      }),
    ).toBeUndefined();
    expect(
      verifyMcpAppStandaloneTicket(`${issued.ticket.slice(0, -1)}x`, {
        nowMs,
        secret,
      }),
    ).toBeUndefined();
    expect(
      verifyMcpAppStandaloneTicket(issued.ticket, {
        nowMs: issued.expiresAtMs + 1,
        secret,
      }),
    ).toBeUndefined();
  });

  it("never lets a ticket outlive the view lease", () => {
    const shortLived = issueTicket({
      sessionKey: "agent:main:main",
      view: { ...view, expiresAtMs: nowMs + 1_000 },
      nowMs,
      secret,
    });
    expect(shortLived.expiresAtMs).toBe(nowMs + 1_000);
    expect(
      issueTicket({
        sessionKey: "agent:main:main",
        view: { ...view, expiresAtMs: nowMs + 1_000 },
        nowMs: nowMs + 500,
        secret,
      }),
    ).toEqual(shortLived);
    expect(
      createMcpAppStandaloneTicket({
        sessionKey: "agent:main:main",
        view: { ...view, expiresAtMs: nowMs },
        nowMs,
        secret,
      }),
    ).toBeUndefined();
  });

  it("serves a static shell without embedding tickets or per-view data", () => {
    const result = request({ url: "/__openclaw__/mcp-app" });

    expect(result.handled).toBe(true);
    expect(result.res.statusCode).toBe(200);
    const body = String(result.end.mock.calls[0]?.[0]);
    expect(body).toContain("location.hash");
    expect(body).not.toContain("serverTools");
    expect(body).not.toContain("serverResources");
    expect(body).not.toContain(view.html);
    expect(body).not.toContain("agent:main:main");
    expect(result.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(result.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringContaining("connect-src 'self'"),
    );
  });

  it("returns view data only for a valid ticket backed by the same live view", () => {
    const issued = issueTicket({
      sessionKey: "agent:main:main",
      view,
      nowMs,
      secret,
    });
    const route = "/__openclaw__/mcp-app/view";

    expect(request({ url: route }).res.statusCode).toBe(401);
    expect(request({ url: `${route}?ticket=${issued.ticket}` }).res.statusCode).toBe(401);
    expect(
      request({ url: route, authorization: `MCP-App ${issued.ticket.slice(0, -1)}x` }).res
        .statusCode,
    ).toBe(401);

    const accepted = request({ url: route, authorization: `MCP-App ${issued.ticket}` });
    expect(accepted.res.statusCode).toBe(200);
    const payload = JSON.parse(String(accepted.end.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      html: view.html,
      toolInput: view.toolInput,
      toolResult: view.toolResult,
      sandboxPort: 18_790,
    });
    expect(payload.sandboxUrl).toMatch(/^\/mcp-app-sandbox\?csp=/u);
    expect(accepted.setHeader).toHaveBeenCalledWith("Vary", "Authorization");

    // Reloads within the ticket and view lease are appropriate reuse.
    expect(request({ url: route, authorization: `MCP-App ${issued.ticket}` }).res.statusCode).toBe(
      200,
    );

    mocks.getMcpAppViewLease.mockReturnValue({ ...view, viewId: "mcp-app-replaced" });
    expect(request({ url: route, authorization: `MCP-App ${issued.ticket}` }).res.statusCode).toBe(
      401,
    );
  });

  it("keeps the standalone surface read-only and path-scoped", () => {
    expect(request({ url: "/__openclaw__/mcp-app", method: "POST" }).res.statusCode).toBe(404);
    expect(request({ url: "/__openclaw__/mcp-app/other" }).handled).toBe(false);
  });
});
