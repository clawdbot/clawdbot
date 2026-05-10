import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "./provider-registry.js";
import type { MediaUnderstandingProvider } from "./types.js";

const resolvePluginCapabilityProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
}));

function createMediaProvider(
  params: Pick<MediaUnderstandingProvider, "id" | "capabilities"> &
    Partial<MediaUnderstandingProvider>,
): MediaUnderstandingProvider {
  return params;
}

function requireMediaProvider(
  registry: Map<string, MediaUnderstandingProvider>,
  providerId: string,
): MediaUnderstandingProvider {
  const provider = getMediaUnderstandingProvider(providerId, registry);
  if (!provider) {
    throw new Error(`expected media-understanding provider ${providerId}`);
  }
  return provider;
}

describe("media-understanding provider registry", () => {
  beforeEach(() => {
    resolvePluginCapabilityProvidersMock.mockReset();
    resolvePluginCapabilityProvidersMock.mockReturnValue([]);
  });

  it("loads media providers from the capability runtime", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({ id: "groq", capabilities: ["image", "audio"] }),
      createMediaProvider({ id: "deepgram", capabilities: ["audio"] }),
    ]);

    const registry = buildMediaUnderstandingRegistry();

    expect(requireMediaProvider(registry, "groq").id).toBe("groq");
    expect(typeof requireMediaProvider(registry, "groq").describeImage).toBe("function");
    expect(typeof requireMediaProvider(registry, "groq").describeImages).toBe("function");
    expect(requireMediaProvider(registry, "deepgram").id).toBe("deepgram");
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "mediaUnderstandingProviders",
      cfg: undefined,
    });
  });

  it("hydrates manifest-only image providers with model-backed image hooks", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({
        id: "zai",
        capabilities: ["image"],
        defaultModels: { image: "glm-4.6v" },
      }),
    ]);

    const registry = buildMediaUnderstandingRegistry();
    const provider = requireMediaProvider(registry, "zai");

    expect(provider.defaultModels?.image).toBe("glm-4.6v");
    expect(provider.describeImage).toBeTypeOf("function");
    expect(provider.describeImages).toBeTypeOf("function");
  });

  it("keeps provider id normalization behavior for capability providers", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({ id: "google", capabilities: ["image", "audio", "video"] }),
    ]);

    const registry = buildMediaUnderstandingRegistry();

    expect(requireMediaProvider(registry, "gemini").id).toBe("google");
  });

  it("auto-registers media-understanding for config providers with image-capable models (#51392)", () => {
    const cfg = {
      models: {
        providers: {
          glm: {
            models: [{ id: "glm-4.6v", input: ["text", "image"] }],
          },
          textOnly: {
            models: [{ id: "text-model", input: ["text"] }],
          },
        },
      },
    } as never;
    const registry = buildMediaUnderstandingRegistry(undefined, cfg);
    const glmProvider = requireMediaProvider(registry, "glm");
    const textOnlyProvider = getMediaUnderstandingProvider("textOnly", registry);

    expect(glmProvider.id).toBe("glm");
    expect(glmProvider.capabilities).toEqual(["image"]);
    expect(typeof glmProvider.describeImage).toBe("function");
    expect(typeof glmProvider.describeImages).toBe("function");
    expect(textOnlyProvider).toBeUndefined();
  });

  it("does not override capability providers when config also has image-capable models", async () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({
        id: "google",
        capabilities: ["image", "audio", "video"],
        describeImage: async () => ({ text: "plugin image" }),
        transcribeAudio: async () => ({ text: "plugin audio" }),
      }),
    ]);
    const cfg = {
      models: {
        providers: {
          google: {
            models: [{ id: "custom-gemini", input: ["text", "image"] }],
          },
        },
      },
    } as never;

    const registry = buildMediaUnderstandingRegistry(undefined, cfg);
    const provider = requireMediaProvider(registry, "google");

    expect(provider.capabilities).toEqual(["image", "audio", "video"]);
    expect(provider.describeImage).toBeTypeOf("function");
    if (!provider.describeImage) {
      throw new Error("expected google describeImage provider hook");
    }
    expect(provider.transcribeAudio).toBeTypeOf("function");
    if (!provider.transcribeAudio) {
      throw new Error("expected google transcribeAudio provider hook");
    }
    expect(await provider.describeImage({} as never)).toEqual({ text: "plugin image" });
    expect(await provider.transcribeAudio({} as never)).toEqual({ text: "plugin audio" });
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "mediaUnderstandingProviders",
      cfg,
    });
  });

  it("does not auto-register providers with audio or video only inputs", () => {
    const cfg = {
      models: {
        providers: {
          avOnly: {
            models: [
              { id: "audio-model", input: ["text", "audio"] },
              { id: "video-model", input: ["text", "video"] },
            ],
          },
        },
      },
    } as never;

    const registry = buildMediaUnderstandingRegistry(undefined, cfg);

    expect(getMediaUnderstandingProvider("avOnly", registry)).toBeUndefined();
  });
});
