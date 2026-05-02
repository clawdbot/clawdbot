import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  deriveAspectRatioFromSize,
  normalizeDurationToClosestMax,
  resolveCapabilityModelCandidates,
  resolveClosestAspectRatio,
  resolveClosestResolution,
  resolveClosestSize,
  throwCapabilityGenerationFailure,
} from "./runtime-shared.js";

function parseModelRef(raw?: string) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return null;
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

describe("media-generation runtime shared candidates", () => {
  it("appends auth-backed provider defaults after explicit refs by default", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    const candidates = resolveCapabilityModelCandidates({
      cfg,
      modelConfig: {
        primary: "google/gemini-3.1-flash-image-preview",
        fallbacks: ["fal/fal-ai/flux/dev"],
      },
      parseModelRef,
      listProviders: () => [
        {
          id: "google",
          defaultModel: "gemini-3.1-flash-image-preview",
          isConfigured: () => true,
        },
        {
          id: "openai",
          defaultModel: "gpt-image-1",
          isConfigured: () => true,
        },
        {
          id: "minimax",
          defaultModel: "image-01",
          isConfigured: () => true,
        },
      ],
    });

    expect(candidates).toEqual([
      { provider: "google", model: "gemini-3.1-flash-image-preview" },
      { provider: "fal", model: "fal-ai/flux/dev" },
      { provider: "openai", model: "gpt-image-1" },
      { provider: "minimax", model: "image-01" },
    ]);
  });

  it("auto-detects auth-backed provider defaults when no explicit media model is configured", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {} as OpenClawConfig,
      modelConfig: undefined,
      parseModelRef,
      listProviders: () => [
        {
          id: "openai",
          defaultModel: "gpt-image-1",
          isConfigured: () => true,
        },
        {
          id: "fal",
          defaultModel: "fal-ai/flux/dev",
          isConfigured: () => true,
        },
      ],
    });

    expect(candidates).toEqual([
      { provider: "openai", model: "gpt-image-1" },
      { provider: "fal", model: "fal-ai/flux/dev" },
    ]);
  });

  it("orders auto-detected provider defaults by canonical aliases", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.5",
            },
          },
        },
      } as OpenClawConfig,
      modelConfig: undefined,
      parseModelRef,
      listProviders: () => [
        {
          id: "fal",
          defaultModel: "fal-ai/flux/dev",
          isConfigured: () => true,
        },
        {
          id: "openai",
          aliases: ["openai-codex"],
          defaultModel: "gpt-image-2",
          isConfigured: () => true,
        },
      ],
    });

    expect(candidates).toEqual([
      { provider: "openai", model: "gpt-image-2" },
      { provider: "fal", model: "fal-ai/flux/dev" },
    ]);
  });

  it("disables implicit provider expansion when mediaGenerationAutoProviderFallback=false", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {
        agents: {
          defaults: {
            mediaGenerationAutoProviderFallback: false,
          },
        },
      } as OpenClawConfig,
      modelConfig: {
        primary: "google/gemini-3.1-flash-image-preview",
      },
      parseModelRef,
      listProviders: () => [
        {
          id: "openai",
          defaultModel: "gpt-image-1",
          isConfigured: () => true,
        },
      ],
    });

    expect(candidates).toEqual([{ provider: "google", model: "gemini-3.1-flash-image-preview" }]);
  });

  it("treats an explicit model override as exact-only", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {
        agents: {
          defaults: {
            mediaGenerationAutoProviderFallback: false,
          },
        },
      } as OpenClawConfig,
      modelConfig: {
        primary: "google/gemini-3.1-flash-image-preview",
        fallbacks: ["fal/fal-ai/flux/dev"],
      },
      modelOverride: "openai/gpt-image-2",
      parseModelRef,
      listProviders: () => [
        {
          id: "google",
          defaultModel: "gemini-3.1-flash-image-preview",
          isConfigured: () => true,
        },
      ],
    });

    expect(candidates).toEqual([{ provider: "openai", model: "gpt-image-2" }]);
  });
});

describe("media-generation runtime shared normalization", () => {
  it("derives reduced aspect ratios from size strings", () => {
    expect(deriveAspectRatioFromSize("1280x720")).toBe("16:9");
    expect(deriveAspectRatioFromSize("1024x1536")).toBe("2:3");
  });

  it("maps unsupported sizes to the closest supported size", () => {
    expect(
      resolveClosestSize({
        requestedSize: "1792x1024",
        supportedSizes: ["1024x1024", "1024x1536", "1536x1024"],
      }),
    ).toBe("1536x1024");
  });

  it("maps unsupported aspect ratios to the closest supported aspect ratio", () => {
    expect(
      resolveClosestAspectRatio({
        requestedAspectRatio: "17:10",
        supportedAspectRatios: ["1:1", "4:3", "16:9"],
      }),
    ).toBe("16:9");
  });

  it("maps unsupported resolutions to the closest supported resolution", () => {
    expect(
      resolveClosestResolution({
        requestedResolution: "2K",
        supportedResolutions: ["1K", "4K"],
      }),
    ).toBe("1K");
  });

  it("clamps durations to the closest supported max", () => {
    expect(normalizeDurationToClosestMax(12, 8)).toBe(8);
    expect(normalizeDurationToClosestMax(6, 8)).toBe(6);
  });
});

describe("media-generation runtime shared failure summaries", () => {
  it("collapses abort cascades behind the non-abort failure", () => {
    expect(() =>
      throwCapabilityGenerationFailure({
        capabilityLabel: "music generation",
        attempts: [
          {
            provider: "google",
            model: "lyria-3-clip-preview",
            error: "Manually set deadline 1s is too short. Minimum allowed deadline is 10s.",
          },
          {
            provider: "minimax",
            model: "music-2.6",
            error: "This operation was aborted",
          },
          {
            provider: "minimax-portal",
            model: "music-2.6",
            error: "This operation was aborted",
          },
        ],
        lastError: new Error("This operation was aborted"),
      }),
    ).toThrow(
      "All music generation models failed (3): google/lyria-3-clip-preview: Manually set deadline 1s is too short. Minimum allowed deadline is 10s. | 2 fallback(s) aborted after the request was cancelled or timed out: minimax/music-2.6, minimax-portal/music-2.6",
    );
  });

  it("summarizes all-aborted attempts once", () => {
    expect(() =>
      throwCapabilityGenerationFailure({
        capabilityLabel: "music generation",
        attempts: [
          {
            provider: "minimax",
            model: "music-2.6",
            error: "This operation was aborted",
          },
          {
            provider: "minimax-portal",
            model: "music-2.6",
            error: "This operation was aborted",
          },
        ],
        lastError: new Error("This operation was aborted"),
      }),
    ).toThrow(
      "All music generation models failed (2): 2 fallback(s) aborted after the request was cancelled or timed out: minimax/music-2.6, minimax-portal/music-2.6",
    );
  });
});
