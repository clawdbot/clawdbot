import { calculateUsageCost } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  normalizeModelPricingCatalog,
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

describe("native pricing catalogs", () => {
  const paid = { id: "paid", pricing: { input: 2, output: 10 } };

  it("keeps declared free prices distinct from missing prices", () => {
    expect(
      normalizeModelPricingCatalog(
        [paid, { id: "unknown" }, { id: "free", pricing: { input: 0, output: 0 } }],
        normalizeUpstreamModelPricing,
      ),
    ).toEqual(
      new Map([
        ["paid", BASE_COST],
        ["free", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
      ]),
    );
  });

  it.each([
    { label: "non-array", rows: {} },
    { label: "empty", rows: [] },
    { label: "entirely unpriced", rows: [{ id: "unknown" }] },
    { label: "invalid identity", rows: [paid, { id: " " }] },
    { label: "malformed row", rows: [paid, null] },
    { label: "malformed declared price", rows: [paid, { id: "bad", pricing: null }] },
    { label: "duplicate priced identity", rows: [paid, paid] },
    { label: "duplicate unpriced identity", rows: [paid, { id: "paid" }] },
  ])("rejects $label rather than publishing a partial native feed", ({ rows }) => {
    expect(normalizeModelPricingCatalog(rows, normalizeUpstreamModelPricing)).toBeUndefined();
  });
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
  const base = {
    prompt: "0.000002",
    completion: "0.00001",
    input_cache_read: "0.00000025",
    input_cache_write: "0.0000025",
  };
  const cost = { input: 2, output: 10, cacheRead: 0.25, cacheWrite: 2.5 };

  it("compiles unordered overrides in source order per key without borrowing foreign prices", () => {
    const pricing = {
      ...base,
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
    expect(normalizeOpenRouterModelPricing(pricing)).toEqual({
      ...cost,
      tieredPricing: [
        { ...cost, range: [0, 272_001] },
        {
          input: 4,
          output: 15,
          cacheRead: expect.closeTo(0.4, 12),
          cacheWrite: 5,
          range: [272_001, 500_001],
        },
        {
          input: 4,
          output: 15,
          cacheRead: expect.closeTo(0.4, 12),
          cacheWrite: 5,
          range: [500_001],
        },
      ],
    });
  });

  it.each([
    { prices: { prompt: "0.000004" }, expected: { input: 4 } },
    { prices: { completion: "0.00002" }, expected: { output: 20 } },
    { prices: { input_cache_read: "0.0000005" }, expected: { cacheRead: 0.5 } },
    { prices: { input_cache_write: "0.000005" }, expected: { cacheWrite: 5 } },
    { prices: { prompt: "0", input_cache_read: "0" }, expected: { input: 0, cacheRead: 0 } },
  ])("inherits omitted native rates for partial overrides: $prices", ({ prices, expected }) => {
    expect(
      normalizeOpenRouterModelPricing({
        ...base,
        overrides: [{ min_prompt_tokens: 100, ...prices }],
      }),
    ).toEqual({
      ...cost,
      tieredPricing: [
        { ...cost, range: [0, 101] },
        { ...cost, ...expected, range: [101] },
      ],
    });
  });

  it("lets equal and lower thresholds override only their supplied keys in source order", () => {
    expect(
      normalizeOpenRouterModelPricing({
        ...base,
        overrides: [
          { min_prompt_tokens: 500, prompt: "0.000006", completion: "0.00002" },
          { min_prompt_tokens: 200, prompt: "0.000004", input_cache_read: "0.0000005" },
          { min_prompt_tokens: 200, input_cache_write: "0" },
        ],
      }),
    ).toEqual({
      ...cost,
      tieredPricing: [
        { ...cost, range: [0, 201] },
        { input: 4, output: 10, cacheRead: 0.5, cacheWrite: 0, range: [201, 501] },
        { input: 4, output: 20, cacheRead: 0.5, cacheWrite: 0, range: [501] },
      ],
    });
  });

  it.each([
    { input: 39, output: 7, cacheRead: 30, cacheWrite: 30, expected: 0.0002305 },
    { input: 40, output: 7, cacheRead: 30, cacheWrite: 30, expected: 0.0002325 },
    { input: 41, output: 7, cacheRead: 30, cacheWrite: 30, expected: 0.0003865 },
    { input: 0, output: 7, cacheRead: 101, cacheWrite: 0, expected: 0.00016525 },
    { input: 0, output: 7, cacheRead: 0, cacheWrite: 101, expected: 0.0003925 },
    { input: 0, output: 1_000, cacheRead: 0, cacheWrite: 0, expected: 0.01 },
  ])(
    "bills strict total-prompt boundaries with inherited cache prices: %j",
    ({ expected, ...usage }) => {
      const pricing = normalizeOpenRouterModelPricing({
        ...base,
        overrides: [{ min_prompt_tokens: 100, prompt: "0.000004", completion: "0.00002" }],
      });
      expect(pricing).toBeDefined();
      if (!pricing) {
        throw new Error("Expected a complete native schedule");
      }
      expect(calculateUsageCost(usage, pricing).total).toBeCloseTo(expected, 12);
    },
  );

  it.each([0, 100.5, Number.MAX_SAFE_INTEGER - 1])(
    "compiles a strict threshold %j to the first matching integral prompt size",
    (threshold) => {
      const start = Math.floor(threshold) + 1;
      expect(
        normalizeOpenRouterModelPricing({
          ...base,
          overrides: [{ min_prompt_tokens: threshold, prompt: "0" }],
        }),
      ).toEqual({
        ...cost,
        tieredPricing: [
          { ...cost, range: [0, start] },
          { ...cost, input: 0, range: [start] },
        ],
      });
    },
  );

  it.each([
    { future_condition: true },
    { future_price: "0" },
    { utc_start: 1630 },
    { utc_end: 30 },
    { utc_days: ["monday"] },
    ...[undefined, null, -1, "100", Infinity, Number.NaN, Number.MAX_SAFE_INTEGER].map(
      (min_prompt_tokens) => ({ min_prompt_tokens }),
    ),
  ])("skips unsupported or invalid predicates: %j", (condition) => {
    expect(
      normalizeOpenRouterModelPricing({
        ...base,
        overrides: [{ min_prompt_tokens: 100, prompt: "0", ...condition }],
      }),
    ).toEqual(cost);
  });

  it("ignores known non-token charge dimensions without dropping token overrides", () => {
    expect(
      normalizeOpenRouterModelPricing({
        ...base,
        overrides: [
          {
            min_prompt_tokens: 100,
            prompt: "0.000004",
            request: "1",
            image: "1",
            web_search: "1",
            internal_reasoning: "1",
            audio: "1",
            input_audio_cache: "1",
            input_cache_write_1h: "1",
            image_output: "1",
            audio_output: "1",
          },
        ],
      }),
    ).toEqual({
      ...cost,
      tieredPricing: [
        { ...cost, range: [0, 101] },
        { ...cost, input: 4, range: [101] },
      ],
    });
  });

  it.each([null, "", "1usd", -1, Infinity, "1e308"])(
    "invalidates the schedule for malformed effective prices %j",
    (invalid) => {
      for (const field of Object.keys(base)) {
        expect(
          normalizeOpenRouterModelPricing({
            ...base,
            overrides: [{ min_prompt_tokens: 100, [field]: invalid }],
          }),
        ).toBeUndefined();
      }
    },
  );

  it("validates effective prices after later matching entries replace malformed fields", () => {
    expect(
      normalizeOpenRouterModelPricing({
        ...base,
        overrides: [
          { min_prompt_tokens: 100, prompt: "bad" },
          { min_prompt_tokens: 100, prompt: "0" },
        ],
      }),
    ).toEqual({
      ...cost,
      tieredPricing: [
        { ...cost, range: [0, 101] },
        { ...cost, input: 0, range: [101] },
      ],
    });
  });

  it("rejects per-million overflow and foreign base prices", () => {
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
