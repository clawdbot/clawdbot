/**
 * Tests browser node-host facade delegation and unavailable facade behavior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadActivatedBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync,
}));

describe("browser node-host facade", () => {
  beforeEach(() => {
    loadActivatedBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("stays cold until the proxy command is called", async () => {
    await import("./browser-node-host.js");

    expect(loadActivatedBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("delegates the proxy command through the activated runtime facade", async () => {
    const runBrowserProxyCommand = vi.fn(async () => '{"ok":true}');
    loadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      runBrowserProxyCommand,
    });

    const facade = await import("./browser-node-host.js");

    await expect(facade.runBrowserProxyCommand('{"path":"/"}')).resolves.toBe('{"ok":true}');
    expect(loadActivatedBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "runtime-api.js",
    });
    expect(runBrowserProxyCommand).toHaveBeenCalledWith('{"path":"/"}');
  });
});
