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
});
