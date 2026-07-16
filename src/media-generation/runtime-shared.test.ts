// Covers shared media-generation runtime polling and timeout helpers.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  normalizeDurationToClosestMax,
  resolveCapabilityModelCandidates,
  resolveClosestAspectRatio,
  resolveClosestResolution,
  resolveClosestSize,
  resolveMediaProviderRequestTimeoutMs,
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
              primary: "openai/gpt-5.5",
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
          aliases: ["openai"],
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
    let listProviderCalls = 0;
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
      listProviders: () => {
        listProviderCalls += 1;
        return [
          {
            id: "openai",
            defaultModel: "gpt-image-1",
            isConfigured: () => true,
          },
        ];
      },
    });

    expect(candidates).toEqual([{ provider: "google", model: "gemini-3.1-flash-image-preview" }]);
    expect(listProviderCalls).toBe(0);
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

  it("resolves slash-containing provider model IDs from registered provider models", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {} as OpenClawConfig,
      modelConfig: {
        primary: "openai/gpt-image-2",
      },
      modelOverride: "fal-ai/flux/dev",
      parseModelRef,
      listProviders: () => [
        {
          id: "fal",
          defaultModel: "fal-ai/flux/dev",
          models: ["fal-ai/flux/dev", "fal-ai/flux/dev/image-to-image"],
          isConfigured: () => true,
        },
      ],
    });

    expect(candidates).toEqual([{ provider: "fal", model: "fal-ai/flux/dev" }]);
  });

  it("prefers explicit provider refs over colliding slash-containing model IDs", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {} as OpenClawConfig,
      modelConfig: {
        primary: "google/lyria-3-pro-preview",
      },
      parseModelRef,
      listProviders: () => [
        {
          id: "google",
          defaultModel: "lyria-3-clip-preview",
          models: ["lyria-3-clip-preview", "lyria-3-pro-preview"],
          isConfigured: () => true,
        },
        {
          id: "openrouter",
          defaultModel: "google/lyria-3-clip-preview",
          models: ["google/lyria-3-clip-preview", "google/lyria-3-pro-preview"],
          isConfigured: () => true,
        },
      ],
    });

    expect(candidates[0]).toEqual({ provider: "google", model: "lyria-3-pro-preview" });
  });
});

describe("media-generation runtime shared normalization", () => {
  it("caps media provider timeouts to the timer-safe range", () => {
    expect(
      resolveMediaProviderRequestTimeoutMs({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        providerDefaultTimeoutMs: 30_000,
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveMediaProviderRequestTimeoutMs({
        timeoutMs: 0,
        providerDefaultTimeoutMs: 45_000,
      }),
    ).toBe(45_000);
  });

  it("rejects unsafe size dimensions before deriving ratios", () => {
    expect(
      resolveClosestSize({
        requestedSize: "9007199254740993x3",
        supportedSizes: ["1024x1024", "1536x1024"],
      }),
    ).toBeUndefined();
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

  it("maps video-style resolutions by numeric distance", () => {
    expect(
      resolveClosestResolution({
        requestedResolution: "480P",
        supportedResolutions: ["360P", "540P", "720P"],
        order: ["360P", "480P", "540P", "720P"],
      }),
    ).toBe("540P");
  });

  it("does not map across image and video resolution units", () => {
    expect(
      resolveClosestResolution({
        requestedResolution: "4K",
        supportedResolutions: ["768P", "1080P"],
        order: ["360P", "480P", "540P", "720P", "768P", "1080P"],
      }),
    ).toBeUndefined();
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
