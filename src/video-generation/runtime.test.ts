import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMediaGenerationRuntimeMocks,
  resetVideoGenerationRuntimeMocks,
} from "../../test/helpers/media-generation/runtime-module-mocks.js";
import type { OpenClawConfig } from "../config/types.js";
import { generateVideo, listRuntimeVideoGenerationProviders } from "./runtime.js";
import type { VideoGenerationProvider, VideoGenerationProviderOptionType } from "./types.js";

const mocks = getMediaGenerationRuntimeMocks();

vi.mock("./model-ref.js", () => ({
  parseVideoGenerationModelRef: mocks.parseVideoGenerationModelRef,
}));

vi.mock("./provider-registry.js", () => ({
  getVideoGenerationProvider: mocks.getVideoGenerationProvider,
  listVideoGenerationProviders: mocks.listVideoGenerationProviders,
}));

function createProviderOptionsCaptureProvider(
  capabilities: VideoGenerationProvider["capabilities"],
): { provider: VideoGenerationProvider; getSeenProviderOptions: () => unknown } {
  let seenProviderOptions: unknown;
  return {
    provider: {
      id: "video-plugin",
      capabilities,
      async generateVideo(req) {
        seenProviderOptions = req.providerOptions;
        return { videos: [{ buffer: Buffer.from("x"), mimeType: "video/mp4" }] };
      },
    },
    getSeenProviderOptions: () => seenProviderOptions,
  };
}

describe("video-generation runtime", () => {
  beforeEach(() => {
    resetVideoGenerationRuntimeMocks();
  });

  it("generates videos through the active video-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    let seenAuthStore: unknown;
    let seenTimeoutMs: number | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {},
      async generateVideo(req: { authStore?: unknown; timeoutMs?: number }) {
        seenAuthStore = req.authStore;
        seenTimeoutMs = req.timeoutMs;
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
      timeoutMs: 12_345,
    });

    expect(result.provider).toBe("video-plugin");
    expect(result.model).toBe("vid-v1");
    expect(result.attempts).toEqual([]);
    expect(result.ignoredOverrides).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(seenTimeoutMs).toBe(12_345);
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

  it("forwards providerOptions to providers that declare the matching schema", async () => {
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    const { provider, getSeenProviderOptions } = createProviderOptionsCaptureProvider({
      providerOptions: {
        seed: "number",
        draft: "boolean",
        camera_fixed: "boolean",
      },
    });
    mocks.getVideoGenerationProvider.mockReturnValue(provider);

    await generateVideo({
      cfg: {
        agents: { defaults: { videoGenerationModel: { primary: "video-plugin/vid-v1" } } },
      } as OpenClawConfig,
      prompt: "test",
      providerOptions: { seed: 42, draft: true, camera_fixed: false },
    });

    expect(getSeenProviderOptions()).toEqual({ seed: 42, draft: true, camera_fixed: false });
  });

  it("passes providerOptions through to providers that do not declare any schema", async () => {
    // Undeclared schema = backward-compatible pass-through: the provider receives the
    // options and can handle or ignore them. No skip occurs.
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    const { provider, getSeenProviderOptions } = createProviderOptionsCaptureProvider({});
    mocks.getVideoGenerationProvider.mockReturnValue(provider);

    await generateVideo({
      cfg: {
        agents: { defaults: { videoGenerationModel: { primary: "video-plugin/vid-v1" } } },
      } as OpenClawConfig,
      prompt: "test",
      providerOptions: { seed: 42 },
    });

    expect(getSeenProviderOptions()).toEqual({ seed: 42 });
  });

  it("skips candidates that explicitly declare an empty providerOptions schema", async () => {
    // Explicitly declared empty schema ({}) = provider has opted in and supports no options.
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {
        providerOptions: {
          // explicitly empty
        } as Record<string, VideoGenerationProviderOptionType>,
      },
      async generateVideo() {
        throw new Error("should not be called");
      },
    };
    mocks.getVideoGenerationProvider.mockReturnValue(provider);

    await expect(
      generateVideo({
        cfg: {
          agents: { defaults: { videoGenerationModel: { primary: "video-plugin/vid-v1" } } },
        } as OpenClawConfig,
        prompt: "test",
        providerOptions: { seed: 42 },
      }),
    ).rejects.toThrow(/does not accept providerOptions/);
  });

  it("skips candidates that declare a providerOptions schema missing the requested key", async () => {
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {
        providerOptions: { draft: "boolean" },
      },
      async generateVideo() {
        throw new Error("should not be called");
      },
    };
    mocks.getVideoGenerationProvider.mockReturnValue(provider);

    await expect(
      generateVideo({
        cfg: {
          agents: { defaults: { videoGenerationModel: { primary: "video-plugin/vid-v1" } } },
        } as OpenClawConfig,
        prompt: "test",
        providerOptions: { seed: 42 },
      }),
    ).rejects.toThrow(/does not accept providerOptions keys: seed \(accepted: draft\)/);
  });

  it("skips candidates when providerOptions values do not match the declared type", async () => {
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {
        providerOptions: { seed: "number" },
      },
      async generateVideo() {
        throw new Error("should not be called");
      },
    };
    mocks.getVideoGenerationProvider.mockReturnValue(provider);

    await expect(
      generateVideo({
        cfg: {
          agents: { defaults: { videoGenerationModel: { primary: "video-plugin/vid-v1" } } },
        } as OpenClawConfig,
        prompt: "test",
        providerOptions: { seed: "forty-two" },
      }),
    ).rejects.toThrow(/expects providerOptions\.seed to be a finite number, got string/);
  });

  it("falls over from a provider with explicitly empty providerOptions schema to one that has it", async () => {
    // Explicitly empty schema ({}) causes a skip; undeclared schema passes through.
    // Here "openai" declares {} to signal it has been audited and truly accepts no options.
    mocks.getVideoGenerationProvider.mockImplementation((providerId: string) => {
      if (providerId === "openai") {
        return {
          id: "openai",
          defaultModel: "sora-2",
          capabilities: {
            providerOptions: {} as Record<string, VideoGenerationProviderOptionType>,
          }, // explicitly empty: accepts no options
          isConfigured: () => true,
          async generateVideo() {
            throw new Error("should not be called");
          },
        };
      }
      if (providerId === "byteplus") {
        return {
          id: "byteplus",
          defaultModel: "seedance-1-0-pro-250528",
          capabilities: {
            providerOptions: { seed: "number" },
          },
          isConfigured: () => true,
          async generateVideo(req) {
            expect(req.providerOptions).toEqual({ seed: 42 });
            return {
              videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
              model: "seedance-1-0-pro-250528",
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
        capabilities: { providerOptions: {} as Record<string, VideoGenerationProviderOptionType> },
        isConfigured: () => true,
        generateVideo: async () => ({ videos: [] }),
      },
      {
        id: "byteplus",
        defaultModel: "seedance-1-0-pro-250528",
        capabilities: { providerOptions: { seed: "number" } },
        isConfigured: () => true,
        generateVideo: async () => ({ videos: [] }),
      },
    ]);

    const result = await generateVideo({
      cfg: {} as OpenClawConfig,
      prompt: "animate a cat",
      providerOptions: { seed: 42 },
    });

    expect(result.provider).toBe("byteplus");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.provider).toBe("openai");
    expect(result.attempts[0]?.error).toMatch(/does not accept providerOptions/);
  });

  it("skips providers that cannot satisfy reference audio inputs and falls back", async () => {
    mocks.getVideoGenerationProvider.mockImplementation((providerId: string) => {
      if (providerId === "openai") {
        return {
          id: "openai",
          defaultModel: "sora-2",
          capabilities: {},
          isConfigured: () => true,
          async generateVideo() {
            throw new Error("should not be called");
          },
        };
      }
      if (providerId === "byteplus") {
        return {
          id: "byteplus",
          defaultModel: "seedance-1-0-pro-250528",
          capabilities: {
            maxInputAudios: 1,
          },
          isConfigured: () => true,
          async generateVideo(req) {
            expect(req.inputAudios).toEqual([
              { url: "https://example.com/reference-audio.mp3", role: "reference_audio" },
            ]);
            return {
              videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
              model: "seedance-1-0-pro-250528",
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
        id: "byteplus",
        defaultModel: "seedance-1-0-pro-250528",
        capabilities: { maxInputAudios: 1 },
        isConfigured: () => true,
        generateVideo: async () => ({ videos: [] }),
      },
    ]);

    const result = await generateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "openai/sora-2" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a cat",
      inputAudios: [{ url: "https://example.com/reference-audio.mp3", role: "reference_audio" }],
    });

    expect(result.provider).toBe("byteplus");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.provider).toBe("openai");
    expect(result.attempts[0]?.error).toMatch(/does not support reference audio inputs/);
  });

  it("forwards mixed image, video, and audio references when explicitly supported", async () => {
    const seenRequest: {
      inputImages?: unknown;
      inputVideos?: unknown;
      inputAudios?: unknown;
    } = {};
    mocks.resolveAgentModelPrimaryValue.mockReturnValue(
      "fal/bytedance/seedance-2.0/fast/reference-to-video",
    );
    mocks.getVideoGenerationProvider.mockReturnValue({
      id: "fal",
      capabilities: {
        videoToVideo: {
          enabled: true,
          maxInputImages: 9,
          maxInputVideos: 3,
          maxInputAudios: 3,
        },
      },
      async generateVideo(req) {
        seenRequest.inputImages = req.inputImages;
        seenRequest.inputVideos = req.inputVideos;
        seenRequest.inputAudios = req.inputAudios;
        return {
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
          model: "bytedance/seedance-2.0/fast/reference-to-video",
        };
      },
    });

    const result = await generateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: {
              primary: "fal/bytedance/seedance-2.0/fast/reference-to-video",
            },
          },
        },
      } as OpenClawConfig,
      prompt: "Blend all references",
      inputImages: [{ url: "https://example.com/reference.png" }],
      inputVideos: [{ url: "https://example.com/reference.mp4" }],
      inputAudios: [{ url: "https://example.com/reference.mp3" }],
    });

    expect(result.provider).toBe("fal");
    expect(result.attempts).toEqual([]);
    expect(seenRequest).toEqual({
      inputImages: [{ url: "https://example.com/reference.png" }],
      inputVideos: [{ url: "https://example.com/reference.mp4" }],
      inputAudios: [{ url: "https://example.com/reference.mp3" }],
    });
  });

  it("fails when every candidate is skipped for unsupported reference audio inputs", async () => {
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("openai/sora-2");
    mocks.getVideoGenerationProvider.mockReturnValue({
      id: "openai",
      capabilities: {},
      async generateVideo() {
        throw new Error("should not be called");
      },
    });

    await expect(
      generateVideo({
        cfg: {
          agents: { defaults: { videoGenerationModel: { primary: "openai/sora-2" } } },
        } as OpenClawConfig,
        prompt: "animate a cat",
        inputAudios: [{ url: "https://example.com/reference-audio.mp3" }],
      }),
    ).rejects.toThrow(/does not support reference audio inputs/);
  });

  it("skips providers whose hard duration cap is below the request and falls back", async () => {
    let seenDurationSeconds: number | undefined;
    mocks.getVideoGenerationProvider.mockImplementation((providerId: string) => {
      if (providerId === "openai") {
        return {
          id: "openai",
          defaultModel: "sora-2",
          capabilities: {
            generate: {
              maxDurationSeconds: 4,
            },
          },
          isConfigured: () => true,
          async generateVideo() {
            throw new Error("should not be called");
          },
        };
      }
      if (providerId === "runway") {
        return {
          id: "runway",
          defaultModel: "gen4.5",
          capabilities: {
            generate: {
              maxDurationSeconds: 8,
            },
          },
          isConfigured: () => true,
          async generateVideo(req) {
            seenDurationSeconds = req.durationSeconds;
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
        capabilities: { generate: { maxDurationSeconds: 4 } },
        isConfigured: () => true,
        generateVideo: async () => ({ videos: [] }),
      },
      {
        id: "runway",
        defaultModel: "gen4.5",
        capabilities: { generate: { maxDurationSeconds: 8 } },
        isConfigured: () => true,
        generateVideo: async () => ({ videos: [] }),
      },
    ]);

    const result = await generateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "openai/sora-2" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a cat",
      durationSeconds: 6,
    });

    expect(result.provider).toBe("runway");
    expect(seenDurationSeconds).toBe(6);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.provider).toBe("openai");
    expect(result.attempts[0]?.error).toMatch(/supports at most 4s per video, 6s requested/);
  });

  it("fails when every candidate is skipped for exceeding hard duration caps", async () => {
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("openai/sora-2");
    mocks.getVideoGenerationProvider.mockReturnValue({
      id: "openai",
      capabilities: {
        generate: {
          maxDurationSeconds: 4,
        },
      },
      async generateVideo() {
        throw new Error("should not be called");
      },
    });

    await expect(
      generateVideo({
        cfg: {
          agents: { defaults: { videoGenerationModel: { primary: "openai/sora-2" } } },
        } as OpenClawConfig,
        prompt: "animate a cat",
        durationSeconds: 6,
      }),
    ).rejects.toThrow(/supports at most 4s per video, 6s requested/);
  });

  it("rejects provider results that contain undeliverable assets", async () => {
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    mocks.getVideoGenerationProvider.mockReturnValue({
      id: "video-plugin",
      capabilities: {},
      generateVideo: async () => ({
        videos: [{ mimeType: "video/mp4" }],
      }),
    });

    await expect(
      generateVideo({
        cfg: {
          agents: {
            defaults: {
              videoGenerationModel: { primary: "video-plugin/vid-v1" },
            },
          },
        } as OpenClawConfig,
        prompt: "animate a cat",
      }),
    ).rejects.toThrow(/neither buffer nor url is set/);
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

    await expect(
      generateVideo({ cfg: {} as OpenClawConfig, prompt: "animate a cat" }),
    ).rejects.toThrow(
      'No video-generation model configured. Set agents.defaults.videoGenerationModel.primary to a provider/model like "motion-one/animate-v1". If you want a specific provider, also configure that provider\'s auth/API key first (motion-one: MOTION_ONE_API_KEY).',
    );
  });
});
