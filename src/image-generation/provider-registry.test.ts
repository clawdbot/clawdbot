import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { ImageGenerationProviderPlugin } from "../plugins/types.js";
import type * as ProviderRegistry from "./provider-registry.js";

const { resolvePluginCapabilityProvidersMock } = vi.hoisted(() => ({
  resolvePluginCapabilityProvidersMock: vi.fn<() => ImageGenerationProviderPlugin[]>(() => []),
}));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
}));

let getImageGenerationProvider: typeof ProviderRegistry.getImageGenerationProvider;
let listImageGenerationProviders: typeof ProviderRegistry.listImageGenerationProviders;

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

describe("image-generation provider registry", () => {
  beforeEach(async () => {
    vi.resetModules();
    resolvePluginCapabilityProvidersMock.mockReset();
    resolvePluginCapabilityProvidersMock.mockReturnValue([]);
    ({ getImageGenerationProvider, listImageGenerationProviders } =
      await import("./provider-registry.js"));
  });

  it("delegates provider resolution to the capability provider boundary", () => {
    const cfg = {} as OpenClawConfig;

    expect(listImageGenerationProviders(cfg)).toEqual([]);
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      cfg,
    });
  });

  it("uses active plugin providers without loading from disk", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([createProvider({ id: "custom-image" })]);

    const provider = getImageGenerationProvider("custom-image");

    expect(provider?.id).toBe("custom-image");
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      cfg: undefined,
    });
  });

  it("ignores prototype-like provider ids and aliases", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createProvider({ id: "__proto__", aliases: ["constructor", "prototype"] }),
      createProvider({ id: "safe-image", aliases: ["safe-alias", "constructor"] }),
    ]);

    expect(listImageGenerationProviders().map((provider) => provider.id)).toEqual(["safe-image"]);
    expect(getImageGenerationProvider("__proto__")).toBeUndefined();
    expect(getImageGenerationProvider("constructor")).toBeUndefined();
    expect(getImageGenerationProvider("safe-alias")?.id).toBe("safe-image");
  });
});
