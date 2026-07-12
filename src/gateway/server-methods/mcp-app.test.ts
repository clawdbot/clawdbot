import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeDeferredSessionMcpRuntimeRetirement: vi.fn(),
  getMcpAppViewLease: vi.fn(),
  peekSessionMcpRuntime: vi.fn(),
}));

vi.mock("../../agents/mcp-ui-resource.js", () => ({
  getMcpAppViewLease: mocks.getMcpAppViewLease,
  acquireMcpAppViewRequest: () => () => {},
}));
vi.mock("../../agents/mcp-app-sandbox.js", () => ({
  buildMcpAppSandboxPath: () => "mcp-app-sandbox",
}));
vi.mock("../../agents/agent-bundle-mcp-runtime.js", () => ({
  completeDeferredSessionMcpRuntimeRetirement: mocks.completeDeferredSessionMcpRuntimeRetirement,
  peekSessionMcpRuntime: mocks.peekSessionMcpRuntime,
}));

import { mcpAppHandlers } from "./mcp-app.js";

const view = {
  viewId: "cv_app",
  sessionId: "session-1",
  serverName: "demo",
  toolName: "show",
  uiResourceUri: "ui://demo/app",
  html: "<html>demo</html>",
  allowedAppToolNames: undefined as ReadonlySet<string> | undefined,
  toolInput: { city: "Paris" },
  toolResult: { content: [{ type: "text", text: "ok" }] },
  expiresAtMs: Date.now() + 60_000,
  requestWindowStartedAtMs: Date.now(),
  requestCount: 0,
  toolCallCount: 0,
  activeRequests: 0,
};

function runtime() {
  const releaseLease = vi.fn();
  return {
    sessionId: "session-1",
    mcpAppsEnabled: true,
    markUsed: vi.fn(),
    acquireLease: vi.fn(() => releaseLease),
    getCatalog: vi.fn(async () => ({
      tools: [
        { serverName: "demo", toolName: "shared" },
        { serverName: "demo", toolName: "app-only", uiVisibility: ["app"] },
        { serverName: "demo", toolName: "model-only", uiVisibility: ["model"] },
      ],
    })),
    callTool: vi.fn(async (_serverName: string, toolName: string) => ({
      content: [{ type: "text", text: toolName }],
    })),
    listTools: vi.fn(async () => ({
      tools: [
        { name: "shared", inputSchema: { type: "object" } },
        {
          name: "app-only",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: ["app"] } },
        },
        {
          name: "model-only",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    })),
  };
}

async function invoke(method: keyof typeof mcpAppHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  await expectDefined(
    mcpAppHandlers[method],
    "mcpAppHandlers[method] test invariant",
  )({
    respond,
    params,
    context: {
      getMcpAppSandboxPort: () => 18790,
      getRuntimeConfig: () => ({
        mcp: { apps: { enabled: true, sandboxOrigin: "https://apps.example.com" } },
      }),
    },
  } as never);
  return respond;
}

describe("MCP App gateway bridge", () => {
  beforeEach(() => {
    view.requestCount = 0;
    view.toolCallCount = 0;
    view.activeRequests = 0;
    view.allowedAppToolNames = undefined;
    mocks.getMcpAppViewLease.mockReset().mockReturnValue(view);
    mocks.completeDeferredSessionMcpRuntimeRetirement.mockReset().mockResolvedValue(false);
    mocks.peekSessionMcpRuntime.mockReset().mockReturnValue(runtime());
  });

  it("returns the ephemeral view payload only for the bound session", async () => {
    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sandboxUrl: "mcp-app-sandbox",
        sandboxPort: 18790,
        sandboxOrigin: "https://apps.example.com",
        html: "<html>demo</html>",
        toolInput: { city: "Paris" },
      }),
    );
    expect(mocks.getMcpAppViewLease).toHaveBeenCalledWith("cv_app", expect.any(Object));
    const activeRuntime = mocks.peekSessionMcpRuntime.mock.results[0]?.value;
    expect(activeRuntime.acquireLease).toHaveBeenCalledOnce();
    expect(activeRuntime.acquireLease.mock.results[0]?.value).toHaveBeenCalledOnce();
    expect(mocks.completeDeferredSessionMcpRuntimeRetirement).toHaveBeenCalledWith(activeRuntime);
  });

  it("does not replace a completed bridge response with a cleanup error", async () => {
    mocks.completeDeferredSessionMcpRuntimeRetirement.mockRejectedValueOnce(
      new Error("dispose failed"),
    );
    const respond = await invoke("mcp.app.callTool", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
      toolName: "shared",
    });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      content: [{ type: "text", text: "shared" }],
    });
  });

  it("filters model-only tools from app discovery and execution", async () => {
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };
    const listed = await invoke("mcp.app.listTools", params);
    expect(listed.mock.calls[0]?.[1].tools.map((tool: { name: string }) => tool.name)).toEqual([
      "shared",
      "app-only",
    ]);

    const denied = await invoke("mcp.app.callTool", { ...params, toolName: "model-only" });
    expect(denied.mock.calls[0]?.[0]).toBe(false);
  });

  it("keeps the originating run allowlist authoritative for App calls", async () => {
    view.allowedAppToolNames = new Set(["shared"]);
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };

    const listed = await invoke("mcp.app.listTools", params);
    expect(listed.mock.calls[0]?.[1].tools.map((tool: { name: string }) => tool.name)).toEqual([
      "shared",
    ]);

    const denied = await invoke("mcp.app.callTool", { ...params, toolName: "app-only" });
    expect(denied.mock.calls[0]?.[0]).toBe(false);
  });

  it("never creates a runtime for an expired view", async () => {
    mocks.getMcpAppViewLease.mockReturnValue(undefined);
    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "expired",
    });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
  });
});
