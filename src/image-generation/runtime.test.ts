import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMediaGenerationRuntimeMocks,
  resetImageGenerationRuntimeMocks,
} from "../../test/helpers/media-generation/runtime-module-mocks.js";
import type { OpenClawConfig } from "../config/config.js";
import { generateImage, listRuntimeImageGenerationProviders } from "./runtime.js";
import type { ImageGenerationProvider } from "./types.js";

const mocks = getMediaGenerationRuntimeMocks();

vi.mock("./model-ref.js", () => ({
  parseImageGenerationModelRef: mocks.parseImageGenerationModelRef,
}));

vi.mock("./provider-registry.js", () => ({
  getImageGenerationProvider: mocks.getImageGenerationProvider,
  listImageGenerationProviders: mocks.listImageGenerationProviders,
}));

describe("image-generation runtime", () => {
  beforeEach(() => {
    resetImageGenerationRuntimeMocks();
  });

  it("generates images through the active image-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    let seenAuthStore: unknown;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("image-plugin/img-v1");
    const provider: ImageGenerationProvider = {
      id: "image-plugin",
      capabilities: {
        generate: {},
        edit: { enabled: false },
      },
      async generateImage(req: { authStore?: unknown }) {
        seenAuthStore = req.authStore;
        return {
          images: [
            {
              buffer: Buffer.from("png-bytes"),
              mimeType: "image/png",
              fileName: "sample.png",
            },
          ],
          model: "img-v1",
        };
      },
    };
    mocks.getImageGenerationProvider.mockReturnValue(provider);

    const result = await generateImage({
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "image-plugin/img-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "draw a cat",
      agentDir: "/tmp/agent",
      authStore,
    });

    expect(result.provider).toBe("image-plugin");
    expect(result.model).toBe("img-v1");
    expect(result.attempts).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(result.images).toEqual([
      {
        buffer: Buffer.from("png-bytes"),
        mimeType: "image/png",
        fileName: "sample.png",
      },
    ]);
    expect(result.ignoredOverrides).toEqual([]);
  });

  it("auto-detects and falls through to another configured image-generation provider by default", async () => {
    mocks.getImageGenerationProvider.mockImplementation((providerId: string) => {
      if (providerId === "openai") {
        return {
          id: "openai",
          defaultModel: "gpt-image-1",
          capabilities: {
            generate: {},
            edit: { enabled: true },
          },
          isConfigured: () => true,
          async generateImage() {
            throw new Error("OpenAI API key missing");
          },
        };
      }
      if (providerId === "google") {
        return {
          id: "google",
          defaultModel: "gemini-3.1-flash-image-preview",
          capabilities: {
            generate: {},
            edit: { enabled: true },
          },
          isConfigured: () => true,
          async generateImage() {
            return {
              images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
              model: "gemini-3.1-flash-image-preview",
            };
          },
        };
      }
      return undefined;
    });
    mocks.listImageGenerationProviders.mockReturnValue([
      {
        id: "openai",
        defaultModel: "gpt-image-1",
        capabilities: {
          generate: {},
          edit: { enabled: true },
        },
        isConfigured: () => true,
        generateImage: async () => ({ images: [] }),
      },
      {
        id: "google",
        defaultModel: "gemini-3.1-flash-image-preview",
        capabilities: {
          generate: {},
          edit: { enabled: true },
        },
        isConfigured: () => true,
        generateImage: async () => ({ images: [] }),
      },
    ]);

    const result = await generateImage({
      cfg: {} as OpenClawConfig,
      prompt: "draw a cat",
    });

    expect(result.provider).toBe("google");
    expect(result.model).toBe("gemini-3.1-flash-image-preview");
    expect(result.attempts).toEqual([
      {
        provider: "openai",
        model: "gpt-image-1",
        error: "OpenAI API key missing",
      },
    ]);
  });

  it("drops unsupported provider geometry overrides and reports them", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("openai/gpt-image-1");
    mocks.getImageGenerationProvider.mockReturnValue({
      id: "openai",
      capabilities: {
        generate: {
          supportsSize: true,
          supportsAspectRatio: false,
          supportsResolution: false,
        },
        edit: {
          enabled: true,
          supportsSize: true,
          supportsAspectRatio: false,
          supportsResolution: false,
        },
        geometry: {
          sizes: ["1024x1024", "1024x1536", "1536x1024"],
        },
      },
      async generateImage(req) {
        seenRequest = {
          size: req.size,
          aspectRatio: req.aspectRatio,
          resolution: req.resolution,
        };
        return {
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        };
      },
    });

    const result = await generateImage({
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "openai/gpt-image-1" },
          },
        },
      } as OpenClawConfig,
      prompt: "draw a cat",
      size: "1024x1024",
      aspectRatio: "1:1",
      resolution: "2K",
    });

    expect(seenRequest).toEqual({
      size: "1024x1024",
      aspectRatio: undefined,
      resolution: undefined,
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "aspectRatio", value: "1:1" },
      { key: "resolution", value: "2K" },
    ]);
  });

  it("maps requested size to the closest supported fallback geometry", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("minimax/image-01");
    mocks.getImageGenerationProvider.mockReturnValue({
      id: "minimax",
      capabilities: {
        generate: {
          supportsSize: false,
          supportsAspectRatio: true,
          supportsResolution: false,
        },
        edit: {
          enabled: true,
          supportsSize: false,
          supportsAspectRatio: true,
          supportsResolution: false,
        },
        geometry: {
          aspectRatios: ["1:1", "16:9"],
        },
      },
      async generateImage(req) {
        seenRequest = {
          size: req.size,
          aspectRatio: req.aspectRatio,
          resolution: req.resolution,
        };
        return {
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
          model: "image-01",
        };
      },
    });

    const result = await generateImage({
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "minimax/image-01" },
          },
        },
      } as OpenClawConfig,
      prompt: "draw a cat",
      size: "1280x720",
    });

    expect(seenRequest).toEqual({
      size: undefined,
      aspectRatio: "16:9",
      resolution: undefined,
    });
    expect(result.ignoredOverrides).toEqual([]);
    expect(result.normalization).toMatchObject({
      aspectRatio: {
        applied: "16:9",
        derivedFrom: "size",
      },
    });
    expect(result.metadata).toMatchObject({
      requestedSize: "1280x720",
      normalizedAspectRatio: "16:9",
      aspectRatioDerivedFromSize: "16:9",
    });
  });

  it("lists runtime image-generation providers through the provider registry", () => {
    const providers: ImageGenerationProvider[] = [
      {
        id: "image-plugin",
        defaultModel: "img-v1",
        models: ["img-v1", "img-v2"],
        capabilities: {
          generate: {
            supportsResolution: true,
          },
          edit: {
            enabled: true,
            maxInputImages: 3,
          },
          geometry: {
            resolutions: ["1K", "2K"],
          },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
      },
    ];
    mocks.listImageGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeImageGenerationProviders({ config: {} as OpenClawConfig })).toEqual(
      providers,
    );
    expect(mocks.listImageGenerationProviders).toHaveBeenCalledWith({} as OpenClawConfig);
  });

  it("builds a generic config hint without hardcoded provider ids", async () => {
    mocks.listImageGenerationProviders.mockReturnValue([
      {
        id: "vision-one",
        defaultModel: "paint-v1",
        isConfigured: () => false,
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
      },
      {
        id: "vision-two",
        defaultModel: "paint-v2",
        isConfigured: () => false,
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
      },
    ]);
    mocks.getProviderEnvVars.mockImplementation((providerId: string) => {
      if (providerId === "vision-one") {
        return ["VISION_ONE_API_KEY"];
      }
      if (providerId === "vision-two") {
        return ["VISION_TWO_API_KEY"];
      }
      return [];
    });

    await expect(
      generateImage({ cfg: {} as OpenClawConfig, prompt: "draw a cat" }),
    ).rejects.toThrow(
      'No image-generation model configured. Set agents.defaults.imageGenerationModel.primary to a provider/model like "vision-one/paint-v1". If you want a specific provider, also configure that provider\'s auth/API key first (vision-one: VISION_ONE_API_KEY; vision-two: VISION_TWO_API_KEY).',
    );
  });
});
