// Browser bridge tests protect narrow loading, async activation, and lifecycle delegation.
import { createServer, type Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserBridge, startBrowserBridgeServer } from "./browser-bridge.js";

const loaders = vi.hoisted(() => ({ async: vi.fn(), sync: vi.fn() }));
vi.mock("./facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModule: loaders.async,
  loadActivatedBundledPluginPublicSurfaceModuleSync: loaders.sync,
}));

const params: Parameters<typeof startBrowserBridgeServer>[0] = {
  resolved: {
    enabled: true,
    evaluateEnabled: false,
    controlPort: 0,
    cdpPortRangeStart: 18800,
    cdpPortRangeEnd: 18899,
    cdpProtocol: "http",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    localLaunchTimeoutMs: 15000,
    localCdpReadyTimeoutMs: 8000,
    actionTimeoutMs: 10000,
    color: "#123456",
    headless: true,
    noSandbox: false,
    attachOnly: true,
    defaultProfile: "fixture",
    profiles: {},
    extraArgs: [],
    tabCleanup: { enabled: false, idleMinutes: 120, maxTabsPerSession: 8, sweepMinutes: 5 },
  },
  host: "127.0.0.1",
  port: 0,
  authToken: "fixture-token",
  authPassword: "fixture-password",
  onEnsureAttachTarget: async () => {},
  resolveSandboxNoVncToken: () => ({ noVncPort: 45678 }),
};

function createSurface() {
  const bridge: BrowserBridge = {
    server: createServer(),
    port: 19001,
    baseUrl: "http://127.0.0.1:19001",
    state: { resolved: params.resolved },
  };
  return {
    bridge,
    startBrowserBridgeServer: vi.fn<typeof startBrowserBridgeServer>(async () => bridge),
    stopBrowserBridgeServer: vi.fn<(server: Server) => Promise<void>>(async () => {}),
  };
}

describe("browser bridge facade", () => {
  beforeEach(() => {
    vi.resetModules();
    loaders.async.mockReset();
    loaders.sync.mockReset();
  });

  it("stays cold until a bridge function is called", async () => {
    await import("./browser-bridge.js");
    expect(loaders.async).not.toHaveBeenCalled();
    expect(loaders.sync).not.toHaveBeenCalled();
  });

  for (const operation of ["startBrowserBridgeServer", "stopBrowserBridgeServer"] as const) {
    it(`awaits activation of the bridge-only artifact before ${operation} and preserves identity`, async () => {
      const surface = createSurface();
      let resolveActivation!: (value: typeof surface) => void;
      const activation = new Promise<typeof surface>((resolve) => {
        resolveActivation = resolve;
      });
      loaders.async.mockReturnValue(activation);
      loaders.sync.mockReturnValue(surface);
      const facade = await import("./browser-bridge.js");
      const pending =
        operation === "startBrowserBridgeServer"
          ? facade.startBrowserBridgeServer(params)
          : facade.stopBrowserBridgeServer(surface.bridge.server);
      try {
        expect(surface[operation]).not.toHaveBeenCalled();
      } finally {
        resolveActivation(surface);
        await pending;
      }
      expect(await pending).toBe(
        operation === "startBrowserBridgeServer" ? surface.bridge : undefined,
      );
      expect(surface[operation].mock.calls[0]?.[0]).toBe(
        operation === "startBrowserBridgeServer" ? params : surface.bridge.server,
      );
      expect(loaders.async).toHaveBeenCalledWith({
        dirName: "browser",
        artifactBasename: "bridge-api.js",
      });
    });

    it(`rechecks activation before every ${operation}, including after a successful load`, async () => {
      const surface = createSurface();
      const blocked = new Error("activation blocked");
      loaders.async.mockResolvedValueOnce(surface).mockRejectedValueOnce(blocked);
      loaders.sync.mockReturnValueOnce(surface).mockImplementationOnce(() => {
        throw blocked;
      });
      const facade = await import("./browser-bridge.js");
      const invoke = () =>
        operation === "startBrowserBridgeServer"
          ? facade.startBrowserBridgeServer(params)
          : facade.stopBrowserBridgeServer(surface.bridge.server);
      await invoke();
      await expect(invoke()).rejects.toBe(blocked);
      expect(surface[operation]).toHaveBeenCalledOnce();
    });

    it(`propagates the original delegated ${operation} error`, async () => {
      const surface = createSurface();
      const failure = new Error("bridge lifecycle failed");
      surface[operation].mockRejectedValue(failure);
      loaders.async.mockResolvedValue(surface);
      loaders.sync.mockReturnValue(surface);
      const facade = await import("./browser-bridge.js");
      const pending =
        operation === "startBrowserBridgeServer"
          ? facade.startBrowserBridgeServer(params)
          : facade.stopBrowserBridgeServer(surface.bridge.server);
      await expect(pending).rejects.toBe(failure);
    });
  }
});
