import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./facade-runtime.js")>("./facade-runtime.js");
  return {
    ...actual,
    loadBundledPluginPublicSurfaceModuleSync,
  };
});

describe("plugin-sdk lmstudio-runtime", () => {
  beforeEach(() => {
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("keeps the lmstudio runtime facade cold until a helper is used", async () => {
    const module = await import("./lmstudio-runtime.js");

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(module.LMSTUDIO_PROVIDER_ID).toBe("lmstudio");
    expect(module.LMSTUDIO_DEFAULT_EMBEDDING_MODEL).toBe("text-embedding-nomic-embed-text-v1.5");
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("delegates lmstudio helpers through the bundled runtime facade", async () => {
    const resolveLmstudioInferenceBase = vi.fn().mockReturnValue("http://localhost:1234/v1");
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      resolveLmstudioInferenceBase,
    });

    const module = await import("./lmstudio-runtime.js");

    expect(module.resolveLmstudioInferenceBase("http://localhost:1234/api/v1/")).toBe(
      "http://localhost:1234/v1",
    );
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "lmstudio",
      artifactBasename: "runtime-api.js",
    });
    expect(resolveLmstudioInferenceBase).toHaveBeenCalledWith("http://localhost:1234/api/v1/");
  });
});
