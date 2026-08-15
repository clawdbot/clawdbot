// Browser bridge tests cover browser control bridge requests and local server behavior.
import type { Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadActivatedBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync,
}));

describe("browser bridge facade", () => {
  beforeEach(() => {
    vi.resetModules();
    loadActivatedBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("stays cold until a bridge function is called", async () => {
    await import("./browser-bridge.js");

    expect(loadActivatedBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("delegates bridge lifecycle calls through the activated runtime facade", async () => {
    const bridge = {
      server: {} as Server,
      port: 19001,
      baseUrl: "http://127.0.0.1:19001",
      state: {
        resolved: {
          enabled: true,
        },
      },
    };
    const startBrowserBridgeServer = vi.fn(async () => bridge);
    const stopBrowserBridgeServer = vi.fn(async () => undefined);
    loadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      startBrowserBridgeServer,
      stopBrowserBridgeServer,
    });

    const facade = await import("./browser-bridge.js");

    await expect(
      facade.startBrowserBridgeServer({
        resolved: bridge.state.resolved as never,
        authToken: "token",
      }),
    ).resolves.toEqual(bridge);
    await expect(facade.stopBrowserBridgeServer(bridge.server)).resolves.toBeUndefined();
    expect(loadActivatedBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "runtime-api.js",
    });
    expect(startBrowserBridgeServer).toHaveBeenCalledWith({
      resolved: bridge.state.resolved,
      authToken: "token",
    });
    expect(stopBrowserBridgeServer).toHaveBeenCalledWith(bridge.server);
  });
});
