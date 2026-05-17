import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveImageModelOverridePlan } from "./image-model-override-plan.js";

function buildConfig(params: {
  imageModel?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["imageModel"];
  models?: Record<string, object>;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        ...(params.imageModel ? { imageModel: params.imageModel } : {}),
        ...(params.models ? { models: params.models } : {}),
      },
    },
  } as OpenClawConfig;
}

describe("resolveImageModelOverridePlan", () => {
  it("uses the session model when it already supports images", async () => {
    const modelSupportsImages = vi.fn(async () => true);

    const plan = await resolveImageModelOverridePlan({
      cfg: buildConfig({ imageModel: "openai/gpt-4o" }),
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      hasImageAttachments: true,
      sessionModelSupportsImages: true,
      modelSupportsImages,
    });

    expect(plan).toEqual({ kind: "inline-session" });
    expect(modelSupportsImages).not.toHaveBeenCalled();
  });

  it("keeps configured image models reachable when a model allowlist is present", async () => {
    const plan = await resolveImageModelOverridePlan({
      cfg: buildConfig({
        imageModel: {
          primary: "openai/gpt-4o",
          fallbacks: ["openai/gpt-4o-mini"],
        },
        models: { "anthropic/claude-opus-4-6": {} },
      }),
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      hasImageAttachments: true,
      sessionModelSupportsImages: false,
      modelSupportsImages: async () => true,
    });

    expect(plan).toEqual({
      kind: "inline-image-model",
      modelOverride: "openai/gpt-4o",
      modelOverrideFallbacks: ["openai/gpt-4o-mini"],
    });
  });

  it("resolves providerless image models independently of the active session provider", async () => {
    const modelSupportsImages = vi.fn(async (ref: { provider: string; model: string }) => {
      return ref.provider === "openai" && ref.model === "gpt-4o";
    });

    const plan = await resolveImageModelOverridePlan({
      cfg: buildConfig({ imageModel: "gpt-4o" }),
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      hasImageAttachments: true,
      sessionModelSupportsImages: false,
      modelSupportsImages,
    });

    expect(plan).toEqual({
      kind: "inline-image-model",
      modelOverride: "openai/gpt-4o",
      modelOverrideFallbacks: [],
    });
    expect(modelSupportsImages).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("uses the configured default provider for unmatched providerless image models", async () => {
    const modelSupportsImages = vi.fn(async (ref: { provider: string; model: string }) => {
      return ref.provider === "ollama" && ref.model === "qwen2.5vl:7b";
    });

    const plan = await resolveImageModelOverridePlan({
      cfg: buildConfig({ imageModel: "qwen2.5vl:7b" }),
      defaultProvider: "ollama",
      defaultModel: "llama3.2",
      hasImageAttachments: true,
      sessionModelSupportsImages: false,
      modelSupportsImages,
    });

    expect(plan).toEqual({
      kind: "inline-image-model",
      modelOverride: "ollama/qwen2.5vl:7b",
      modelOverrideFallbacks: [],
    });
  });

  it("selects the first vision-capable image model and carries later image fallbacks", async () => {
    const modelSupportsImages = vi.fn(async (ref: { provider: string; model: string }) => {
      return ref.model !== "gpt-4o-blocked";
    });

    const plan = await resolveImageModelOverridePlan({
      cfg: buildConfig({
        imageModel: {
          primary: "openai/gpt-4o-blocked",
          fallbacks: ["openai/gpt-4o", "google/gemini-2.5-flash"],
        },
        models: {
          "openai/gpt-4o-blocked": {},
          "openai/gpt-4o": {},
          "google/gemini-2.5-flash": {},
        },
      }),
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      hasImageAttachments: true,
      sessionModelSupportsImages: false,
      modelSupportsImages,
    });

    expect(plan).toEqual({
      kind: "inline-image-model",
      modelOverride: "openai/gpt-4o",
      modelOverrideFallbacks: ["google/gemini-2.5-flash"],
    });
  });
});
