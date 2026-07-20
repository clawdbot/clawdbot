import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { updateMcpAppModelContext } from "./mcp-app-model-context.js";
import { buildMcpAppSandboxPath, resolveMcpAppSandboxPort } from "./mcp-app-sandbox.js";
import {
  acquireMcpAppViewRequest,
  fetchMcpAppView,
  getMcpAppViewLease,
} from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";

const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const MCP_APP_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;

function runtime(readResource: SessionMcpRuntime["readResource"]): SessionMcpRuntime {
  return {
    sessionId: "session-1",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    mcpAppsEnabled: true,
    activeLeases: 0,
    acquireLease: vi.fn(() => vi.fn()),
    markUsed: () => {},
    getCatalog: async () => ({ version: 1, generatedAt: 0, servers: {}, tools: [] }),
    peekCatalog: () => null,
    callTool: vi.fn(),
    readResource,
    dispose: async () => {},
  };
}

describe("MCP App UI resources", () => {
  beforeEach(() => {
    mcpUiResourceTesting.clearViewStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leases HTML and tool data only in memory", async () => {
    const sessionRuntime = runtime(async () => ({
      contents: [
        {
          uri: "ui://demo/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>demo</html>",
          _meta: {
            ui: {
              csp: { connectDomains: ["https://api.example.com"] },
              permissions: { geolocation: {} },
            },
          },
        },
      ],
    }));
    const authorizeAppInteraction = vi.fn(async () => true);
    const result = await fetchMcpAppView({
      runtime: sessionRuntime,
      serverName: "demo",
      toolName: "show",
      uiResourceUri: "ui://demo/app",
      toolInput: { city: "Paris" },
      toolResult: { content: [{ type: "text", text: "ok" }] },
      authorizeAppInteraction,
    });

    expect(result?.viewId).toMatch(/^mcp-app-/u);
    expect(getMcpAppViewLease(result?.viewId ?? "", sessionRuntime)).toMatchObject({
      html: "<html>demo</html>",
      toolInput: { city: "Paris" },
      permissions: { geolocation: {} },
      authorizeAppInteraction,
    });
    expect(
      getMcpAppViewLease(
        result?.viewId ?? "",
        runtime(async () => ({ contents: [] })),
      ),
    ).toBeUndefined();
  });

  it("keeps valid Apps when optional listing metadata fails", async () => {
    const readResource = vi.fn(async () => ({
      contents: [
        {
          uri: "ui://demo/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>demo</html>",
        },
      ],
    }));
    const sessionRuntime = runtime(readResource);
    sessionRuntime.listResources = vi.fn(async () => {
      throw new Error("resources/list unavailable");
    });

    const result = await fetchMcpAppView({
      runtime: sessionRuntime,
      serverName: "demo",
      toolName: "show",
      uiResourceUri: "ui://demo/app",
      toolInput: {},
      toolResult: { content: [] },
    });

    expect(result?.viewId).toMatch(/^mcp-app-/u);
    expect(readResource).toHaveBeenCalledWith("demo", "ui://demo/app", {
      failureBackoff: "ignore",
    });
    expect(sessionRuntime.listResources).toHaveBeenCalledWith("demo", {
      failureBackoff: "ignore",
    });
  });

  it("rejects oversized and incorrectly typed resources", async () => {
    for (const content of [
      {
        uri: "ui://demo/app",
        mimeType: "text/html",
        text: "<html></html>",
      },
      {
        uri: "ui://demo/app",
        mimeType: MCP_APP_RESOURCE_MIME_TYPE,
        text: "x".repeat(MCP_APP_RESOURCE_MAX_BYTES + 1),
      },
    ]) {
      const result = await fetchMcpAppView({
        runtime: runtime(async () => ({ contents: [content] })),
        serverName: "demo",
        toolName: "show",
        uiResourceUri: "ui://demo/app",
        toolInput: {},
        toolResult: { content: [] },
      });
      expect(result).toBeUndefined();
    }
  });

  it("bounds concurrent app bridge requests", () => {
    const view = {
      requestWindowStartedAtMs: 0,
      requestCount: 0,
      toolCallCount: 0,
      activeRequests: 0,
    } as Parameters<typeof acquireMcpAppViewRequest>[0];
    const releases = Array.from({ length: 4 }, () => acquireMcpAppViewRequest(view, "read", 1));
    expect(() => acquireMcpAppViewRequest(view, "read", 1)).toThrow("concurrency limit");
    releases[0]?.();
    const release = acquireMcpAppViewRequest(view, "read", 1);
    release();
    releases.slice(1).forEach((entry) => entry());
  });

  it("normalizes CSP metadata before retaining the view", async () => {
    const sessionRuntime = runtime(async () => ({
      contents: [
        {
          uri: "ui://demo/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<!doctype html><script>globalThis.ready = true</script>",
          _meta: {
            ui: {
              csp: {
                connectDomains: ["https://api.example.com", "javascript:alert(1)"],
                resourceDomains: ["https://cdn.example.com"],
              },
            },
          },
        },
      ],
    }));
    const result = await fetchMcpAppView({
      runtime: sessionRuntime,
      serverName: "demo",
      toolName: "show",
      uiResourceUri: "ui://demo/app",
      toolInput: {},
      toolResult: { content: [] },
    });
    const view = getMcpAppViewLease(result?.viewId ?? "", sessionRuntime);
    expect(view?.csp).toEqual({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
    });
    expect(view?.html.startsWith("<!doctype html>")).toBe(true);
    expect(buildMcpAppSandboxPath(view?.csp)).toContain("?csp=");
  });

  it("deletes sensitive view data when the lease expires without later activity", async () => {
    vi.useFakeTimers();
    const sessionRuntime = runtime(async () => ({
      contents: [
        {
          uri: "ui://demo/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>secret</html>",
        },
      ],
    }));
    const result = await fetchMcpAppView({
      runtime: sessionRuntime,
      serverName: "demo",
      toolName: "show",
      uiResourceUri: "ui://demo/app",
      toolInput: { token: "secret" },
      toolResult: { content: [] },
    });
    const view = getMcpAppViewLease(result?.viewId ?? "", sessionRuntime);
    expect(view).toBeDefined();
    updateMcpAppModelContext(sessionRuntime, view!, {
      content: [{ type: "text", text: "ephemeral context" }],
    });
    expect(sessionRuntime.pendingMcpAppModelContext).toBeDefined();

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(getMcpAppViewLease(result?.viewId ?? "", sessionRuntime)).toBeUndefined();
    expect(sessionRuntime.pendingMcpAppModelContext).toBeUndefined();
    expect(sessionRuntime.acquireLease).toHaveBeenCalledOnce();
    const release = vi.mocked(sessionRuntime.acquireLease!).mock.results[0]?.value;
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects CSP metadata that cannot fit safe HTTP request and response limits", () => {
    const shortDomains = Array.from(
      { length: 65 },
      (_, index) => `https://cdn-${index}.example.com`,
    );
    const path = buildMcpAppSandboxPath({ connectDomains: shortDomains });
    const encoded = new URL(path, "https://gateway.example").searchParams.get("csp");
    expect(encoded).toBeTruthy();

    const domains = Array.from(
      { length: 64 },
      (_, index) => `https://${"a".repeat(120)}-${index}.example.com`,
    );
    expect(() =>
      buildMcpAppSandboxPath({
        connectDomains: domains,
        resourceDomains: domains,
        frameDomains: domains,
        baseUriDomains: domains,
      }),
    ).toThrow("MCP App CSP metadata exceeds safe HTTP limits");
  });

  it("derives a distinct listener port without wrapping", () => {
    expect(resolveMcpAppSandboxPort(18789)).toBe(18790);
    expect(resolveMcpAppSandboxPort(18789, 29000)).toBe(29000);
    expect(() => resolveMcpAppSandboxPort(65535)).toThrow(
      "MCP Apps require distinct valid Gateway and sandbox ports",
    );
    expect(() => resolveMcpAppSandboxPort(18789, 18789)).toThrow(
      "MCP Apps require distinct valid Gateway and sandbox ports",
    );
  });

  it("keeps all 32 valid leases during lookup-only pruning", async () => {
    const sessionRuntime = runtime(async () => ({
      contents: [
        {
          uri: "ui://demo/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>demo</html>",
        },
      ],
    }));
    const viewIds: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      const result = await fetchMcpAppView({
        runtime: sessionRuntime,
        serverName: "demo",
        toolName: "show",
        uiResourceUri: "ui://demo/app",
        toolInput: { index },
        toolResult: { content: [] },
      });
      if (result) {
        viewIds.push(result.viewId);
      }
    }

    expect(getMcpAppViewLease(viewIds[0] ?? "", sessionRuntime)).toBeDefined();
    expect(getMcpAppViewLease(viewIds[31] ?? "", sessionRuntime)).toBeDefined();
  });

  it("replaces a reconstructed view id without leaking the previous runtime lease", async () => {
    const releases = [vi.fn(), vi.fn()];
    const sessionRuntime = runtime(async () => ({
      contents: [
        {
          uri: "ui://demo/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>demo</html>",
        },
      ],
    }));
    sessionRuntime.acquireLease = vi
      .fn()
      .mockReturnValueOnce(releases[0])
      .mockReturnValueOnce(releases[1]);

    for (const version of [1, 2]) {
      await fetchMcpAppView({
        runtime: sessionRuntime,
        serverName: "demo",
        toolName: "show",
        uiResourceUri: "ui://demo/app",
        viewId: "mcp-app-restored",
        toolInput: { version },
        toolResult: { content: [] },
      });
    }

    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).not.toHaveBeenCalled();
    expect(getMcpAppViewLease("mcp-app-restored", sessionRuntime)?.toolInput).toEqual({
      version: 2,
    });
  });
});
