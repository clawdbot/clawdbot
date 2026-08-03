// Media Generation Core tests cover catalog behavior.
import { describe, expect, it } from "vitest";
import {
  listMediaGenerationProviderModels,
  synthesizeMediaGenerationCatalogEntries,
} from "./catalog.js";

describe("media-generation catalog", () => {
  it("synthesizes stable static rows from provider defaults and models", () => {
    const capabilities = {
      generate: { enabled: true },
      edit: { enabled: true, maxInputImages: 2 },
    };

    const rows = synthesizeMediaGenerationCatalogEntries({
      kind: "image_generation",
      provider: {
        id: "example",
        label: "Example",
        defaultModel: "default-image",
        models: ["default-image", "alternate-image", "  ", "alternate-image"],
        capabilities,
      },
      modes: ["generate", "edit"],
    });

    expect(rows).toEqual([
      {
        kind: "image_generation",
        provider: "example",
        model: "default-image",
        label: "Example",
        source: "static",
        default: true,
        capabilities,
        modes: ["generate", "edit"],
      },
      {
        kind: "image_generation",
        provider: "example",
        model: "alternate-image",
        label: "Example",
        source: "static",
        capabilities,
        modes: ["generate", "edit"],
      },
    ]);
  });

  it("lists unique provider models in display order", () => {
    expect(
      listMediaGenerationProviderModels({
        defaultModel: "video-default",
        models: ["video-default", "video-pro"],
      }),
    ).toEqual(["video-default", "video-pro"]);
  });

  it("uses per-model capabilities and modes when provided", () => {
    type VideoCapabilities = {
      generate?: { maxVideos: number };
      imageToVideo?: { enabled: boolean; maxInputImages: number };
    };
    const providerCapabilities: VideoCapabilities = {
      generate: { maxVideos: 1 },
    };
    const alternateCapabilities: VideoCapabilities = {
      imageToVideo: { enabled: true, maxInputImages: 1 },
    };

    const rows = synthesizeMediaGenerationCatalogEntries({
      kind: "video_generation",
      provider: {
        id: "example",
        defaultModel: "default-video",
        models: ["default-video", "image-video"],
        capabilities: providerCapabilities,
        catalogByModel: {
          "image-video": {
            capabilities: alternateCapabilities,
            modes: ["imageToVideo"],
          },
        },
      },
      modes: ["generate"],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        model: "default-video",
        capabilities: providerCapabilities,
        modes: ["generate"],
      }),
      expect.objectContaining({
        model: "image-video",
        capabilities: alternateCapabilities,
        modes: ["imageToVideo"],
      }),
    ]);
  });

  it("marks a trimmed default model as the catalog default", () => {
    expect(
      synthesizeMediaGenerationCatalogEntries({
        kind: "video_generation",
        provider: {
          id: "example",
          defaultModel: " video-default ",
          models: ["video-default"],
          capabilities: {},
        },
      }),
    ).toEqual([
      {
        kind: "video_generation",
        provider: "example",
        model: "video-default",
        source: "static",
        default: true,
        capabilities: {},
      },
    ]);
  });
});
