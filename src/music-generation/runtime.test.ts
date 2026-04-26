import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMediaGenerationRuntimeMocks,
  resetMusicGenerationRuntimeMocks,
} from "../../test/helpers/media-generation/runtime-module-mocks.js";
import type { OpenClawConfig } from "../config/types.js";
import { generateMusic, listRuntimeMusicGenerationProviders } from "./runtime.js";
import type { MusicGenerationProvider } from "./types.js";

const mocks = getMediaGenerationRuntimeMocks();

vi.mock("./model-ref.js", () => ({
  parseMusicGenerationModelRef: mocks.parseMusicGenerationModelRef,
}));

vi.mock("./provider-registry.js", () => ({
  getMusicGenerationProvider: mocks.getMusicGenerationProvider,
  listMusicGenerationProviders: mocks.listMusicGenerationProviders,
}));

describe("music-generation runtime", () => {
  beforeEach(() => {
    resetMusicGenerationRuntimeMocks();
  });

  it("generates tracks through the active music-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    let seenAuthStore: unknown;
    let seenTimeoutMs: number | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("music-plugin/track-v1");
    const provider: MusicGenerationProvider = {
      id: "music-plugin",
      capabilities: {},
      async generateMusic(req: { authStore?: unknown; timeoutMs?: number }) {
        seenAuthStore = req.authStore;
        seenTimeoutMs = req.timeoutMs;
        return {
          tracks: [
            {
              buffer: Buffer.from("mp3-bytes"),
              mimeType: "audio/mpeg",
              fileName: "sample.mp3",
            },
          ],
          model: "track-v1",
        };
      },
    };
    mocks.getMusicGenerationProvider.mockReturnValue(provider);

    const result = await generateMusic({
      cfg: {
        agents: {
          defaults: {
            musicGenerationModel: { primary: "music-plugin/track-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "play a synth line",
      agentDir: "/tmp/agent",
      authStore,
      timeoutMs: 12_345,
    });

    expect(result.provider).toBe("music-plugin");
    expect(result.model).toBe("track-v1");
    expect(result.attempts).toEqual([]);
    expect(result.ignoredOverrides).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(seenTimeoutMs).toBe(12_345);
    expect(result.tracks).toEqual([
      {
        buffer: Buffer.from("mp3-bytes"),
        mimeType: "audio/mpeg",
        fileName: "sample.mp3",
      },
    ]);
  });

  it("auto-detects and falls through to another configured music-generation provider by default", async () => {
    mocks.getMusicGenerationProvider.mockImplementation((providerId: string) => {
      if (providerId === "google") {
        return {
          id: "google",
          defaultModel: "lyria-3-clip-preview",
          capabilities: {},
          isConfigured: () => true,
          async generateMusic() {
            throw new Error("Google music generation response missing audio data");
          },
        };
      }
      if (providerId === "minimax") {
        return {
          id: "minimax",
          defaultModel: "music-2.6",
          capabilities: {},
          isConfigured: () => true,
          async generateMusic() {
            return {
              tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
              model: "music-2.6",
            };
          },
        };
      }
      return undefined;
    });
    mocks.listMusicGenerationProviders.mockReturnValue([
      {
        id: "google",
        defaultModel: "lyria-3-clip-preview",
        capabilities: {},
        isConfigured: () => true,
        generateMusic: async () => ({ tracks: [] }),
      },
      {
        id: "minimax",
        defaultModel: "music-2.6",
        capabilities: {},
        isConfigured: () => true,
        generateMusic: async () => ({ tracks: [] }),
      },
    ]);

    const result = await generateMusic({
      cfg: {} as OpenClawConfig,
      prompt: "play a synth line",
    });

    expect(result.provider).toBe("minimax");
    expect(result.model).toBe("music-2.6");
    expect(result.attempts).toEqual([
      {
        provider: "google",
        model: "lyria-3-clip-preview",
        error: "Google music generation response missing audio data",
      },
    ]);
  });

  it("lists runtime music-generation providers through the provider registry", () => {
    const providers: MusicGenerationProvider[] = [
      {
        id: "music-plugin",
        defaultModel: "track-v1",
        models: ["track-v1"],
        capabilities: {
          generate: {
            supportsDuration: true,
          },
        },
        generateMusic: async () => ({
          tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
        }),
      },
    ];
    mocks.listMusicGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeMusicGenerationProviders({ config: {} as OpenClawConfig })).toEqual(
      providers,
    );
    expect(mocks.listMusicGenerationProviders).toHaveBeenCalledWith({} as OpenClawConfig);
  });

  it("ignores unsupported optional overrides per provider and model", async () => {
    let seenRequest:
      | {
          lyrics?: string;
          instrumental?: boolean;
          durationSeconds?: number;
          format?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("google/lyria-3-clip-preview");
    mocks.getMusicGenerationProvider.mockReturnValue({
      id: "google",
      capabilities: {
        generate: {
          supportsLyrics: true,
          supportsInstrumental: true,
          supportsFormat: true,
          supportedFormatsByModel: {
            "lyria-3-clip-preview": ["mp3"],
          },
        },
      },
      generateMusic: async (req) => {
        seenRequest = {
          lyrics: req.lyrics,
          instrumental: req.instrumental,
          durationSeconds: req.durationSeconds,
          format: req.format,
        };
        return {
          tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
          model: "lyria-3-clip-preview",
        };
      },
    });

    const result = await generateMusic({
      cfg: {
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
          },
        },
      } as OpenClawConfig,
      prompt: "energetic arcade anthem",
      lyrics: "Hero crab in the neon tide",
      instrumental: true,
      durationSeconds: 30,
      format: "wav",
    });

    expect(seenRequest).toEqual({
      lyrics: "Hero crab in the neon tide",
      instrumental: true,
      durationSeconds: undefined,
      format: undefined,
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "durationSeconds", value: 30 },
      { key: "format", value: "wav" },
    ]);
  });

  it("uses mode-specific capabilities for edit requests", async () => {
    let seenRequest:
      | {
          lyrics?: string;
          instrumental?: boolean;
          durationSeconds?: number;
          format?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("google/lyria-3-pro-preview");
    mocks.getMusicGenerationProvider.mockReturnValue({
      id: "google",
      capabilities: {
        generate: {
          supportsLyrics: false,
          supportsInstrumental: false,
          supportsFormat: true,
          supportedFormats: ["mp3"],
        },
        edit: {
          enabled: true,
          maxInputImages: 1,
          supportsLyrics: true,
          supportsInstrumental: true,
          supportsDuration: false,
          supportsFormat: false,
        },
      },
      generateMusic: async (req) => {
        seenRequest = {
          lyrics: req.lyrics,
          instrumental: req.instrumental,
          durationSeconds: req.durationSeconds,
          format: req.format,
        };
        return {
          tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
          model: "lyria-3-pro-preview",
        };
      },
    });

    const result = await generateMusic({
      cfg: {
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-pro-preview" },
          },
        },
      } as OpenClawConfig,
      prompt: "turn this cover image into a trailer cue",
      lyrics: "rise up",
      instrumental: true,
      durationSeconds: 30,
      format: "mp3",
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
    });

    expect(seenRequest).toEqual({
      lyrics: "rise up",
      instrumental: true,
      durationSeconds: undefined,
      format: undefined,
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "durationSeconds", value: 30 },
      { key: "format", value: "mp3" },
    ]);
  });

  it("normalizes requested durations to the closest supported max duration", async () => {
    let seenRequest:
      | {
          durationSeconds?: number;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("minimax/music-2.6");
    mocks.getMusicGenerationProvider.mockReturnValue({
      id: "minimax",
      capabilities: {
        generate: {
          supportsDuration: true,
          maxDurationSeconds: 30,
        },
      },
      generateMusic: async (req) => {
        seenRequest = {
          durationSeconds: req.durationSeconds,
        };
        return {
          tracks: [{ buffer: Buffer.from("mp3-bytes"), mimeType: "audio/mpeg" }],
          model: "music-2.6",
        };
      },
    });

    const result = await generateMusic({
      cfg: {
        agents: {
          defaults: {
            musicGenerationModel: { primary: "minimax/music-2.6" },
          },
        },
      } as OpenClawConfig,
      prompt: "energetic arcade anthem",
      durationSeconds: 45,
    });

    expect(seenRequest).toEqual({
      durationSeconds: 30,
    });
    expect(result.ignoredOverrides).toEqual([]);
    expect(result.normalization).toMatchObject({
      durationSeconds: {
        requested: 45,
        applied: 30,
      },
    });
    expect(result.metadata).toMatchObject({
      requestedDurationSeconds: 45,
      normalizedDurationSeconds: 30,
    });
  });
});
