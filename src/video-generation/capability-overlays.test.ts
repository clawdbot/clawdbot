// Video capability overlay tests cover config-driven capability overrides.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  buildReferenceInputCapabilityFailure,
  resolveProviderWithModelCapabilities,
} from "./capability-overlays.js";
import type { VideoGenerationProvider, VideoGenerationProviderCapabilities } from "./types.js";

async function resolveCapabilitiesWithOverlay(
  base: VideoGenerationProviderCapabilities,
  overlay: VideoGenerationProviderCapabilities,
): Promise<VideoGenerationProviderCapabilities> {
  const provider: VideoGenerationProvider = {
    id: "video-plugin",
    capabilities: base,
    resolveModelCapabilities: async () => overlay,
    async generateVideo() {
      throw new Error("should not be called");
    },
  };
  const resolved = await resolveProviderWithModelCapabilities({
    provider,
    providerId: "video-plugin",
    model: "model",
    cfg: {} as OpenClawConfig,
    log: { debug: vi.fn() },
  });
  return resolved.capabilities;
}

describe("video-generation capability overlays", () => {
  it("lets explicit false and zero values narrow base capabilities", async () => {
    const merged = await resolveCapabilitiesWithOverlay(
      {
        providerOptions: { seed: "number" },
        generate: {
          supportsAudio: true,
          supportsWatermark: true,
        },
        imageToVideo: {
          enabled: true,
          maxInputImages: 4,
          supportsAudio: true,
        },
      },
      {
        generate: {
          supportsAudio: false,
        },
        imageToVideo: {
          enabled: false,
          maxInputImages: 0,
          supportsAudio: false,
        },
      },
    );

    expect(merged.generate).toEqual({
      supportsAudio: false,
      supportsWatermark: true,
    });
    expect(merged.imageToVideo).toEqual({
      enabled: false,
      maxInputImages: 0,
      supportsAudio: false,
    });
  });

  it("keeps base values when overlay leaves fields undefined", async () => {
    const merged = await resolveCapabilitiesWithOverlay(
      {
        providerOptions: { seed: "number" },
        generate: {
          supportsAudio: true,
          supportsWatermark: true,
        },
        imageToVideo: {
          enabled: true,
          maxInputImages: 4,
        },
      },
      {
        providerOptions: { draft: "boolean" },
        generate: {},
      },
    );

    expect(merged.providerOptions).toEqual({ seed: "number", draft: "boolean" });
    expect(merged.generate).toEqual({
      supportsAudio: true,
      supportsWatermark: true,
    });
    expect(merged.imageToVideo).toEqual({
      enabled: true,
      maxInputImages: 4,
    });
  });

  it("lets explicit empty providerOptions overlays clear inherited declarations", async () => {
    const merged = await resolveCapabilitiesWithOverlay(
      {
        providerOptions: { seed: "number" },
        generate: {
          providerOptions: { seed: "number" },
        },
        imageToVideo: {
          enabled: true,
          maxInputImages: 4,
          providerOptions: { seed: "number" },
        },
      },
      {
        providerOptions: {},
        generate: {
          providerOptions: {},
        },
        imageToVideo: {
          enabled: true,
          providerOptions: {},
        },
      },
    );

    expect(merged.providerOptions).toEqual({});
    expect(merged.generate?.providerOptions).toEqual({});
    expect(merged.imageToVideo?.providerOptions).toEqual({});
  });

  it("checks reference inputs against overlaid provider capabilities", async () => {
    const provider: VideoGenerationProvider = {
      id: "openrouter",
      capabilities: {
        imageToVideo: {
          enabled: true,
          maxInputImages: 4,
        },
      },
      resolveModelCapabilities: async () => ({
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
        },
      }),
      async generateVideo() {
        throw new Error("should not be called");
      },
    };

    const activeProvider = await resolveProviderWithModelCapabilities({
      provider,
      providerId: "openrouter",
      model: "minimax/hailuo-2.3",
      cfg: {} as OpenClawConfig,
      log: { debug: vi.fn() },
    });

    expect(
      buildReferenceInputCapabilityFailure({
        providerId: "openrouter",
        model: "minimax/hailuo-2.3",
        provider: activeProvider,
        inputImageCount: 2,
        inputVideoCount: 0,
        inputAudioCount: 0,
      }),
    ).toMatch(/supports at most 1 reference image\(s\), 2 requested/);
  });
});
