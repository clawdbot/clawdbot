import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { ImageGenerationProviderPlugin } from "../plugins/types.js";

const resolvePluginCapabilityProvidersMock = vi.hoisted(() =>
  vi.fn<() => ImageGenerationProviderPlugin[]>(() => []),
);
vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
}));

function createProvider(
  params: Pick<ImageGenerationProviderPlugin, "id"> & Partial<ImageGenerationProviderPlugin>,
): ImageGenerationProviderPlugin {
  return {
    label: params.id,
    capabilities: {
      generate: {},
      edit: { enabled: false },
    },
    generateImage: async () => ({
      images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
    }),
    ...params,
  };
}

type ImageProviderRegistry = typeof import("./provider-registry.js");

function requireImageProvider(
  registry: ImageProviderRegistry,
  id: string,
): ImageGenerationProviderPlugin {
  const provider = registry.getImageGenerationProvider(id);
  if (!provider) {
    throw new Error(`expected image generation provider ${id}`);
  }
  return provider;
}

async function loadProviderRegistry(): Promise<ImageProviderRegistry> {
  vi.resetModules();
  return await import("./provider-registry.js");
}

describe("image-generation provider registry", () => {
  beforeEach(() => {
    vi.resetModules();
    resolvePluginCapabilityProvidersMock.mockReset();
    resolvePluginCapabilityProvidersMock.mockReturnValue([]);
  });

  it("delegates provider resolution to the capability provider boundary", async () => {
    const { listImageGenerationProviders } = await loadProviderRegistry();
    const cfg = {} as OpenClawConfig;

    expect(listImageGenerationProviders(cfg)).toStrictEqual([]);
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      cfg,
    });
  });

  it("uses active plugin providers without loading from disk", async () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([createProvider({ id: "custom-image" })]);
    const { getImageGenerationProvider } = await loadProviderRegistry();

    const provider = getImageGenerationProvider("custom-image");

    expect(provider?.id).toBe("custom-image");
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      cfg: undefined,
    });
  });

  it("ignores prototype-like provider ids and aliases", async () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createProvider({ id: "__proto__", aliases: ["constructor", "prototype"] }),
      createProvider({ id: "safe-image", aliases: ["safe-alias", "constructor"] }),
    ]);
    const registry = await loadProviderRegistry();
    const { getImageGenerationProvider, listImageGenerationProviders } = registry;

    expect(listImageGenerationProviders().map((provider) => provider.id)).toEqual(["safe-image"]);
    expect(getImageGenerationProvider("__proto__")).toBeUndefined();
    expect(getImageGenerationProvider("constructor")).toBeUndefined();
    expect(requireImageProvider(registry, "safe-alias").id).toBe("safe-image");
  });
});
