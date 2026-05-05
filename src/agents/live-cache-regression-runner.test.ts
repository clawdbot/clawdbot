import { describe, expect, it } from "vitest";
import { __testing } from "./live-cache-regression-runner.js";

describe("live cache regression runner", () => {
  it("keeps OpenAI image cache floors observable without blocking release validation", () => {
    const regressions: string[] = [];
    const warnings: string[] = [];

    __testing.assertAgainstBaseline({
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

    expect(regressions).toEqual([]);
    expect(warnings).toEqual([
      "openai:image cacheRead=0 < min=3840",
      "openai:image hitRate=0.000 < min=0.820",
    ]);
  });

  it("keeps OpenAI text cache floor misses advisory", () => {
    const regressions: string[] = [];
    const warnings: string[] = [];

    __testing.assertAgainstBaseline({
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

    expect(regressions).toEqual([]);
    expect(warnings).toEqual([
      "openai:stable cacheRead=0 < min=4608",
      "openai:stable hitRate=0.000 < min=0.900",
    ]);
  });

  it("retries hard cache baseline misses once", () => {
    expect(
      __testing.shouldRetryBaselineFindings(
        {
          regressions: ["anthropic:image cacheRead=0 < min=4500"],
          warnings: [],
        },
        1,
      ),
    ).toBe(true);
    expect(
      __testing.shouldRetryBaselineFindings(
        {
          regressions: ["anthropic:image cacheRead=0 < min=4500"],
          warnings: [],
        },
        2,
      ),
    ).toBe(false);
    expect(
      __testing.shouldRetryBaselineFindings(
        {
          regressions: [],
          warnings: ["openai:image cacheRead=0 < min=3840"],
        },
        1,
      ),
    ).toBe(false);
  });

  it("retries a cache probe twice when provider text misses the sentinel", () => {
    expect(
      __testing.shouldRetryCacheProbeText({
        attempt: 1,
        suffix: "openai-stable-hit-a",
        text: "",
      }),
    ).toBe(true);
    expect(
      __testing.shouldRetryCacheProbeText({
        attempt: 2,
        suffix: "openai-stable-hit-a",
        text: "",
      }),
    ).toBe(true);
    expect(
      __testing.shouldRetryCacheProbeText({
        attempt: 3,
        suffix: "openai-stable-hit-a",
        text: "",
      }),
    ).toBe(false);
    expect(
      __testing.shouldRetryCacheProbeText({
        attempt: 1,
        suffix: "openai-stable-hit-a",
        text: "I saw openai-stable-hit-a.",
      }),
    ).toBe(true);
    expect(
      __testing.shouldRetryCacheProbeText({
        attempt: 1,
        suffix: "openai-stable-hit-a",
        text: "CACHE-OK openai-stable-hit-a",
      }),
    ).toBe(false);
  });

  it("keeps OpenAI cache probes above the reasoning output floor", () => {
    expect(
      __testing.resolveCacheProbeMaxTokens({
        maxTokens: 32,
        providerTag: "openai",
      }),
    ).toBe(256);
    expect(
      __testing.resolveCacheProbeMaxTokens({
        maxTokens: 512,
        providerTag: "openai",
      }),
    ).toBe(512);
    expect(
      __testing.resolveCacheProbeMaxTokens({
        maxTokens: 32,
        providerTag: "anthropic",
      }),
    ).toBe(32);
  });

  it("accepts empty OpenAI cache probe text only when usage is observable", () => {
    expect(
      __testing.shouldAcceptEmptyOpenAICacheProbe({
        providerTag: "openai",
        text: "",
        usage: { input: 5_000 },
      }),
    ).toBe(true);
    expect(
      __testing.shouldAcceptEmptyOpenAICacheProbe({
        providerTag: "openai",
        text: "",
        usage: { cacheRead: 4_608 },
      }),
    ).toBe(true);
    expect(
      __testing.shouldAcceptEmptyOpenAICacheProbe({
        providerTag: "openai",
        text: "wrong",
        usage: { input: 5_000 },
      }),
    ).toBe(false);
    expect(
      __testing.shouldAcceptEmptyOpenAICacheProbe({
        providerTag: "anthropic",
        text: "",
        usage: { input: 5_000 },
      }),
    ).toBe(false);
    expect(
      __testing.shouldAcceptEmptyOpenAICacheProbe({
        providerTag: "openai",
        text: "",
        usage: {},
      }),
    ).toBe(false);
  });

  it("accepts a warmup that already hits the provider cache", () => {
    const findings = __testing.evaluateAgainstBaseline({
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
    const findings = __testing.evaluateAgainstBaseline({
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
