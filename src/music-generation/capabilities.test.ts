// Tests music generation capability matching and normalization.
import { describe, expect, it } from "vitest";
import {
  listSupportedMusicGenerationModes,
  resolveMusicGenerationModeCapabilities,
} from "./capabilities.js";
import type { MusicGenerationProvider } from "./types.js";

function createProvider(
  capabilities: MusicGenerationProvider["capabilities"],
): MusicGenerationProvider {
  return {
    id: "music-plugin",
    capabilities,
    async generateMusic() {
      throw new Error("not used");
    },
  };
}

describe("music-generation capabilities", () => {
  it("requires explicit edit capabilities before advertising edit mode", () => {
    const provider = createProvider({
      maxInputImages: 2,
    });

    expect(listSupportedMusicGenerationModes(provider)).toEqual(["generate"]);
  });

  it("prefers explicit edit capabilities for reference-image requests", () => {
    const provider = createProvider({
      supportsDuration: true,
      edit: {
        enabled: true,
        maxInputImages: 1,
        supportsDuration: false,
        supportsLyrics: true,
      },
    });

    expect(
      resolveMusicGenerationModeCapabilities({
        provider,
        inputImageCount: 1,
      }),
    ).toEqual({
      mode: "edit",
      capabilities: {
        enabled: true,
        maxInputImages: 1,
        supportsDuration: false,
        supportsLyrics: true,
      },
    });
  });

  it("detects generate vs edit mode from reference images", () => {
    expect(resolveMusicGenerationModeCapabilities({ inputImageCount: 0 })).toEqual({
      mode: "generate",
      capabilities: undefined,
    });
    expect(resolveMusicGenerationModeCapabilities({ inputImageCount: 1 })).toEqual({
      mode: "edit",
      capabilities: undefined,
    });
  });

  it("does not infer edit capabilities from aggregate fields", () => {
    const provider = createProvider({
      maxInputImages: 1,
    });

    expect(
      resolveMusicGenerationModeCapabilities({
        provider,
        inputImageCount: 1,
      }),
    ).toEqual({
      mode: "edit",
      capabilities: undefined,
    });
  });
});
