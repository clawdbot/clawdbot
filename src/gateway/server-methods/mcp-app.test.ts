import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeDeferredSessionMcpRuntimeRetirement: vi.fn(),
  getMcpAppViewLease: vi.fn(),
  peekSessionMcpRuntime: vi.fn(),
  restoreMcpAppView: vi.fn(),
  createMcpAppStandaloneTicket: vi.fn(),
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
vi.mock("../mcp-app-reconstruction.js", () => ({
  restoreMcpAppView: mocks.restoreMcpAppView,
}));
vi.mock("../mcp-app-standalone.js", () => ({
  createMcpAppStandaloneTicket: mocks.createMcpAppStandaloneTicket,
}));

import { mcpAppHandlers } from "./mcp-app.js";

const view = {
  viewId: "cv_app",
  sessionId: "session-1",
  serverName: "demo",
  toolName: "show",
  uiResourceUri: "ui://demo/app",
  html: "<html>demo</html>",
  allowedAppToolNames: new Set(["shared", "app-only"]) as ReadonlySet<string> | undefined,
  readOnly: undefined as boolean | undefined,
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

async function invoke(
  method: keyof typeof mcpAppHandlers,
  params: Record<string, unknown>,
  mcpAppsEnabled = true,
) {
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
        mcp: { apps: { enabled: mcpAppsEnabled, sandboxOrigin: "https://apps.example.com" } },
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
    view.allowedAppToolNames = new Set(["shared", "app-only"]);
    view.readOnly = undefined;
    mocks.getMcpAppViewLease.mockReset().mockReturnValue(view);
    mocks.completeDeferredSessionMcpRuntimeRetirement.mockReset().mockResolvedValue(false);
    mocks.peekSessionMcpRuntime.mockReset().mockReturnValue(runtime());
    mocks.restoreMcpAppView.mockReset().mockResolvedValue(undefined);
    mocks.createMcpAppStandaloneTicket.mockReset().mockReturnValue({
      ticket: "ticket",
      url: "/__openclaw__/mcp-app#ticket",
      expiresAtMs: 1_800_000_120_000,
    });
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
        standaloneUrl: "/__openclaw__/mcp-app#ticket",
        standaloneExpiresAtMs: 1_800_000_120_000,
        messageSupported: true,
        updateModelContextSupported: true,
      }),
    );
    expect(mocks.getMcpAppViewLease).toHaveBeenCalledWith("cv_app", expect.any(Object));
    expect(mocks.createMcpAppStandaloneTicket).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      view,
    });
    const activeRuntime = mocks.peekSessionMcpRuntime.mock.results[0]?.value;
    expect(activeRuntime.acquireLease).toHaveBeenCalledOnce();
    expect(activeRuntime.acquireLease.mock.results[0]?.value).toHaveBeenCalledOnce();
    expect(mocks.completeDeferredSessionMcpRuntimeRetirement).toHaveBeenCalledWith(activeRuntime);
  });

  it("preserves the existing view payload when standalone ticket issuance is unavailable", async () => {
    mocks.createMcpAppStandaloneTicket.mockImplementation(() => {
      throw new Error("ticket unavailable");
    });
    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
    });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ html: "<html>demo</html>" });
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("standaloneUrl");
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

  it("keeps message support disabled without fresh run authority", async () => {
    view.allowedAppToolNames = undefined;
    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
    });

    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      messageSupported: false,
      updateModelContextSupported: false,
    });
  });

  it("supports messages for a fresh view with no app-callable tools", async () => {
    view.allowedAppToolNames = new Set();
    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
    });

    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      messageSupported: true,
      updateModelContextSupported: true,
    });
  });

  it("stores only the latest bounded text update and clears it with an empty update", async () => {
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };
    const first = await invoke("mcp.app.updateModelContext", {
      ...params,
      content: [{ type: "text", text: "first" }],
    });
    const activeRuntime = mocks.peekSessionMcpRuntime.mock.results[0]?.value;
    expect(first.mock.calls[0]?.[0]).toBe(true);
    expect(activeRuntime.pendingMcpAppModelContext).toMatchObject({ text: "first", owner: view });

    const second = await invoke("mcp.app.updateModelContext", {
      ...params,
      content: [{ type: "text", text: "second" }],
    });
    expect(second.mock.calls[0]?.[0]).toBe(true);
    expect(activeRuntime.pendingMcpAppModelContext).toMatchObject({ text: "second", owner: view });

    const cleared = await invoke("mcp.app.updateModelContext", params);
    expect(cleared.mock.calls[0]?.[0]).toBe(true);
    expect(activeRuntime.pendingMcpAppModelContext).toBeUndefined();
  });

  it("rejects unsupported context shapes, oversized UTF-8 text, and read-only views", async () => {
    const params = { sessionKey: "agent:main:main", viewId: "cv_app" };
    for (const update of [
      { structuredContent: { secret: true } },
      {
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
      { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
      { content: [{ type: "text", text: "é".repeat(8 * 1024 + 1) }] },
    ]) {
      const respond = await invoke("mcp.app.updateModelContext", { ...params, ...update });
      expect(respond.mock.calls[0]?.[0]).toBe(false);
    }

    view.readOnly = true;
    const readOnly = await invoke("mcp.app.updateModelContext", {
      ...params,
      content: [{ type: "text", text: "blocked" }],
    });
    expect(readOnly.mock.calls[0]?.[0]).toBe(false);
  });

  it("does not reconstruct expired views for context writes", async () => {
    mocks.getMcpAppViewLease.mockReturnValue(undefined);
    const respond = await invoke("mcp.app.updateModelContext", {
      sessionKey: "agent:main:main",
      viewId: "expired",
      content: [{ type: "text", text: "blocked" }],
    });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(mocks.restoreMcpAppView).not.toHaveBeenCalled();
  });

  it("rejects context writes without fresh run authority", async () => {
    view.allowedAppToolNames = undefined;
    const respond = await invoke("mcp.app.updateModelContext", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
      content: [{ type: "text", text: "blocked" }],
    });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    const activeRuntime = mocks.peekSessionMcpRuntime.mock.results[0]?.value;
    expect(activeRuntime.pendingMcpAppModelContext).toBeUndefined();
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

  it("rejects views that are not backed by the transcript", async () => {
    mocks.getMcpAppViewLease.mockReturnValue(undefined);
    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "expired",
    });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(mocks.restoreMcpAppView).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        viewId: "expired",
      }),
    );
  });

  it("rejects disabled Apps before attempting transcript reconstruction", async () => {
    mocks.peekSessionMcpRuntime.mockReturnValue(undefined);

    const respond = await invoke(
      "mcp.app.view",
      { sessionKey: "agent:main:main", viewId: "cv_app" },
      false,
    );

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(mocks.restoreMcpAppView).not.toHaveBeenCalled();
  });

  it("restores a transcript-backed view after a Gateway restart", async () => {
    const restoredRuntime = runtime();
    const restoredView = {
      ...view,
      runtime: restoredRuntime,
      allowedAppToolNames: new Set(),
      readOnly: true,
    };
    mocks.peekSessionMcpRuntime.mockReturnValue(undefined);
    mocks.restoreMcpAppView.mockResolvedValue({
      runtime: restoredRuntime,
      view: restoredView,
    });

    const respond = await invoke("mcp.app.view", {
      sessionKey: "agent:main:main",
      viewId: "cv_app",
    });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      html: "<html>demo</html>",
      messageSupported: false,
      updateModelContextSupported: false,
    });
  });
});
