// Verifies live cache regression baseline classification without live providers.
import { describe, expect, it } from "vitest";
import {
  assertAgainstBaseline,
  evaluateAgainstBaseline,
  isAnthropicToolProbeDrift,
  resolveCacheProbeMaxTokens,
  resolveLiveCacheProviderPool,
  shouldAcceptEmptyCacheProbe,
  shouldRetryBaselineFindings,
  shouldRetryCacheProbeText,
} from "./live-cache-regression-policy.js";
import {
  LiveCachePrerequisiteSkip,
  toLiveCachePrerequisiteSkip,
} from "./live-cache-test-support.js";
import { ProviderAuthError } from "./model-auth-runtime-shared.js";

describe("live cache regression runner", () => {
  it("keeps OpenAI image cache floors observable without blocking release validation", () => {
    // OpenAI cache metrics are provider-dependent and advisory here: keep the
    // warning visible while avoiding a hard release gate.
    const regressions: string[] = [];
    const warnings: string[] = [];

    assertAgainstBaseline({
      lane: "image",
      provider: "openai",
      result: {
        best: {
          hitRate: 0,
          suffix: "image-hit",
          text: "CACHE-OK image-hit",
          usage: { cacheRead: 0, cacheWrite: 0, input: 5_096 },
        },
      },
      regressions,
      warnings,
    });

    expect(regressions).toStrictEqual([]);
    expect(warnings).toEqual([
      "openai:image cacheRead=0 < min=3840",
      "openai:image hitRate=0.000 < min=0.820",
    ]);
  });

  it("keeps OpenAI text cache floor misses advisory", () => {
    const regressions: string[] = [];
    const warnings: string[] = [];

    assertAgainstBaseline({
      lane: "stable",
      provider: "openai",
      result: {
        best: {
          hitRate: 0,
          suffix: "stable-hit",
          text: "CACHE-OK stable-hit",
          usage: { cacheRead: 0, cacheWrite: 0, input: 5_034 },
        },
      },
      regressions,
      warnings,
    });

    expect(regressions).toStrictEqual([]);
    expect(warnings).toEqual([
      "openai:stable cacheRead=0 < min=4608",
      "openai:stable hitRate=0.000 < min=0.900",
    ]);
  });

  it("retries hard cache baseline misses once", () => {
    // Hard regressions get one rerun to absorb provider cache warmup jitter;
    // advisory warnings should not trigger reruns.
    expect(
      shouldRetryBaselineFindings(
        {
          regressions: ["anthropic:image cacheRead=0 < min=4500"],
          warnings: [],
        },
        1,
      ),
    ).toBe(true);
    expect(
      shouldRetryBaselineFindings(
        {
          regressions: ["anthropic:image cacheRead=0 < min=4500"],
          warnings: [],
        },
        2,
      ),
    ).toBe(false);
    expect(
      shouldRetryBaselineFindings(
        {
          regressions: [],
          warnings: ["openai:image cacheRead=0 < min=3840"],
        },
        1,
      ),
    ).toBe(false);
  });

  it("keeps missing optional live-cache prerequisites non-blocking", async () => {
    const regressions: string[] = [];
    const warnings: string[] = [];
    const summary: Record<string, Record<string, unknown>> = {
      anthropic: {},
      openai: {},
    };

    const resolved = await resolveLiveCacheProviderPool({
      config: {
        provider: "openai",
        api: "openai-responses",
        envVar: "OPENCLAW_LIVE_OPENAI_CACHE_MODEL",
        preferredModelIds: ["gpt-5.5"],
      },
      resolver: async () => {
        throw new LiveCachePrerequisiteSkip(
          "openai",
          "No openai openai-responses model available in registry.",
        );
      },
      regressions,
      summary,
      warnings,
    });

    expect(resolved).toBeUndefined();
    expect(regressions).toStrictEqual([]);
    expect(warnings).toEqual([
      "openai skipped: No openai openai-responses model available in registry.",
    ]);
    expect(summary.openai).toEqual({ skipped: true });
  });

  it("keeps missing Anthropic live-cache prerequisites blocking", async () => {
    // Anthropic is the hard baseline provider, so missing prerequisites are
    // treated as validation failures rather than advisory skips.
    const regressions: string[] = [];
    const warnings: string[] = [];
    const summary: Record<string, Record<string, unknown>> = {
      anthropic: {},
      openai: {},
    };

    const resolved = await resolveLiveCacheProviderPool({
      config: {
        provider: "anthropic",
        api: "anthropic-messages",
        envVar: "OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL",
        preferredModelIds: ["claude-sonnet-4-6"],
      },
      resolver: async () => {
        throw new LiveCachePrerequisiteSkip(
          "anthropic",
          "No anthropic anthropic-messages model available in registry.",
        );
      },
      regressions,
      summary,
      warnings,
    });

    expect(resolved).toBeUndefined();
    expect(regressions).toEqual([
      "anthropic skipped: No anthropic anthropic-messages model available in registry.",
    ]);
    expect(warnings).toStrictEqual([]);
    expect(summary.anthropic).toEqual({ skipped: true });
  });

  it("classifies missing provider auth as a live-cache prerequisite", () => {
    const skip = toLiveCachePrerequisiteSkip(
      "openai",
      new ProviderAuthError("missing-provider-auth", "openai", "No API key found."),
    );

    expect(skip).toBeInstanceOf(LiveCachePrerequisiteSkip);
    expect(skip?.provider).toBe("openai");
    expect(skip?.message).toBe("No API key found.");
  });

  it("retries a cache probe twice when provider text misses the sentinel", () => {
    expect(
      shouldRetryCacheProbeText({
        attempt: 1,
        suffix: "openai-stable-hit-a",
        text: "",
      }),
    ).toBe(true);
    expect(
      shouldRetryCacheProbeText({
        attempt: 2,
        suffix: "openai-stable-hit-a",
        text: "",
      }),
    ).toBe(true);
    expect(
      shouldRetryCacheProbeText({
        attempt: 3,
        suffix: "openai-stable-hit-a",
        text: "",
      }),
    ).toBe(false);
    expect(
      shouldRetryCacheProbeText({
        attempt: 1,
        suffix: "openai-stable-hit-a",
        text: "I saw openai-stable-hit-a.",
      }),
    ).toBe(true);
    expect(
      shouldRetryCacheProbeText({
        attempt: 1,
        suffix: "openai-stable-hit-a",
        text: "CACHE-OK openai-stable-hit-a",
      }),
    ).toBe(false);
  });

  it("keeps cache probes above the provider empty-output floor", () => {
    expect(
      resolveCacheProbeMaxTokens({
        maxTokens: 32,
        providerTag: "openai",
      }),
    ).toBe(1024);
    expect(
      resolveCacheProbeMaxTokens({
        maxTokens: 512,
        providerTag: "openai",
      }),
    ).toBe(1024);
    expect(
      resolveCacheProbeMaxTokens({
        maxTokens: 2048,
        providerTag: "openai",
      }),
    ).toBe(2048);
    expect(
      resolveCacheProbeMaxTokens({
        maxTokens: 32,
        providerTag: "anthropic",
      }),
    ).toBe(1024);
  });

  it("classifies Anthropic tool-only probe misses as provider drift", () => {
    expect(isAnthropicToolProbeDrift(new Error("expected tool call for noop"))).toBe(true);
    expect(
      isAnthropicToolProbeDrift(new Error('expected tool-only response for noop, got "ok"')),
    ).toBe(true);
    expect(isAnthropicToolProbeDrift(new Error("other failure"))).toBe(false);
  });

  it("accepts empty cache probe text only when usage is observable", () => {
    expect(
      shouldAcceptEmptyCacheProbe({
        providerTag: "openai",
        text: "",
        usage: { input: 5_000 },
      }),
    ).toBe(true);
    expect(
      shouldAcceptEmptyCacheProbe({
        providerTag: "openai",
        text: "",
        usage: { cacheRead: 4_608 },
      }),
    ).toBe(true);
    expect(
      shouldAcceptEmptyCacheProbe({
        providerTag: "openai",
        text: "wrong",
        usage: { input: 5_000 },
      }),
    ).toBe(false);
    expect(
      shouldAcceptEmptyCacheProbe({
        providerTag: "anthropic",
        text: "",
        usage: { input: 5_000 },
      }),
    ).toBe(true);
    expect(
      shouldAcceptEmptyCacheProbe({
        providerTag: "openai",
        text: "",
        usage: {},
      }),
    ).toBe(false);
  });

  it("accepts a warmup that already hits the provider cache", () => {
    const findings = evaluateAgainstBaseline({
      lane: "image",
      provider: "anthropic",
      result: {
        best: {
          hitRate: 0.999,
          suffix: "image-hit",
          text: "CACHE-OK image-hit",
          usage: { cacheRead: 5_742, cacheWrite: 0, input: 3 },
        },
        warmup: {
          hitRate: 0.999,
          suffix: "image-warmup",
          text: "CACHE-OK image-warmup",
          usage: { cacheRead: 5_741, cacheWrite: 0, input: 3 },
        },
      },
    });

    expect(findings).toEqual({ regressions: [], warnings: [] });
  });

  it("still rejects warmups with no cache write or cache hit evidence", () => {
    // A successful best probe is not enough: warmup must prove either cache
    // write or read evidence so the measured hit is meaningful.
    const findings = evaluateAgainstBaseline({
      lane: "image",
      provider: "anthropic",
      result: {
        best: {
          hitRate: 0.999,
          suffix: "image-hit",
          text: "CACHE-OK image-hit",
          usage: { cacheRead: 5_742, cacheWrite: 0, input: 3 },
        },
        warmup: {
          hitRate: 0,
          suffix: "image-warmup",
          text: "CACHE-OK image-warmup",
          usage: { cacheRead: 0, cacheWrite: 0, input: 5_741 },
        },
      },
    });

    expect(findings).toEqual({
      regressions: ["anthropic:image warmup cacheWrite=0 < min=1"],
      warnings: [],
    });
  });
});
