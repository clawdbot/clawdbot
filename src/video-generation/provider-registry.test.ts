import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoGenerationProviderPlugin } from "../plugins/types.js";

const { resolvePluginCapabilityProvidersMock } = vi.hoisted(() => ({
  resolvePluginCapabilityProvidersMock: vi.fn<() => VideoGenerationProviderPlugin[]>(() => []),
}));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
}));

function createProvider(
  params: Pick<VideoGenerationProviderPlugin, "id"> & Partial<VideoGenerationProviderPlugin>,
): VideoGenerationProviderPlugin {
  return {
    label: params.id,
    capabilities: {},
    generateVideo: async () => ({
      videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
    }),
    ...params,
  };
}

async function loadProviderRegistry() {
  vi.resetModules();
  return await import("./provider-registry.js");
}
describe("video-generation provider registry", () => {
  beforeEach(() => {
    vi.resetModules();
    resolvePluginCapabilityProvidersMock.mockReset();
    resolvePluginCapabilityProvidersMock.mockReturnValue([]);
  });

  it("delegates provider resolution to the capability provider boundary", async () => {
    const { listVideoGenerationProviders } = await loadProviderRegistry();

    expect(listVideoGenerationProviders()).toEqual([]);
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "videoGenerationProviders",
      cfg: undefined,
    });
  });

  it("uses active plugin providers without loading from disk", async () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([createProvider({ id: "custom-video" })]);
    const { getVideoGenerationProvider } = await loadProviderRegistry();

    const provider = getVideoGenerationProvider("custom-video");

    expect(provider?.id).toBe("custom-video");
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "videoGenerationProviders",
      cfg: undefined,
    });
  });

  it("ignores prototype-like provider ids and aliases", async () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createProvider({ id: "__proto__", aliases: ["constructor", "prototype"] }),
      createProvider({ id: "safe-video", aliases: ["safe-alias", "constructor"] }),
    ]);
    const { getVideoGenerationProvider, listVideoGenerationProviders } =
      await loadProviderRegistry();

    expect(listVideoGenerationProviders().map((provider) => provider.id)).toEqual(["safe-video"]);
    expect(getVideoGenerationProvider("__proto__")).toBeUndefined();
    expect(getVideoGenerationProvider("constructor")).toBeUndefined();
    expect(getVideoGenerationProvider("safe-alias")?.id).toBe("safe-video");
  });
});
