/** Tests media-generation provider registry aliases and plugin capability integration. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type {
  ImageGenerationProviderPlugin,
  VideoGenerationProviderPlugin,
} from "../plugins/types.js";

type ProviderRegistryModule = typeof import("./registry.js");
type GenerationProviderPlugin = ImageGenerationProviderPlugin | VideoGenerationProviderPlugin;

const resolvePluginCapabilityProvidersMock = vi.hoisted(() =>
  vi.fn<() => GenerationProviderPlugin[]>(() => []),
);
vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
}));

function createImageProvider(
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

function createVideoProvider(
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

function requireImageProvider(
  registry: ProviderRegistryModule,
  id: string,
): ImageGenerationProviderPlugin {
  const provider = registry.getImageGenerationProvider(id);
  if (!provider) {
    throw new Error(`expected image generation provider ${id}`);
  }
  return provider;
}

function requireVideoProvider(
  registry: ProviderRegistryModule,
  id: string,
): VideoGenerationProviderPlugin {
  const provider = registry.getVideoGenerationProvider(id);
  if (!provider) {
    throw new Error(`expected video generation provider ${id}`);
  }
  return provider;
}

let registry: ProviderRegistryModule;

beforeAll(async () => {
  vi.resetModules();
  registry = await import("./registry.js");
});

beforeEach(() => {
  resolvePluginCapabilityProvidersMock.mockReset();
  resolvePluginCapabilityProvidersMock.mockReturnValue([]);
});

describe("image-generation provider registry", () => {
  it("delegates provider resolution to the capability provider boundary", () => {
    const cfg = {} as OpenClawConfig;
    const { listImageGenerationProviders } = registry;

    expect(listImageGenerationProviders(cfg)).toStrictEqual([]);
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      cfg,
    });
  });

  it("resolves active providers through the capability boundary", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createImageProvider({ id: "custom-image" }),
    ]);
    const { getImageGenerationProvider } = registry;

    const provider = getImageGenerationProvider("custom-image");

    expect(provider?.id).toBe("custom-image");
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      cfg: undefined,
    });
  });

  it("ignores prototype-like provider ids and aliases", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createImageProvider({ id: "__proto__", aliases: ["constructor", "prototype"] }),
      createImageProvider({ id: "safe-image", aliases: ["safe-alias", "constructor"] }),
    ]);

    expect(registry.listImageGenerationProviders().map((provider) => provider.id)).toEqual([
      "safe-image",
    ]);
    expect(registry.getImageGenerationProvider("__proto__")).toBeUndefined();
    expect(registry.getImageGenerationProvider("constructor")).toBeUndefined();
    expect(requireImageProvider(registry, "safe-alias").id).toBe("safe-image");
  });
});

describe("video-generation provider registry", () => {
  it("resolves active providers through the capability boundary", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createVideoProvider({ id: "custom-video" }),
    ]);
    const { getVideoGenerationProvider } = registry;

    const provider = getVideoGenerationProvider("custom-video");

    expect(provider?.id).toBe("custom-video");
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "videoGenerationProviders",
      cfg: undefined,
    });
  });

  it("ignores prototype-like provider ids and aliases", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createVideoProvider({ id: "__proto__", aliases: ["constructor", "prototype"] }),
      createVideoProvider({ id: "safe-video", aliases: ["safe-alias", "constructor"] }),
    ]);

    expect(registry.listVideoGenerationProviders().map((provider) => provider.id)).toEqual([
      "safe-video",
    ]);
    expect(registry.getVideoGenerationProvider("__proto__")).toBeUndefined();
    expect(registry.getVideoGenerationProvider("constructor")).toBeUndefined();
    expect(requireVideoProvider(registry, "safe-alias").id).toBe("safe-video");
  });
});
