import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const registerQaLabCliImpl = vi.hoisted(() => vi.fn());

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
    loadBundledPluginPublicSurfaceModuleSync.mockReset().mockReturnValue({
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
});
