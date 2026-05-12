import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  generateVideo,
  listRuntimeVideoGenerationProviders,
  type GenerateVideoParams,
  type VideoGenerationRuntimeDeps,
} from "./runtime.js";
import type { VideoGenerationProvider, VideoGenerationProviderOptionType } from "./types.js";

let providers: VideoGenerationProvider[] = [];
let listedConfigs: Array<OpenClawConfig | undefined> = [];
let providerEnvVars: Record<string, string[]> = {};

const runtimeDeps: VideoGenerationRuntimeDeps = {
  getProvider: (providerId) => providers.find((provider) => provider.id === providerId),
  listProviders: (config) => {
    listedConfigs.push(config);
    return providers;
  },
  getProviderEnvVars: (providerId) => providerEnvVars[providerId] ?? [],
  log: {
    debug: () => {},
    warn: () => {},
  },
};

function runGenerateVideo(params: GenerateVideoParams) {
  return generateVideo(params, runtimeDeps);
}

function requireAttempt(
  result: Awaited<ReturnType<typeof runGenerateVideo>>,
  index: number,
): NonNullable<(typeof result.attempts)[number]> {
  const attempt = result.attempts[index];
  if (!attempt) {
    throw new Error(`expected video generation attempt ${index}`);
  }
  return attempt;
}

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
    providers = [];
    listedConfigs = [];
    providerEnvVars = {};
  });

  it("generates videos through the active video-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    let seenAuthStore: unknown;
    let seenTimeoutMs: number | undefined;
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
    providers = [provider];

    const result = await runGenerateVideo({
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
    expect(result.attempts).toStrictEqual([]);
    expect(result.ignoredOverrides).toStrictEqual([]);
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

  it("uses configured video-generation timeout when call omits timeoutMs", async () => {
    let seenTimeoutMs: number | undefined;
    providers = [
      {
        id: "video-plugin",
        capabilities: {},
        async generateVideo(req: { timeoutMs?: number }) {
          seenTimeoutMs = req.timeoutMs;
          return {
            videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
            model: "vid-v1",
          };
        },
      },
    ];

    await runGenerateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "video-plugin/vid-v1", timeoutMs: 300_000 },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a cat",
    });

    expect(seenTimeoutMs).toBe(300_000);
  });

  it("does not list providers when explicit config disables auto provider fallback", async () => {
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {},
      async generateVideo() {
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
    providers = [provider];

    const params: GenerateVideoParams = {
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "video-plugin/vid-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a cat",
      autoProviderFallback: false,
    };

    const result = await runGenerateVideo(params);

    expect(result.provider).toBe("video-plugin");
    expect(listedConfigs).toStrictEqual([]);
  });

  it("auto-detects and falls through to another configured video-generation provider by default", async () => {
    providers = [
      {
        id: "openai",
        defaultModel: "sora-2",
        capabilities: {},
        isConfigured: () => true,
        async generateVideo() {
          throw new Error("Your request was blocked by our moderation system.");
        },
      },
      {
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
      },
    ];

    const result = await runGenerateVideo({
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
    const { provider, getSeenProviderOptions } = createProviderOptionsCaptureProvider({
      providerOptions: {
        seed: "number",
        draft: "boolean",
        camera_fixed: "boolean",
      },
    });
    providers = [provider];

    await runGenerateVideo({
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
    const { provider, getSeenProviderOptions } = createProviderOptionsCaptureProvider({});
    providers = [provider];

    await runGenerateVideo({
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
    providers = [provider];

    await expect(
      runGenerateVideo({
        cfg: {
          agents: { defaults: { videoGenerationModel: { primary: "video-plugin/vid-v1" } } },
        } as OpenClawConfig,
        prompt: "test",
        providerOptions: { seed: 42 },
      }),
    ).rejects.toThrow(/does not accept providerOptions/);
  });

  it("skips candidates that declare a providerOptions schema missing the requested key", async () => {
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {
        providerOptions: { draft: "boolean" },
      },
      async generateVideo() {
        throw new Error("should not be called");
      },
    };
    providers = [provider];

    await expect(
      runGenerateVideo({
        cfg: {
          agents: { defaults: { videoGenerationModel: { primary: "video-plugin/vid-v1" } } },
        } as OpenClawConfig,
        prompt: "test",
        providerOptions: { seed: 42 },
      }),
    ).rejects.toThrow(/does not accept providerOptions keys: seed \(accepted: draft\)/);
  });

  it("skips candidates when providerOptions values do not match the declared type", async () => {
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {
        providerOptions: { seed: "number" },
      },
      async generateVideo() {
        throw new Error("should not be called");
      },
    };
    providers = [provider];

    await expect(
      runGenerateVideo({
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
    providers = [
      {
        id: "openai",
        defaultModel: "sora-2",
        capabilities: { providerOptions: {} as Record<string, VideoGenerationProviderOptionType> },
        isConfigured: () => true,
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
      {
        id: "byteplus",
        defaultModel: "seedance-1-0-pro-250528",
        capabilities: { providerOptions: { seed: "number" } },
        isConfigured: () => true,
        async generateVideo(req) {
          expect(req.providerOptions).toEqual({ seed: 42 });
          return {
            videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
            model: "seedance-1-0-pro-250528",
          };
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: {} as OpenClawConfig,
      prompt: "animate a cat",
      providerOptions: { seed: 42 },
    });

    expect(result.provider).toBe("byteplus");
    expect(result.attempts).toHaveLength(1);
    const attempt = requireAttempt(result, 0);
    expect(attempt.provider).toBe("openai");
    expect(attempt.error).toMatch(/does not accept providerOptions/);
  });

  it("overlays selected-model capabilities before option guards and normalization", async () => {
    let seenCapabilityLookupTimeoutMs: number | undefined;
    let seenSupportedDurationHint: readonly number[] | undefined;
    let seenRequest:
      | {
          durationSeconds?: number;
          providerOptions?: Record<string, unknown>;
          resolution?: string;
          audio?: boolean;
        }
      | undefined;
    providers = [
      {
        id: "openrouter",
        capabilities: {
          providerOptions: {} as Record<string, VideoGenerationProviderOptionType>,
          generate: {
            supportsResolution: true,
            resolutions: ["1080P"],
            supportedDurationSeconds: [8],
            supportsAudio: true,
          },
        },
        resolveModelCapabilities: async (ctx) => {
          seenCapabilityLookupTimeoutMs = ctx.timeoutMs;
          return {
            providerOptions: { seed: "number" },
            generate: {
              supportsResolution: true,
              resolutions: ["720P"],
              supportedDurationSeconds: [5],
              supportsAudio: false,
            },
          };
        },
        async generateVideo(req) {
          seenSupportedDurationHint = (req as Record<symbol, readonly number[] | undefined>)[
            Symbol.for("openclaw.videoGeneration.supportedDurations")
          ];
          seenRequest = {
            durationSeconds: req.durationSeconds,
            providerOptions: req.providerOptions,
            resolution: req.resolution,
            audio: req.audio,
          };
          return {
            videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
            model: "google/veo-3.1",
          };
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "openrouter/google/veo-3.1" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a cat",
      durationSeconds: 6,
      providerOptions: { seed: 42 },
      resolution: "720P",
      audio: true,
      timeoutMs: 120_000,
    });

    expect(result.attempts).toEqual([]);
    expect(seenRequest).toEqual({
      durationSeconds: 5,
      providerOptions: { seed: 42 },
      resolution: "720P",
      audio: undefined,
    });
    expect(seenCapabilityLookupTimeoutMs).toBe(5_000);
    expect(seenSupportedDurationHint).toEqual([5]);
    expect(result.ignoredOverrides).toEqual([{ key: "audio", value: true }]);
    expect(result.normalization).toEqual({
      durationSeconds: {
        requested: 6,
        applied: 5,
        supportedValues: [5],
      },
    });
  });

  it("skips providers that cannot satisfy reference audio inputs and falls back", async () => {
    providers = [
      {
        id: "openai",
        defaultModel: "sora-2",
        capabilities: {},
        isConfigured: () => true,
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
      {
        id: "byteplus",
        defaultModel: "seedance-1-0-pro-250528",
        capabilities: { maxInputAudios: 1 },
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
      },
    ];

    const result = await runGenerateVideo({
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
    const attempt = requireAttempt(result, 0);
    expect(attempt.provider).toBe("openai");
    expect(attempt.error).toMatch(/does not support reference audio inputs/);
  });

  it("skips providers whose live model capabilities lower image input limits", async () => {
    let fallbackCalled = false;
    providers = [
      {
        id: "openrouter",
        defaultModel: "minimax/hailuo-2.3",
        capabilities: {
          imageToVideo: {
            enabled: true,
            maxInputImages: 4,
          },
        },
        isConfigured: () => true,
        resolveModelCapabilities: async () => ({
          imageToVideo: {
            enabled: true,
            maxInputImages: 1,
          },
        }),
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
      {
        id: "runway",
        defaultModel: "gen4.5",
        capabilities: {
          imageToVideo: {
            enabled: true,
            maxInputImages: 2,
          },
        },
        isConfigured: () => true,
        async generateVideo(req) {
          fallbackCalled = true;
          expect(req.inputImages).toHaveLength(2);
          return {
            videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
            model: "gen4.5",
          };
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "openrouter/minimax/hailuo-2.3" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate two references",
      inputImages: [
        { url: "https://example.com/first.png" },
        { url: "https://example.com/second.png" },
      ],
    });

    expect(result.provider).toBe("runway");
    expect(fallbackCalled).toBe(true);
    expect(result.attempts).toHaveLength(1);
    const attempt = requireAttempt(result, 0);
    expect(attempt.provider).toBe("openrouter");
    expect(attempt.error).toMatch(/supports at most 1 reference image\(s\), 2 requested/);
  });

  it("skips providers whose live model capabilities disable video inputs", async () => {
    providers = [
      {
        id: "openrouter",
        defaultModel: "minimax/hailuo-2.3",
        capabilities: {
          videoToVideo: {
            enabled: true,
            maxInputVideos: 1,
          },
        },
        resolveModelCapabilities: async () => ({
          videoToVideo: {
            enabled: false,
          },
        }),
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
    ];

    await expect(
      runGenerateVideo({
        cfg: {
          agents: {
            defaults: {
              videoGenerationModel: { primary: "openrouter/minimax/hailuo-2.3" },
            },
          },
        } as OpenClawConfig,
        prompt: "restyle this clip",
        inputVideos: [{ url: "https://example.com/reference.mp4" }],
      }),
    ).rejects.toThrow(/does not support reference video inputs/);
  });

  it("forwards mixed image, video, and audio references when explicitly supported", async () => {
    const seenRequest: {
      inputImages?: unknown;
      inputVideos?: unknown;
      inputAudios?: unknown;
    } = {};
    providers = [
      {
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
      },
    ];

    const result = await runGenerateVideo({
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
    expect(result.attempts).toStrictEqual([]);
    expect(seenRequest).toEqual({
      inputImages: [{ url: "https://example.com/reference.png" }],
      inputVideos: [{ url: "https://example.com/reference.mp4" }],
      inputAudios: [{ url: "https://example.com/reference.mp3" }],
    });
  });

  it("fails when every candidate is skipped for unsupported reference audio inputs", async () => {
    providers = [
      {
        id: "openai",
        capabilities: {},
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
    ];

    await expect(
      runGenerateVideo({
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
    providers = [
      {
        id: "openai",
        defaultModel: "sora-2",
        capabilities: { generate: { maxDurationSeconds: 4 } },
        isConfigured: () => true,
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
      {
        id: "runway",
        defaultModel: "gen4.5",
        capabilities: { generate: { maxDurationSeconds: 8 } },
        isConfigured: () => true,
        async generateVideo(req) {
          seenDurationSeconds = req.durationSeconds;
          return {
            videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
            model: "gen4.5",
          };
        },
      },
    ];

    const result = await runGenerateVideo({
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
    const attempt = requireAttempt(result, 0);
    expect(attempt.provider).toBe("openai");
    expect(attempt.error).toMatch(/supports at most 4s per video, 6s requested/);
  });

  it("fails when every candidate is skipped for exceeding hard duration caps", async () => {
    providers = [
      {
        id: "openai",
        capabilities: {
          generate: {
            maxDurationSeconds: 4,
          },
        },
        async generateVideo() {
          throw new Error("should not be called");
        },
      },
    ];

    await expect(
      runGenerateVideo({
        cfg: {
          agents: { defaults: { videoGenerationModel: { primary: "openai/sora-2" } } },
        } as OpenClawConfig,
        prompt: "animate a cat",
        durationSeconds: 6,
      }),
    ).rejects.toThrow(/supports at most 4s per video, 6s requested/);
  });

  it("rejects provider results that contain undeliverable assets", async () => {
    providers = [
      {
        id: "video-plugin",
        capabilities: {},
        generateVideo: async () => ({
          videos: [{ mimeType: "video/mp4" }],
        }),
      },
    ];

    await expect(
      runGenerateVideo({
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
    const registryProviders: VideoGenerationProvider[] = [
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
    providers = registryProviders;

    expect(
      listRuntimeVideoGenerationProviders({ config: {} as OpenClawConfig }, runtimeDeps),
    ).toEqual(registryProviders);
    expect(listedConfigs).toEqual([{} as OpenClawConfig]);
  });

  it("normalizes requested durations to supported provider values", async () => {
    let seenDurationSeconds: number | undefined;
    providers = [
      {
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
      },
    ];

    const result = await runGenerateVideo({
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
    expect(result.normalization?.durationSeconds?.requested).toBe(5);
    expect(result.normalization?.durationSeconds?.applied).toBe(6);
    expect(result.normalization?.durationSeconds?.supportedValues).toEqual([4, 6, 8]);
    expect(result.metadata?.requestedDurationSeconds).toBe(5);
    expect(result.metadata?.normalizedDurationSeconds).toBe(6);
    expect(result.metadata?.supportedDurationSeconds).toEqual([4, 6, 8]);
    expect(result.ignoredOverrides).toStrictEqual([]);
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
    providers = [
      {
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
      },
    ];

    const result = await runGenerateVideo({
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

  it("normalizes video resolutions against provider-supported values", async () => {
    let seenResolution: string | undefined;
    providers = [
      {
        id: "minimax",
        capabilities: {
          generate: {
            supportsResolution: true,
            resolutions: ["768P", "1080P"],
          },
        },
        generateVideo: async (req) => {
          seenResolution = req.resolution;
          return {
            videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
            model: "MiniMax-Hailuo-2.3",
          };
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "minimax/MiniMax-Hailuo-2.3" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a lobster",
      resolution: "720P",
    });

    expect(seenResolution).toBe("768P");
    expect(result.ignoredOverrides).toStrictEqual([]);
    expect(result.normalization?.resolution?.requested).toBe("720P");
    expect(result.normalization?.resolution?.applied).toBe("768P");
    expect(result.metadata?.requestedResolution).toBe("720P");
    expect(result.metadata?.normalizedResolution).toBe("768P");
  });

  it("ignores unparseable video resolutions instead of sending them to providers", async () => {
    let seenResolution: string | undefined;
    providers = [
      {
        id: "minimax",
        capabilities: {
          generate: {
            supportsResolution: true,
            resolutions: ["768P", "1080P"],
          },
        },
        generateVideo: async (req) => {
          seenResolution = req.resolution;
          return {
            videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
            model: "MiniMax-Hailuo-2.3",
          };
        },
      },
    ];

    const result = await runGenerateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "minimax/MiniMax-Hailuo-2.3" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a lobster",
      resolution: "4K",
    });

    expect(seenResolution).toBeUndefined();
    expect(result.ignoredOverrides).toEqual([{ key: "resolution", value: "4K" }]);
    expect(result.normalization).toBeUndefined();
  });

  it("uses mode-specific capabilities for image-to-video requests", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: string;
        }
      | undefined;
    providers = [
      {
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
      },
    ];

    const result = await runGenerateVideo({
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
    expect(result.ignoredOverrides).toStrictEqual([]);
    expect(result.normalization?.aspectRatio?.applied).toBe("16:9");
    expect(result.normalization?.aspectRatio?.derivedFrom).toBe("size");
    expect(result.metadata?.requestedSize).toBe("1280x720");
    expect(result.metadata?.normalizedAspectRatio).toBe("16:9");
    expect(result.metadata?.aspectRatioDerivedFromSize).toBe("16:9");
  });

  it("builds a generic config hint without hardcoded provider ids", async () => {
    providers = [
      {
        id: "motion-one",
        defaultModel: "animate-v1",
        capabilities: {},
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        }),
      },
    ];
    providerEnvVars = { "motion-one": ["MOTION_ONE_API_KEY"] };

    await expect(
      runGenerateVideo({ cfg: {} as OpenClawConfig, prompt: "animate a cat" }),
    ).rejects.toThrow(
      'No video-generation model configured. Set agents.defaults.videoGenerationModel.primary to a provider/model like "motion-one/animate-v1". If you want a specific provider, also configure that provider\'s auth/API key first (motion-one: MOTION_ONE_API_KEY).',
    );
  });
});
