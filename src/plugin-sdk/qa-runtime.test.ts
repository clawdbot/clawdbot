import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-runtime.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

describe("plugin-sdk qa-runtime", () => {
  beforeEach(() => {
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("stays cold until the runtime seam is used", async () => {
    const module = await import("./qa-runtime.js");

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(typeof module.loadQaRuntimeModule).toBe("function");
    expect(typeof module.isQaRuntimeAvailable).toBe("function");
  });

  it("loads the qa-lab runtime public surface through the generic seam", async () => {
    const runtimeSurface = {
      defaultQaRuntimeModelForMode: vi.fn(),
      startQaLiveLaneGateway: vi.fn(),
    };
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue(runtimeSurface);

    const module = await import("./qa-runtime.js");

    expect(module.loadQaRuntimeModule()).toBe(runtimeSurface);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "qa-lab",
      artifactBasename: "runtime-api.js",
    });
  });

  it("reports the runtime as unavailable when the qa-lab surface is missing", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("Unable to resolve bundled plugin public surface qa-lab/runtime-api.js");
    });

    const module = await import("./qa-runtime.js");

    expect(module.isQaRuntimeAvailable()).toBe(false);
  });
});
