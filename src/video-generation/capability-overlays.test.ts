import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  buildReferenceInputCapabilityFailure,
  mergeVideoGenerationProviderCapabilities,
  resolveProviderWithModelCapabilities,
} from "./capability-overlays.js";
import type { VideoGenerationProvider } from "./types.js";

describe("video-generation capability overlays", () => {
  it("lets explicit false and zero values narrow base capabilities", () => {
    const merged = mergeVideoGenerationProviderCapabilities(
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

  it("keeps base values when overlay leaves fields undefined", () => {
    const merged = mergeVideoGenerationProviderCapabilities(
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
