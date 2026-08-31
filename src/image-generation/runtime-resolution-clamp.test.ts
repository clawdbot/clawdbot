/** Regression tests for model-specific image-generation resolution clamping. */
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { generateImage, type GenerateImageParams } from "./runtime.js";
import type { ImageGenerationProvider } from "./types.js";

type ImageGenerationRuntimeDeps = NonNullable<Parameters<typeof generateImage>[1]>;

let providers: ImageGenerationProvider[] = [];

const runtimeDeps: ImageGenerationRuntimeDeps = {
  getProvider: (providerId) => providers.find((provider) => provider.id === providerId),
  listProviders: () => providers,
  getProviderEnvVars: () => [],
  log: { warn: () => {} },
};

function runGenerateImage(params: GenerateImageParams) {
  const defaults = params.cfg.agents?.defaults as
    | (NonNullable<OpenClawConfig["agents"]>["defaults"] & {
        imageGenerationModel?: unknown;
      })
    | undefined;
  const cfg =
    defaults?.imageGenerationModel !== undefined && defaults.mediaModels?.image === undefined
      ? {
          ...params.cfg,
          agents: {
            ...params.cfg.agents,
            defaults: {
              ...defaults,
              mediaModels: { ...defaults.mediaModels, image: defaults.imageGenerationModel },
            },
          },
        }
      : params.cfg;
  return generateImage({ ...params, cfg }, runtimeDeps);
}

describe("image-generation runtime resolution clamping", () => {
  beforeEach(() => {
    providers = [];
  });

  it("clamps unsupported resolutions to the model-specific 1K limit for Google Lite", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: "1K" | "2K" | "4K";
        }
      | undefined;
    providers = [
      {
        id: "google",
        capabilities: {
          generate: {
            supportsSize: true,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          edit: {
            enabled: true,
            supportsSize: true,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          // Mirrors the bundled Google provider contract: Lite is a fixed 1K
          // tier, so resolutionsByModel clamps 2K/4K down to 1K instead of
          // forwarding an unsupported imageSize to Google's generateContent API.
          geometry: {
            sizes: ["1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024"],
            aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
            resolutions: ["1K", "2K", "4K"],
            resolutionsByModel: {
              "gemini-3.1-flash-lite-image": ["1K"],
            },
          },
        },
        async generateImage(req) {
          seenRequest = {
            size: req.size,
            aspectRatio: req.aspectRatio,
            resolution: req.resolution,
          };
          return {
            images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
          };
        },
      },
    ];

    const result = await runGenerateImage({
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "google/gemini-3.1-flash-lite-image" },
          },
        },
      } as OpenClawConfig,
      prompt: "draw a cat",
      resolution: "4K",
    });

    expect(seenRequest?.resolution).toBe("1K");
    expect(result.normalization?.resolution).toEqual({ requested: "4K", applied: "1K" });
  });
});
