import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  buildMcpAppContentSecurityPolicy,
  buildMcpAppSandboxPath,
  buildMcpAppSandboxProxyHtml,
  decodeMcpAppSandboxCsp,
  resolveMcpAppSandboxPort,
} from "./mcp-app-sandbox.js";
import {
  testing as mcpUiResourceTesting,
  acquireMcpAppViewRequest,
  fetchMcpAppView,
  getMcpAppViewLease,
  MCP_APP_RESOURCE_MAX_BYTES,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "./mcp-ui-resource.js";

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
    const result = await fetchMcpAppView({
      runtime: sessionRuntime,
      serverName: "demo",
      toolName: "show",
      uiResourceUri: "ui://demo/app",
      toolInput: { city: "Paris" },
      toolResult: { content: [{ type: "text", text: "ok" }] },
    });

    expect(result?.viewId).toMatch(/^mcp-app-/u);
    expect(getMcpAppViewLease(result?.viewId ?? "", sessionRuntime)).toMatchObject({
      html: "<html>demo</html>",
      toolInput: { city: "Paris" },
      permissions: { geolocation: {} },
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

  it("injects a restrictive CSP and drops invalid metadata origins", async () => {
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
    const policy = buildMcpAppContentSecurityPolicy(view?.csp);

    expect(policy).toContain("connect-src https://api.example.com");
    expect(policy).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com");
    expect(policy).toContain("font-src 'self' https://cdn.example.com");
    expect(policy).not.toContain("worker-src");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline' blob:");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).not.toContain("javascript:alert");
    expect(view?.html.startsWith("<!doctype html>")).toBe(true);
    expect(policy).toContain("frame-ancestors http: https:");
    const sandboxPath = buildMcpAppSandboxPath(view?.csp);
    const encodedCsp = new URL(sandboxPath, "https://gateway.example").searchParams.get("csp");
    expect(decodeMcpAppSandboxCsp(encodedCsp)).toStrictEqual(view?.csp);
    const proxyHtml = buildMcpAppSandboxProxyHtml();
    expect(proxyHtml.startsWith('<!doctype html>\n<meta charset="utf-8"')).toBe(true);
    expect(proxyHtml).toContain('inner.setAttribute("sandbox", "allow-scripts allow-forms")');
    expect(proxyHtml).toContain("inner.srcdoc = params.html");
    expect(proxyHtml).not.toContain("doc.write");
    expect(proxyHtml).not.toContain("params.sandbox");
    expect(proxyHtml).not.toContain("params.permissions");
    expect(proxyHtml).toContain("document.referrer");
    expect(proxyHtml).not.toContain("hostOrigin === null");
    expect(proxyHtml).toContain('startsWith("ui/notifications/sandbox-")');
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
    expect(getMcpAppViewLease(result?.viewId ?? "", sessionRuntime)).toBeDefined();

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(getMcpAppViewLease(result?.viewId ?? "", sessionRuntime)).toBeUndefined();
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
    expect(decodeMcpAppSandboxCsp(encoded)?.connectDomains).toStrictEqual(shortDomains);

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

  it("uses the stable restrictive CSP when metadata is omitted", () => {
    const policy = buildMcpAppContentSecurityPolicy();
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).toContain("media-src 'self' data:");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).not.toMatch(/\b(?:blob|font|worker)-src\b/u);
    expect(policy).not.toContain("blob:");
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
