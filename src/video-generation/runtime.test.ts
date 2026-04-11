import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMediaGenerationRuntimeMocks,
  resetVideoGenerationRuntimeMocks,
} from "../../test/helpers/media-generation/runtime-module-mocks.js";
import type { OpenClawConfig } from "../config/types.js";
import { generateVideo, listRuntimeVideoGenerationProviders } from "./runtime.js";
import type { VideoGenerationProvider } from "./types.js";

const mocks = getMediaGenerationRuntimeMocks();

vi.mock("./model-ref.js", () => ({
  parseVideoGenerationModelRef: mocks.parseVideoGenerationModelRef,
}));

vi.mock("./provider-registry.js", () => ({
  getVideoGenerationProvider: mocks.getVideoGenerationProvider,
  listVideoGenerationProviders: mocks.listVideoGenerationProviders,
}));

describe("video-generation runtime", () => {
  beforeEach(() => {
    resetVideoGenerationRuntimeMocks();
  });

  it("generates videos through the active video-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    let seenAuthStore: unknown;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {},
      async generateVideo(req: { authStore?: unknown }) {
        seenAuthStore = req.authStore;
        return {
          videos: [
            {
              buffer: Buffer.from("mp4-bytes"),
              mimeType: "video/mp4",
              fileName: "sample.mp4",
            },
          ],
          model: "vid-v1",
        };
      },
    };
    mocks.getVideoGenerationProvider.mockReturnValue(provider);

    const result = await generateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "video-plugin/vid-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a cat",
      agentDir: "/tmp/agent",
      authStore,
    });

    expect(result.provider).toBe("video-plugin");
    expect(result.model).toBe("vid-v1");
    expect(result.attempts).toEqual([]);
    expect(result.ignoredOverrides).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(result.videos).toEqual([
      {
        buffer: Buffer.from("mp4-bytes"),
        mimeType: "video/mp4",
        fileName: "sample.mp4",
      },
    ]);
  });

  it("auto-detects and falls through to another configured video-generation provider by default", async () => {
    mocks.getVideoGenerationProvider.mockImplementation((providerId: string) => {
      if (providerId === "openai") {
        return {
          id: "openai",
          defaultModel: "sora-2",
          capabilities: {},
          isConfigured: () => true,
          async generateVideo() {
            throw new Error("Your request was blocked by our moderation system.");
          },
        };
      }
      if (providerId === "runway") {
        return {
          id: "runway",
          defaultModel: "gen4.5",
          capabilities: {},
          isConfigured: () => true,
          async generateVideo() {
            return {
              videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
              model: "gen4.5",
            };
          },
        };
      }
      return undefined;
    });
    mocks.listVideoGenerationProviders.mockReturnValue([
      {
        id: "openai",
        defaultModel: "sora-2",
        capabilities: {},
        isConfigured: () => true,
        generateVideo: async () => ({ videos: [] }),
      },
      {
        id: "runway",
        defaultModel: "gen4.5",
        capabilities: {},
        isConfigured: () => true,
        generateVideo: async () => ({ videos: [] }),
      },
    ]);

    const result = await generateVideo({
      cfg: {} as OpenClawConfig,
      prompt: "animate a cat",
    });

    expect(result.provider).toBe("runway");
    expect(result.model).toBe("gen4.5");
    expect(result.attempts).toEqual([
      {
        provider: "openai",
        model: "sora-2",
        error: "Your request was blocked by our moderation system.",
      },
    ]);
  });

  it("lists runtime video-generation providers through the provider registry", () => {
    const providers: VideoGenerationProvider[] = [
      {
        id: "video-plugin",
        defaultModel: "vid-v1",
        models: ["vid-v1"],
        capabilities: {
          generate: {
            supportsAudio: true,
          },
        },
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        }),
      },
    ];
    mocks.listVideoGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeVideoGenerationProviders({ config: {} as OpenClawConfig })).toEqual(
      providers,
    );
    expect(mocks.listVideoGenerationProviders).toHaveBeenCalledWith({} as OpenClawConfig);
  });

  it("normalizes requested durations to supported provider values", async () => {
    let seenDurationSeconds: number | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    mocks.getVideoGenerationProvider.mockReturnValue({
      id: "video-plugin",
      capabilities: {
        generate: {
          supportedDurationSeconds: [4, 6, 8],
        },
      },
      generateVideo: async (req) => {
        seenDurationSeconds = req.durationSeconds;
        return {
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
          model: "vid-v1",
        };
      },
    });

    const result = await generateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "video-plugin/vid-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a cat",
      durationSeconds: 5,
    });

    expect(seenDurationSeconds).toBe(6);
    expect(result.normalization).toMatchObject({
      durationSeconds: {
        requested: 5,
        applied: 6,
        supportedValues: [4, 6, 8],
      },
    });
    expect(result.metadata).toMatchObject({
      requestedDurationSeconds: 5,
      normalizedDurationSeconds: 6,
      supportedDurationSeconds: [4, 6, 8],
    });
    expect(result.ignoredOverrides).toEqual([]);
  });

  it("ignores unsupported optional overrides per provider", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: string;
          audio?: boolean;
          watermark?: boolean;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("openai/sora-2");
    mocks.getVideoGenerationProvider.mockReturnValue({
      id: "openai",
      capabilities: {
        generate: {
          supportsSize: true,
        },
      },
      generateVideo: async (req) => {
        seenRequest = {
          size: req.size,
          aspectRatio: req.aspectRatio,
          resolution: req.resolution,
          audio: req.audio,
          watermark: req.watermark,
        };
        return {
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
          model: "sora-2",
        };
      },
    });

    const result = await generateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "openai/sora-2" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a lobster",
      size: "1280x720",
      aspectRatio: "16:9",
      resolution: "720P",
      audio: false,
      watermark: false,
    });

    expect(seenRequest).toEqual({
      size: "1280x720",
      aspectRatio: undefined,
      resolution: undefined,
      audio: undefined,
      watermark: undefined,
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "aspectRatio", value: "16:9" },
      { key: "resolution", value: "720P" },
      { key: "audio", value: false },
      { key: "watermark", value: false },
    ]);
  });

  it("uses mode-specific capabilities for image-to-video requests", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("runway/gen4.5");
    mocks.getVideoGenerationProvider.mockReturnValue({
      id: "runway",
      capabilities: {
        generate: {
          supportsSize: true,
          supportsAspectRatio: false,
        },
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
          supportsSize: false,
          supportsAspectRatio: true,
        },
      },
      generateVideo: async (req) => {
        seenRequest = {
          size: req.size,
          aspectRatio: req.aspectRatio,
          resolution: req.resolution,
        };
        return {
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
          model: "gen4.5",
        };
      },
    });

    const result = await generateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "runway/gen4.5" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a lobster",
      size: "1280x720",
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
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

  it("builds a generic config hint without hardcoded provider ids", async () => {
    mocks.listVideoGenerationProviders.mockReturnValue([
      {
        id: "motion-one",
        defaultModel: "animate-v1",
        capabilities: {},
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        }),
      },
    ]);
    mocks.getProviderEnvVars.mockReturnValue(["MOTION_ONE_API_KEY"]);

    const promise = generateVideo({ cfg: {} as OpenClawConfig, prompt: "animate a cat" });

    await expect(promise).rejects.toThrow("No video-generation model configured.");
    await expect(promise).rejects.toThrow(
      'Set agents.defaults.videoGenerationModel.primary to a provider/model like "motion-one/animate-v1".',
    );
    await expect(promise).rejects.toThrow("motion-one: MOTION_ONE_API_KEY");
  });
});
