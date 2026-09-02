import { describe, expect, it } from "vitest";
import { parseDeepInfraPricingCatalog } from "./pricing-api.js";

const pricing = {
  type: "tokens",
  cents_per_input_token: 0.0002,
  cents_per_output_token: 0.001,
  rate_per_input_token_cached: 0.25,
};
const paid = { model_name: "fixture/paid", pricing };
const base = { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 0 };

describe("native DeepInfra pricing contract", () => {
  it("converts cents/token and cache ratios, applying a nullable discount once", () => {
    const result = parseDeepInfraPricingCatalog([
      paid,
      {
        model_name: "fixture/discounted",
        pricing: { ...pricing, discount: 0.5, discount_ends_at: null },
      },
      { model_name: "fixture/free", pricing: { ...pricing, discount: 1 } },
      {
        model_name: "fixture/nullable",
        pricing: {
          ...pricing,
          discount: null,
          full: null,
          table: null,
          rate_per_input_token_cached: null,
          rate_per_input_token_cache_write: null,
        },
      },
      { model_name: "fixture/unknown" },
      { model_name: "fixture/image", pricing: { type: "image_units", cents_per_image_unit: 3 } },
    ]);
    expect(result).toEqual(
      new Map([
        ["fixture/paid", base],
        ["fixture/discounted", { input: 1, output: 5, cacheRead: 0.25, cacheWrite: 0 }],
        ["fixture/free", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
        ["fixture/nullable", { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 }],
      ]),
    );
    expect(
      parseDeepInfraPricingCatalog([
        {
          model_name: "fixture/zero",
          pricing: {
            ...pricing,
            cents_per_input_token: 0,
            cents_per_output_token: 0,
          },
        },
      ])?.get("fixture/zero"),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("does not graft service tiers or explicit retention onto standard token costs", () => {
    expect(
      parseDeepInfraPricingCatalog([
        {
          ...paid,
          pricing: {
            ...pricing,
            full: "",
            table: {},
            rate_per_service_tier_priority: 1.5,
            rate_per_service_tier_flex: 0.8,
            rate_per_explicit_cache_write_token: { "5m": 1.25, "1h": 2 },
            explicit_cache_granularity_tokens: 8192,
          },
        },
      ])?.get(paid.model_name),
    ).toEqual(base);
  });

  it.each([
    { full: "Different rates above a context threshold" },
    { full: "Promotion ends on a calendar date" },
    { table: { columns: ["context"], rows: [[1000]] } },
    { discount_ends_at: 1 },
    { discount_ends_at: 9_000_000_000 },
    { rate_per_input_token_cache_write: 1.25 },
  ])("validates then omits unsupported schedules: %j", (qualification) => {
    const qualified = {
      model_name: "fixture/qualified",
      pricing: { ...pricing, ...qualification },
    };
    expect(parseDeepInfraPricingCatalog([paid, qualified])).toEqual(
      new Map([[paid.model_name, base]]),
    );
    expect(parseDeepInfraPricingCatalog([qualified])).toBeUndefined();
    expect(
      parseDeepInfraPricingCatalog([
        paid,
        {
          ...qualified,
          pricing: {
            ...qualified.pricing,
            cents_per_output_token: "bad",
          },
        },
      ]),
    ).toBeUndefined();
  });

  it.each([
    { type: 5 },
    { cents_per_input_token: -1 },
    { cents_per_output_token: undefined },
    { cents_per_input_token: "0.0002" },
    { cents_per_output_token: Infinity },
    { cents_per_input_token: 1e308 },
    { discount: "0.5" },
    { discount: -0.1 },
    { discount: 1.1 },
    { discount_ends_at: "123" },
    { discount_ends_at: 1.5 },
    { full: {} },
    { table: [] },
    { rate_per_input_token_cached: "0.25" },
    { rate_per_input_token_cached: -1 },
    { rate_per_input_token_cache_write: "1.25" },
    { rate_per_service_tier_priority: -1 },
    { rate_per_service_tier_flex: "0.8" },
    { rate_per_explicit_cache_write_token: [] },
    { rate_per_explicit_cache_write_token: { "5m": "1.25" } },
    { explicit_cache_granularity_tokens: 0 },
  ])("rejects malformed declared token pricing without retaining partial rates: %j", (invalid) => {
    expect(
      parseDeepInfraPricingCatalog([
        paid,
        {
          model_name: "fixture/bad",
          pricing: {
            ...pricing,
            ...invalid,
          },
        },
      ]),
    ).toBeUndefined();
  });

  it.each(
    [
      { data: [paid] },
      [],
      [null],
      [{ id: "fixture/foreign-identity", pricing }],
      [paid, { model_name: " " }],
      [paid, { model_name: paid.model_name }],
      [paid, { ...paid, pricing: { ...pricing, full: "Qualified" } }],
      [paid, { model_name: "fixture/bad", pricing: null }],
      [{ model_name: "fixture/unpriced" }],
      [{ model_name: "fixture/image", pricing: { type: "image_units" } }],
    ].map((payload) => ({ payload })),
  )("rejects malformed, duplicate or unusable feeds: $payload", ({ payload }) => {
    expect(parseDeepInfraPricingCatalog(payload)).toBeUndefined();
  });
});
