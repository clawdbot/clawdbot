import { beforeEach, describe, expect, it, vi } from "vitest";

const controlServiceMocks = vi.hoisted(() => ({
  createBrowserControlContext: vi.fn(() => ({ control: true })),
  startBrowserControlServiceFromConfig: vi.fn(async () => true),
}));

const dispatcherMocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: dispatcherMocks.dispatch,
  })),
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    browser: {},
    nodeHost: { browserProxy: { enabled: true } },
  })),
}));

const browserClusterMocks = vi.hoisted(() => ({
  browserClusterHealth: vi.fn(async () => ({ ok: true })),
  canProxyBrowserClusterPath: vi.fn(() => false),
  proxyBrowserCluster: vi.fn(),
  shouldUseBrowserCluster: vi.fn(() => false),
}));

const browserConfigMocks = vi.hoisted(() => ({
  resolveBrowserConfig: vi.fn(() => ({
    enabled: true,
    defaultProfile: "openclaw",
  })),
}));

vi.mock("../browser/control-service.js", () => controlServiceMocks);
vi.mock("../browser/routes/dispatcher.js", () => dispatcherMocks);
vi.mock("../config/config.js", () => configMocks);
vi.mock("../browser/config.js", () => browserConfigMocks);
vi.mock("../integrations/browser-cluster-client.js", () => browserClusterMocks);
vi.mock("../media/mime.js", () => ({
  detectMime: vi.fn(async () => "image/png"),
}));

import { runBrowserProxyCommand } from "./invoke-browser.js";

describe("runBrowserProxyCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { enabled: true } },
    });
    browserConfigMocks.resolveBrowserConfig.mockReturnValue({
      enabled: true,
      defaultProfile: "openclaw",
    });
    controlServiceMocks.startBrowserControlServiceFromConfig.mockResolvedValue(true);
    browserClusterMocks.browserClusterHealth.mockResolvedValue({ ok: true });
    browserClusterMocks.shouldUseBrowserCluster.mockReturnValue(false);
    browserClusterMocks.canProxyBrowserClusterPath.mockReturnValue(false);
    browserClusterMocks.proxyBrowserCluster.mockReset();
  });

  it("adds profile and browser status details on ws-backed timeouts", async () => {
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          running: true,
          cdpHttp: true,
          cdpReady: false,
          cdpUrl: "http://127.0.0.1:18792",
        },
      });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "openclaw",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /browser proxy timed out for GET \/snapshot after 5ms; ws-backed browser action; profile=openclaw; status\(running=true, cdpHttp=true, cdpReady=false, cdpUrl=http:\/\/127\.0\.0\.1:18792\)/,
    );
  });

  it("includes chrome-mcp transport in timeout diagnostics when no CDP URL exists", async () => {
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          running: true,
          transport: "chrome-mcp",
          cdpHttp: true,
          cdpReady: false,
          cdpUrl: null,
        },
      });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "user",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /browser proxy timed out for GET \/snapshot after 5ms; ws-backed browser action; profile=user; status\(running=true, cdpHttp=true, cdpReady=false, transport=chrome-mcp\)/,
    );
  });

  it("redacts sensitive cdpUrl details in timeout diagnostics", async () => {
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          running: true,
          cdpHttp: true,
          cdpReady: false,
          cdpUrl:
            "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
        },
      });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "remote",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /status\(running=true, cdpHttp=true, cdpReady=false, cdpUrl=https:\/\/example\.com\/chrome\?token=supers…7890\)/,
    );
  });

  it("delegates supported requests to browser-cluster when enabled", async () => {
    browserClusterMocks.shouldUseBrowserCluster.mockReturnValue(true);
    browserClusterMocks.canProxyBrowserClusterPath.mockReturnValue(true);
    browserClusterMocks.browserClusterHealth.mockResolvedValue({ ok: true });
    browserClusterMocks.proxyBrowserCluster.mockResolvedValue({ ok: true, targetId: "profile:openclaw" });

    const raw = await runBrowserProxyCommand(
      JSON.stringify({
        method: "POST",
        path: "/act",
        profile: "openclaw",
        body: { request: { kind: "click", selector: "button.save" } },
      }),
    );

    expect(JSON.parse(raw)).toEqual({ result: { ok: true, targetId: "profile:openclaw" } });
    expect(browserClusterMocks.proxyBrowserCluster).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/act",
        profile: "openclaw",
      }),
    );
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("falls back to internal dispatcher when browser-cluster proxy errors", async () => {
    browserClusterMocks.shouldUseBrowserCluster.mockReturnValue(true);
    browserClusterMocks.canProxyBrowserClusterPath.mockReturnValue(true);
    browserClusterMocks.browserClusterHealth.mockResolvedValue({ ok: true });
    browserClusterMocks.proxyBrowserCluster.mockRejectedValue(new Error("cluster offline"));
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 200,
      body: { ok: true, source: "internal" },
    });

    const raw = await runBrowserProxyCommand(
      JSON.stringify({
        method: "POST",
        path: "/act",
        profile: "openclaw",
        body: { request: { kind: "click", selector: "button.save" } },
      }),
    );

    expect(JSON.parse(raw)).toEqual({ result: { ok: true, source: "internal" } });
    expect(browserClusterMocks.proxyBrowserCluster).toHaveBeenCalledTimes(1);
    expect(dispatcherMocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps non-timeout browser errors intact", async () => {
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 500,
      body: { error: "tab not found" },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/act",
          profile: "openclaw",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("tab not found");
  });
});
