import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoGenerationProviderPlugin } from "../plugins/types.js";

const resolvePluginCapabilityProvidersMock = vi.hoisted(() =>
  vi.fn<() => VideoGenerationProviderPlugin[]>(() => []),
);
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

async function loadRegistry(): Promise<typeof import("./provider-registry.js")> {
  return await import("./provider-registry.js");
}

function requireLoadedVideoProvider(
  registry: Awaited<ReturnType<typeof loadRegistry>>,
  id: string,
): VideoGenerationProviderPlugin {
  const provider = registry.getVideoGenerationProvider(id);
  if (!provider) {
    throw new Error(`expected video generation provider ${id}`);
  }
  return provider;
}

describe("video-generation provider registry", () => {
  beforeEach(() => {
    vi.resetModules();
    resolvePluginCapabilityProvidersMock.mockReset();
    resolvePluginCapabilityProvidersMock.mockReturnValue([]);
  });

  it("delegates provider resolution to the capability provider boundary", async () => {
    const { listVideoGenerationProviders } = await loadRegistry();

    expect(listVideoGenerationProviders()).toStrictEqual([]);
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "videoGenerationProviders",
      cfg: undefined,
    });
  });

  it("uses active plugin providers without loading from disk", async () => {
    const { getVideoGenerationProvider } = await loadRegistry();
    resolvePluginCapabilityProvidersMock.mockReturnValue([createProvider({ id: "custom-video" })]);

    const provider = getVideoGenerationProvider("custom-video");

    expect(provider?.id).toBe("custom-video");
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "videoGenerationProviders",
      cfg: undefined,
    });
  });

  it("ignores prototype-like provider ids and aliases", async () => {
    const registry = await loadRegistry();
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createProvider({ id: "__proto__", aliases: ["constructor", "prototype"] }),
      createProvider({ id: "safe-video", aliases: ["safe-alias", "constructor"] }),
    ]);

    expect(registry.listVideoGenerationProviders().map((provider) => provider.id)).toEqual([
      "safe-video",
    ]);
    expect(registry.getVideoGenerationProvider("__proto__")).toBeUndefined();
    expect(registry.getVideoGenerationProvider("constructor")).toBeUndefined();
    expect(requireLoadedVideoProvider(registry, "safe-alias").id).toBe("safe-video");
  });
});
