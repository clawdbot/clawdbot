import { describe, expect, it } from "vitest";
import {
  listSupportedVideoGenerationModes,
  resolveVideoGenerationMode,
  resolveVideoGenerationModeCapabilities,
} from "./capabilities.js";
import type { VideoGenerationProvider } from "./types.js";

function createProvider(
  capabilities: VideoGenerationProvider["capabilities"],
): VideoGenerationProvider {
  return {
    id: "video-plugin",
    capabilities,
    async generateVideo() {
      throw new Error("not used");
    },
  };
}

describe("video-generation capabilities", () => {
  it("requires explicit transform capabilities before advertising transform modes", () => {
    const provider = createProvider({
      maxInputImages: 1,
      maxInputVideos: 2,
    });

    expect(listSupportedVideoGenerationModes(provider)).toEqual(["generate"]);
  });

  it("prefers explicit mode capabilities for image-to-video requests", () => {
    const provider = createProvider({
      supportsSize: true,
      imageToVideo: {
        enabled: true,
        maxInputImages: 1,
        supportsSize: false,
        supportsAspectRatio: true,
      },
    });

    expect(
      resolveVideoGenerationModeCapabilities({
        provider,
        inputImageCount: 1,
        inputVideoCount: 0,
      }),
    ).toEqual({
      mode: "imageToVideo",
      capabilities: {
        enabled: true,
        maxInputImages: 1,
        supportsSize: false,
        supportsAspectRatio: true,
      },
    });
  });

  it("does not infer transform capabilities for mixed reference requests", () => {
    const provider = createProvider({
      maxInputImages: 1,
      maxInputVideos: 4,
      supportsAudio: true,
    });

    expect(resolveVideoGenerationMode({ inputImageCount: 1, inputVideoCount: 1 })).toBeNull();
    expect(
      resolveVideoGenerationModeCapabilities({
        provider,
        inputImageCount: 1,
        inputVideoCount: 1,
      }),
    ).toEqual({
      mode: null,
      capabilities: undefined,
    });
  });

  it("uses explicit video-to-video capabilities for mixed reference requests", () => {
    const provider = createProvider({
      imageToVideo: {
        enabled: true,
        maxInputImages: 2,
      },
      videoToVideo: {
        enabled: true,
        maxInputImages: 2,
        maxInputVideos: 3,
        maxInputAudios: 1,
      },
    });

    expect(resolveVideoGenerationMode({ inputImageCount: 1, inputVideoCount: 1 })).toBeNull();
    expect(
      resolveVideoGenerationModeCapabilities({
        provider,
        inputImageCount: 1,
        inputVideoCount: 1,
      }),
    ).toEqual({
      mode: null,
      capabilities: {
        enabled: true,
        maxInputImages: 2,
        maxInputVideos: 3,
        maxInputAudios: 1,
      },
    });
  });

  it("applies model-specific reference input limits", () => {
    const provider = createProvider({
      imageToVideo: {
        enabled: true,
        maxInputImages: 1,
        maxInputImagesByModel: {
          "vendor/reference-to-video": 9,
        },
      },
      videoToVideo: {
        enabled: true,
        maxInputImages: 0,
        maxInputImagesByModel: {
          "vendor/reference-to-video": 9,
        },
        maxInputVideos: 0,
        maxInputVideosByModel: {
          "vendor/reference-to-video": 3,
        },
      },
    });

    expect(
      resolveVideoGenerationModeCapabilities({
        provider,
        model: "vendor/text-to-video",
        inputImageCount: 2,
      }).capabilities?.maxInputImages,
    ).toBe(1);
    expect(
      resolveVideoGenerationModeCapabilities({
        provider,
        model: "vendor/reference-to-video",
        inputImageCount: 2,
      }).capabilities?.maxInputImages,
    ).toBe(9);
    expect(
      resolveVideoGenerationModeCapabilities({
        provider,
        model: "vendor/reference-to-video",
        inputImageCount: 1,
        inputVideoCount: 1,
      }).capabilities,
    ).toMatchObject({
      maxInputImages: 9,
      maxInputVideos: 3,
    });
  });
});
