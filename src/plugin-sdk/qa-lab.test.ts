import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const registerQaLabCliImpl = vi.hoisted(() => vi.fn());
const isQaLabCliAvailableImpl = vi.hoisted(() => vi.fn());

vi.mock("./facade-loader.js", async () => {
  const actual = await vi.importActual<typeof import("./facade-loader.js")>("./facade-loader.js");
  return {
    ...actual,
    loadBundledPluginPublicSurfaceModuleSync,
  };
});

describe("plugin-sdk qa-lab", () => {
  beforeEach(() => {
    registerQaLabCliImpl.mockReset();
    isQaLabCliAvailableImpl.mockReset().mockReturnValue(true);
    loadBundledPluginPublicSurfaceModuleSync.mockReset().mockReturnValue({
      isQaLabCliAvailable: isQaLabCliAvailableImpl,
      registerQaLabCli: registerQaLabCliImpl,
    });
  });

  it("keeps the qa-lab facade cold until used", async () => {
    const module = await import("./qa-lab.js");

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    module.registerQaLabCli({} as never);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "qa-lab",
      artifactBasename: "cli.js",
    });
  });

  it("delegates qa cli registration through the bundled public surface", async () => {
    const module = await import("./qa-lab.js");

    module.registerQaLabCli({} as never);
    expect(registerQaLabCliImpl).toHaveBeenCalledWith({} as never);
  });

  it("delegates qa cli availability through the bundled public surface", async () => {
    const module = await import("./qa-lab.js");

    expect(module.isQaLabCliAvailable()).toBe(true);
    expect(isQaLabCliAvailableImpl).toHaveBeenCalled();
  });

  it("reports qa-lab unavailable when private facade artifacts are not packed", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("Unable to resolve bundled plugin public surface qa-lab/cli.js");
    });
    const module = await import("./qa-lab.js");

    expect(module.isQaLabCliAvailable()).toBe(false);
  });
});
