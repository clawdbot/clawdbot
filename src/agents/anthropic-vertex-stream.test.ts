import { beforeEach, describe, expect, it, vi } from "vitest";

const facadeRuntimeMocks = vi.hoisted(() => ({
  loadBundledPluginPublicSurfaceModuleSync: vi.fn(),
}));

vi.mock("../plugin-sdk/facade-runtime.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync:
    facadeRuntimeMocks.loadBundledPluginPublicSurfaceModuleSync,
}));

describe("anthropic-vertex stream facade", () => {
  beforeEach(() => {
    vi.resetModules();
    facadeRuntimeMocks.loadBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("loads the stream facade through the plugin public surface", async () => {
    const createStream = vi.fn(
      (model: { baseUrl?: string }, env: NodeJS.ProcessEnv) => async () => ({
        marker: "external-vertex",
        baseUrl: model.baseUrl,
        envMarker: env.OPENCLAW_TEST_MARKER,
      }),
    );
    facadeRuntimeMocks.loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      createAnthropicVertexStreamFnForModel: createStream,
    });

    const { createAnthropicVertexStreamFnForModel } = await import("./anthropic-vertex-stream.js");
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://us-central1-aiplatform.googleapis.com" },
      { OPENCLAW_TEST_MARKER: "registry" },
    );

    expect(facadeRuntimeMocks.loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "anthropic-vertex",
      artifactBasename: "api.js",
    });
    expect(createStream).toHaveBeenCalledWith(
      { baseUrl: "https://us-central1-aiplatform.googleapis.com" },
      { OPENCLAW_TEST_MARKER: "registry" },
    );
    await expect(streamFn({} as never, {} as never, {} as never)).resolves.toEqual({
      marker: "external-vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com",
      envMarker: "registry",
    });
  });
});
