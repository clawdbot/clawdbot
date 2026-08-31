import { describe, expect, it } from "vitest";
import {
  normalizeModelPricingProvider,
  normalizeOpenRouterModelPricing,
  normalizeUpstreamModelPricing,
} from "./model-catalog-pricing.js";

const BASE_COST = { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 };

describe("model pricing source policy", () => {
  it("normalizes all source mappings without losing explicit opt-outs", () => {
    expect(
      normalizeModelPricingProvider({
        external: false,
        openCode: { provider: " OpenCode ", modelIdTransforms: ["version-dots", "unknown", null] },
        venice: { provider: " Venice " },
        openRouter: { passthroughProviderModel: true },
        liteLLM: false,
      }),
    ).toEqual({
      external: false,
      openCode: { provider: "opencode", modelIdTransforms: ["version-dots"] },
      venice: { provider: "venice" },
      openRouter: { passthroughProviderModel: true },
      liteLLM: false,
    });
  });

  it.each([
    { value: undefined },
    { value: null },
    { value: [] },
    { value: {} },
    {
      value: {
        openCode: {},
        openRouter: { provider: " " },
        liteLLM: { modelIdTransforms: ["unknown"] },
      },
    },
  ])("ignores empty or unrecognized policy $value", ({ value }) =>
    expect(normalizeModelPricingProvider(value)).toBeUndefined(),
  );
});

describe.each([
  {
    source: "OpenRouter",
    normalize: normalizeOpenRouterModelPricing,
    base: { prompt: "0.000002", completion: "0.00001" },
    input: "prompt",
    output: "completion",
    cache: "input_cache_read",
  },
  {
    source: "upstream",
    normalize: normalizeUpstreamModelPricing,
    base: { input: 2, output: 10 },
    input: "input",
    output: "output",
    cache: "cache_read",
  },
])("$source pricing integrity", ({ normalize, base, input, output, cache }) => {
  it("returns complete per-million rates with absent cache charges defaulted to zero", () => {
    expect(normalize(base)).toEqual(BASE_COST);
    expect(normalize({ [input]: 0, [output]: 0 })).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it.each([undefined, null, "", " ", "1usd", -1, Infinity, Number.NaN, true])(
    "rejects invalid required or declared cache rates %j instead of inventing free prices",
    (invalid) => {
      for (const field of [input, output, cache]) {
        if (field === cache && invalid === undefined) {
          continue;
        }
        expect(normalize({ ...base, [field]: invalid })).toBeUndefined();
      }
    },
  );
});

describe("OpenRouter native pricing", () => {
  it("sorts static prompt tiers and ignores scheduled overrides without borrowing foreign prices", () => {
    const pricing = {
      prompt: "0.000002",
      completion: "0.00001",
      input_cache_read: "0.0000002",
      input_cache_write: "0.0000025",
      // Other feed formats must not supply native OpenRouter rates or tiers.
      input: 99,
      context_over_200k: { input: 99, output: 99 },
      overrides: [
        { min_prompt_tokens: 500_000, prompt: "0.000006", completion: "0.00002" },
        { utc_days: [0], utc_start: "00:00", utc_end: "12:00", prompt: "0", completion: "0" },
        { min_prompt_tokens: 100_000, utc_start: "00:00", prompt: "0", completion: "0" },
        {
          min_prompt_tokens: 272_000,
          prompt: "0.000004",
          completion: "0.000015",
          input_cache_read: "0.0000004",
          input_cache_write: "0.000005",
        },
      ],
    };
    const cost = { input: 2, output: 10, cacheRead: expect.closeTo(0.2, 12), cacheWrite: 2.5 };
    expect(normalizeOpenRouterModelPricing(pricing)).toEqual({
      ...cost,
      tieredPricing: [
        { ...cost, range: [0, 272_000] },
        {
          input: 4,
          output: 15,
          cacheRead: expect.closeTo(0.4, 12),
          cacheWrite: 5,
          range: [272_000, 500_000],
        },
        { input: 6, output: 20, cacheRead: 0, cacheWrite: 0, range: [500_000] },
      ],
    });
  });

  it("rejects an incomplete native context override and per-million overflow", () => {
    expect(
      normalizeOpenRouterModelPricing({
        prompt: "0.000002",
        completion: "0.00001",
        overrides: [{ min_prompt_tokens: 272_000, prompt: "0.000004" }],
      }),
    ).toBeUndefined();
    expect(normalizeOpenRouterModelPricing({ prompt: "1e308", completion: "0" })).toBeUndefined();
    expect(normalizeOpenRouterModelPricing({ input: 2, output: 10 })).toBeUndefined();
  });
});

describe("upstream pricing tiers", () => {
  it("sorts positive safe-integer context thresholds and ignores other tier dimensions", () => {
    expect(
      normalizeUpstreamModelPricing({
        input: 2,
        output: 10,
        tiers: [
          { tier: { type: "context", size: 500_000 }, input: 6, output: 20 },
          { tier: { type: "context", size: 272_000 }, input: 4, output: 15 },
          ...[0, -1, 1.5, "100000", Number.MAX_SAFE_INTEGER + 1].map((size) => ({
            tier: { type: "context", size },
          })),
          { tier: { type: "time", size: 100_000 } },
        ],
      }),
    ).toEqual({
      ...BASE_COST,
      tieredPricing: [
        { ...BASE_COST, range: [0, 272_000] },
        { input: 4, output: 15, cacheRead: 0, cacheWrite: 0, range: [272_000, 500_000] },
        { input: 6, output: 20, cacheRead: 0, cacheWrite: 0, range: [500_000] },
      ],
    });
  });

  it.each([
    {
      tiers: [{ tier: { type: "context", size: 200_000 }, input: 4 }],
      context_over_200k: { input: 4, output: 15 },
    },
    { context_over_200k: { input: 4 } },
    {
      tiers: [
        { tier: { type: "context", size: 272_000 }, input: 4, output: 15 },
        { tier: { type: "context", size: 272_000 }, input: 8, output: 30 },
      ],
    },
  ])(
    "rejects incomplete or conflicting context tiers rather than selecting lower prices: %j",
    (tiers) => {
      expect(normalizeUpstreamModelPricing({ input: 2, output: 10, ...tiers })).toBeUndefined();
    },
  );
});
