// Usage format tests cover display formatting for token and cost usage.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearGatewayModelPricingFailures,
  replaceGatewayModelPricingCache,
  type CachedModelPricing,
} from "../gateway/model-pricing-cache-state.js";
import * as manifestModelIdNormalization from "../plugins/manifest-model-id-normalization.js";
import { captureEnv } from "../test-utils/env.js";
import {
  resetUsageFormatCachesForTest,
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "./usage-format.js";

type ModelCostConfig = NonNullable<ReturnType<typeof resolveModelCostConfig>>;
type PricingTier = NonNullable<ModelCostConfig["tieredPricing"]>[number];

function setGatewayModelPricing(
  entries: Array<{
    provider: string;
    model: string;
    pricing: CachedModelPricing;
  }>,
): void {
  replaceGatewayModelPricingCache(
    new Map(entries.map((entry) => [`${entry.provider}/${entry.model}`, entry.pricing])),
  );
}

function clearGatewayModelPricingState(): void {
  replaceGatewayModelPricingCache(new Map(), 0);
  clearGatewayModelPricingFailures();
}

function requireCostConfig(
  cost: ReturnType<typeof resolveModelCostConfig>,
  label: string,
): ModelCostConfig {
  if (!cost) {
    throw new Error(`expected ${label} cost config`);
  }
  return cost;
}

function requireTieredPricing(
  cost: ModelCostConfig,
  label: string,
): NonNullable<ModelCostConfig["tieredPricing"]> {
  if (!cost.tieredPricing) {
    throw new Error(`expected ${label} tiered pricing`);
  }
  return cost.tieredPricing;
}

describe("usage-format", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let agentDir: string;
  let stateDir: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_AGENT_DIR", "OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-format-"));
    agentDir = path.join(stateDir, "agents", "main", "agent");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_AGENT_DIR;
    await fs.mkdir(agentDir, { recursive: true });
    resetUsageFormatCachesForTest();
    clearGatewayModelPricingState();
  });

  afterEach(async () => {
    envSnapshot?.restore();
    envSnapshot = undefined;
    resetUsageFormatCachesForTest();
    clearGatewayModelPricingState();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("formats token counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(12000)).toBe("12k");
    expect(formatTokenCount(999_499)).toBe("999k");
    expect(formatTokenCount(999_500)).toBe("1.0m");
    expect(formatTokenCount(2_500_000)).toBe("2.5m");
  });

  it("formats token counts at exact boundaries", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(10000)).toBe("10k");
    expect(formatTokenCount(50000)).toBe("50k");
    expect(formatTokenCount(1_000_000)).toBe("1.0m");
    expect(formatTokenCount(1_500_000)).toBe("1.5m");
    expect(formatTokenCount(10_000_000)).toBe("10.0m");
  });

  it("returns 0 for invalid and non-positive token counts", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(-100)).toBe("0");
    expect(formatTokenCount(undefined)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatTokenCount(Number.NEGATIVE_INFINITY)).toBe("0");
  });

  it("rounds thousands overflow to millions at the boundary", () => {
    // 999,999 / 1000 = 999.999 → toFixed(1) = "1000.0" → crosses to millions
    expect(formatTokenCount(999_999)).toBe("1.0m");
    expect(formatTokenCount(9_999)).toBe("10.0k");
  });

  it("formats USD values", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });

  it("resolves model cost config and estimates usage cost", () => {
    const config = {
      models: {
        providers: {
          test: {
            models: [
              {
                id: "m1",
                cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const cost = resolveModelCostConfig({
      provider: "test",
      model: "m1",
      config,
    });

    expect(cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0,
    });

    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });

    expect(total).toBeCloseTo(0.003);
  });

  it("returns undefined when model pricing is not configured", () => {
    expect(
      resolveModelCostConfig({
        provider: "demo-unconfigured-a",
        model: "demo-model-a",
      }),
    ).toBeUndefined();

    expect(
      resolveModelCostConfig({
        provider: "demo-unconfigured-b",
        model: "demo-model-b",
      }),
    ).toBeUndefined();
  });

  it("prefers models.json pricing over openclaw config and cached pricing", async () => {
    const config = {
      models: {
        providers: {
          "demo-preferred": {
            models: [
              {
                id: "demo-model",
                cost: { input: 20, output: 21, cacheRead: 22, cacheWrite: 23 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            "demo-preferred": {
              models: [
                {
                  id: "demo-model",
                  cost: { input: 10, output: 11, cacheRead: 12, cacheWrite: 13 },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    setGatewayModelPricing([
      {
        provider: "demo-preferred",
        model: "demo-model",
        pricing: { input: 30, output: 31, cacheRead: 32, cacheWrite: 33 },
      },
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-preferred",
        model: "demo-model",
        config,
      }),
    ).toEqual({
      input: 10,
      output: 11,
      cacheRead: 12,
      cacheWrite: 13,
    });
  });

  it("falls back to openclaw config pricing when models.json is absent", () => {
    const config = {
      models: {
        providers: {
          "demo-config-provider": {
            models: [
              {
                id: "demo-model",
                cost: { input: 9, output: 19, cacheRead: 0.9, cacheWrite: 1.9 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    setGatewayModelPricing([
      {
        provider: "demo-config-provider",
        model: "demo-model",
        pricing: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0.4 },
      },
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-config-provider",
        model: "demo-model",
        config,
      }),
    ).toEqual({
      input: 9,
      output: 19,
      cacheRead: 0.9,
      cacheWrite: 1.9,
    });
  });

  it("falls back to cached gateway pricing when no configured cost exists", () => {
    setGatewayModelPricing([
      {
        provider: "demo-cached-provider",
        model: "demo-model",
        pricing: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      },
    ]);

    expect(
      resolveModelCostConfig({
        provider: "demo-cached-provider",
        model: "demo-model",
      }),
    ).toEqual({
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0,
    });
  });

  it("can skip plugin-backed model normalization for display-only cost lookup", () => {
    const config = {
      models: {
        providers: {
          "google-vertex": {
            models: [
              {
                id: "gemini-3.1-flash-lite",
                cost: { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 0.8 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "google-vertex",
        model: "gemini-3.1-flash-lite",
        config,
        allowPluginNormalization: false,
      }),
    ).toEqual({
      input: 7,
      output: 8,
      cacheRead: 0.7,
      cacheWrite: 0.8,
    });
  });

  it("skips manifest model normalization for raw cost lookup", () => {
    const manifestSpy = vi.spyOn(
      manifestModelIdNormalization,
      "normalizeProviderModelIdWithManifest",
    );
    const config = {
      models: {
        providers: {
          "demo-raw": {
            models: [
              {
                id: "demo-model",
                cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "demo-raw",
        model: "demo-model",
        config,
        allowPluginNormalization: false,
      }),
    ).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    });
    expect(manifestSpy).not.toHaveBeenCalled();
  });

  it("observes in-place config pricing changes after a cached lookup", () => {
    const model = {
      id: "demo-model",
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    };
    const config = {
      models: {
        providers: {
          "demo-mutated": {
            models: [model],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "demo-mutated",
        model: "demo-model",
        config,
      })?.input,
    ).toBe(1);

    model.cost.input = 9;

    expect(
      resolveModelCostConfig({
        provider: "demo-mutated",
        model: "demo-model",
        config,
      })?.input,
    ).toBe(9);
  });

  it("observes structural config pricing changes after a cached lookup", () => {
    const models = [
      {
        id: "demo-model",
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
    ];
    const config = {
      models: {
        providers: {
          "demo-structural": { models },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "demo-structural",
        model: "demo-model",
        config,
      })?.input,
    ).toBe(1);

    models.push({
      id: "new-model",
      cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
    });
    expect(
      resolveModelCostConfig({
        provider: "demo-structural",
        model: "new-model",
        config,
      })?.input,
    ).toBe(5);

    models.splice(0, 1);
    expect(
      resolveModelCostConfig({
        provider: "demo-structural",
        model: "demo-model",
        config,
      }),
    ).toBeUndefined();
  });

  it("observes replaced config cost objects after a cached lookup", () => {
    const model = {
      id: "demo-model",
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    };
    const config = {
      models: {
        providers: {
          "demo-replaced-cost": { models: [model] },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "demo-replaced-cost",
        model: "demo-model",
        config,
      })?.input,
    ).toBe(1);

    model.cost = { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 };

    expect(
      resolveModelCostConfig({
        provider: "demo-replaced-cost",
        model: "demo-model",
        config,
      })?.input,
    ).toBe(9);
  });

  it("ignores malformed raw tier ranges while caching config pricing", () => {
    const config = {
      models: {
        providers: {
          "demo-bad-tier": {
            models: [
              {
                id: "demo-model",
                cost: {
                  input: 1,
                  output: 2,
                  cacheRead: 3,
                  cacheWrite: 4,
                  tieredPricing: [
                    { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, range: undefined },
                  ],
                },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "demo-bad-tier",
        model: "demo-model",
        config,
      }),
    ).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    });
  });

  it("skips metadata-only model rows while caching configured pricing", async () => {
    const metadataOnlyModel = { id: "metadata-only" } as {
      id: string;
      cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    };
    const config = {
      models: {
        providers: {
          "demo-metadata-row": {
            models: [
              metadataOnlyModel,
              {
                id: "priced-model",
                cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "demo-metadata-row",
        model: "metadata-only",
        config,
      }),
    ).toBeUndefined();
    expect(
      resolveModelCostConfig({
        provider: "demo-metadata-row",
        model: "priced-model",
        config,
      })?.input,
    ).toBe(1);

    metadataOnlyModel.cost = { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 };
    expect(
      resolveModelCostConfig({
        provider: "demo-metadata-row",
        model: "metadata-only",
        config,
      })?.input,
    ).toBe(9);

    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "demo-metadata-json": {
            models: [
              { id: "metadata-only" },
              {
                id: "priced-model",
                cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
              },
            ],
          },
        },
      }),
      "utf8",
    );

    expect(
      resolveModelCostConfig({
        provider: "demo-metadata-json",
        model: "priced-model",
      })?.input,
    ).toBe(5);
  });

  it("updates pricing fingerprints when metadata-only model rows gain pricing", () => {
    const metadataOnlyModel = { id: "metadata-only" } as {
      id: string;
      cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    };
    const config = {
      models: {
        providers: {
          "demo-metadata-fingerprint": {
            models: [metadataOnlyModel],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const before = resolveModelCostConfigFingerprint(config);
    metadataOnlyModel.cost = { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 };
    const after = resolveModelCostConfigFingerprint(config);

    expect(after).not.toBe(before);
    expect(
      resolveModelCostConfig({
        provider: "demo-metadata-fingerprint",
        model: "metadata-only",
        config,
      })?.input,
    ).toBe(9);
  });

  it("retries models.json after an initial missing read", async () => {
    expect(
      resolveModelCostConfig({
        provider: "demo-late",
        model: "demo-model",
      }),
    ).toBeUndefined();

    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "demo-late": {
            models: [
              {
                id: "demo-model",
                cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
              },
            ],
          },
        },
      }),
      "utf8",
    );

    expect(
      resolveModelCostConfig({
        provider: "demo-late",
        model: "demo-model",
      })?.input,
    ).toBe(1);
  });

  it("does not poll models.json stats after the process-local cost index is loaded", async () => {
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "demo-stat": {
            models: [
              {
                id: "demo-model",
                cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
              },
            ],
          },
        },
      }),
      "utf8",
    );

    expect(
      resolveModelCostConfig({
        provider: "demo-stat",
        model: "demo-model",
      })?.input,
    ).toBe(1);

    const statSpy = vi.spyOn(nodeFs, "statSync");
    try {
      for (let i = 0; i < 20; i += 1) {
        expect(
          resolveModelCostConfig({
            provider: "demo-stat",
            model: "demo-model",
          })?.input,
        ).toBe(1);
      }
      expect(statSpy).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
    }
  });

  // -----------------------------------------------------------------------
  // Tiered pricing tests
  // -----------------------------------------------------------------------

  it("uses flat pricing when tieredPricing is absent", () => {
    const cost = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 };
    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });
    expect(total).toBeCloseTo(0.003);
  });

  it("estimates cost with single-tier tiered pricing (equivalent to flat)", () => {
    const tiers: PricingTier[] = [
      { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0, range: [0, 1_000_000] },
    ];
    const cost = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0, tieredPricing: tiers };
    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });
    // Same as flat: (1000*1 + 500*2 + 2000*0.5) / 1M = 3000/1M = 0.003
    expect(total).toBeCloseTo(0.003);
  });

  it("uses the matching context tier instead of blending lower tiers", () => {
    // Tier 1: [0, 32000) → input $0.30/M, output $1.50/M
    // Tier 2: [32000, 128000) → input $0.50/M, output $2.50/M
    const tiers: PricingTier[] = [
      { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0, range: [32_000, 128_000] },
    ];
    const cost = { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    // 40000 input tokens selects Tier 2 for the whole request:
    // (40000 * 0.5 + 10000 * 2.5) / 1M = 0.045
    const total = estimateUsageCost({
      usage: { input: 40_000, output: 10_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.045, 4);
  });

  it("estimates cost with three tiers — volcengine-style pricing", () => {
    // Simulates volcengine/doubao pricing (per-million):
    // Tier 1: [0, 32000) → in $0.46, out $2.30
    // Tier 2: [32000, 128000) → in $0.70, out $3.50
    // Tier 3: [128000, 256000) → in $1.40, out $7.00
    const tiers: PricingTier[] = [
      { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.7, output: 3.5, cacheRead: 0, cacheWrite: 0, range: [32_000, 128_000] },
      { input: 1.4, output: 7, cacheRead: 0, cacheWrite: 0, range: [128_000, 256_000] },
    ];
    const cost = { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    // 200000 input tokens selects Tier 3 for the whole request:
    // (200000 * 1.40 + 5000 * 7.00) / 1M = 0.315
    const total = estimateUsageCost({
      usage: { input: 200_000, output: 5_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.315, 4);
  });

  it("uses first tier rates for output when input is zero", () => {
    const tiers: PricingTier[] = [
      { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0, range: [32_000, 128_000] },
    ];
    const cost = { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    const total = estimateUsageCost({
      usage: { input: 0, output: 10_000 },
      cost,
    });
    // Falls back to first tier: 10000 * 1.5 / 1M = 0.015
    expect(total).toBeCloseTo(0.015, 6);
  });

  it("falls back to flat pricing when tieredPricing is empty array", () => {
    const cost = {
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0,
      tieredPricing: [] as PricingTier[],
    };
    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });
    expect(total).toBeCloseTo(0.003);
  });

  it("bills overflow input tokens at last tier rate when input exceeds max range", () => {
    // Tiers only cover up to 128000, but input is 200000
    // Tier 1: [0, 32000) → in $0.30/M, out $1.50/M
    // Tier 2: [32000, 128000) → in $0.50/M, out $2.50/M
    // Overflow: 72000 tokens billed at Tier 2 rates
    const tiers: PricingTier[] = [
      { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0, range: [32_000, 128_000] },
    ];
    const cost = { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    // 200000 input tokens exceeds the max range, so the last tier is the
    // whole-request fallback: (200000 * 0.5 + 10000 * 2.5) / 1M = 0.125
    const total = estimateUsageCost({
      usage: { input: 200_000, output: 10_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.125, 4);
  });

  it("bills overflow at last tier when only a single small-range tier exists (e.g. <30K)", () => {
    // Only one tier covering [0, 30000), input is 100000
    const tiers: PricingTier[] = [
      { input: 1, output: 3, cacheRead: 0.5, cacheWrite: 0, range: [0, 30_000] },
    ];
    const cost = { input: 1, output: 3, cacheRead: 0.5, cacheWrite: 0, tieredPricing: tiers };

    // 100000 input exceeds the only range, so Tier 1 is the whole-request fallback.
    // Total = 0.1 + 0.015 + 0.001 = 0.116
    const total = estimateUsageCost({
      usage: { input: 100_000, output: 5_000, cacheRead: 2_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.116, 4);
  });

  it("supports open-ended range [start] in tiered pricing (greater-than syntax)", () => {
    // Tier 1: [0, 32000) → in $0.30/M, out $1.50/M
    // Tier 2: [32000, Infinity) → in $0.50/M, out $2.50/M  (open-ended)
    const tiers: PricingTier[] = [
      { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, range: [0, 32_000] },
      { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0, range: [32_000, Infinity] },
    ];
    const cost = { input: 0.3, output: 1.5, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    // 200000 input tokens selects the open-ended Tier 2 for the whole request.
    const total = estimateUsageCost({
      usage: { input: 200_000, output: 10_000 },
      cost,
    });
    expect(total).toBeCloseTo(0.125, 4);
  });

  it("uses declared tier ranges instead of sequential widths", () => {
    const tiers: PricingTier[] = [
      { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, range: [100, 200] },
      { input: 2, output: 20, cacheRead: 0, cacheWrite: 0, range: [0, 100] },
    ];
    const cost = { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    const total = estimateUsageCost({
      usage: { input: 150, output: 60 },
      cost,
    });

    expect(total).toBeCloseTo(0.00075, 8);
  });

  it("reuses sorted tier order for repeated estimates", () => {
    const tiers: PricingTier[] = [
      { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, range: [100, 200] },
      { input: 2, output: 20, cacheRead: 0, cacheWrite: 0, range: [0, 100] },
    ];
    const tierSortSpy = vi.spyOn(tiers, "toSorted");
    const cost = { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    expect(estimateUsageCost({ usage: { input: 150, output: 60 }, cost })).toBeCloseTo(0.00075, 8);
    expect(estimateUsageCost({ usage: { input: 50, output: 60 }, cost })).toBeCloseTo(0.0013, 8);
    expect(tierSortSpy).toHaveBeenCalledTimes(1);
  });

  it("bills malformed tier gaps at a whole-request fallback tier", () => {
    const tiers: PricingTier[] = [
      { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, range: [0, 50] },
      { input: 3, output: 30, cacheRead: 0, cacheWrite: 0, range: [100, 150] },
    ];
    const cost = { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, tieredPricing: tiers };

    const total = estimateUsageCost({
      usage: { input: 150, output: 60 },
      cost,
    });

    expect(total).toBeCloseTo(0.00225, 8);
  });

  it("normalizes open-ended range from models.json ([start] and [start, -1])", async () => {
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            volcengine: {
              models: [
                {
                  id: "doubao-open-ended",
                  cost: {
                    input: 0.46,
                    output: 2.3,
                    cacheRead: 0,
                    cacheWrite: 0,
                    tieredPricing: [
                      { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, range: [0, 32000] },
                      { input: 0.7, output: 3.5, cacheRead: 0, cacheWrite: 0, range: [32000] },
                    ],
                  },
                },
                {
                  id: "doubao-neg-one",
                  cost: {
                    input: 0.46,
                    output: 2.3,
                    cacheRead: 0,
                    cacheWrite: 0,
                    tieredPricing: [
                      { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, range: [0, 32000] },
                      { input: 0.7, output: 3.5, cacheRead: 0, cacheWrite: 0, range: [32000, -1] },
                    ],
                  },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    // [32000] should be normalized to [32000, Infinity]
    const cost1 = resolveModelCostConfig({
      provider: "volcengine",
      model: "doubao-open-ended",
    });
    const tiers1 = requireTieredPricing(requireCostConfig(cost1, "open-ended"), "open-ended");
    expect(tiers1).toHaveLength(2);
    expect(expectDefined(tiers1[1], "tiers1[1] test invariant").range).toEqual([32000, Infinity]);

    // [32000, -1] should also be normalized to [32000, Infinity]
    const cost2 = resolveModelCostConfig({
      provider: "volcengine",
      model: "doubao-neg-one",
    });
    const tiers2 = requireTieredPricing(requireCostConfig(cost2, "negative-end"), "negative-end");
    expect(tiers2).toHaveLength(2);
    expect(expectDefined(tiers2[1], "tiers2[1] test invariant").range).toEqual([32000, Infinity]);
  });

  it("resolves tiered pricing from models.json", async () => {
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            volcengine: {
              models: [
                {
                  id: "doubao-seed-2-0-pro",
                  cost: {
                    input: 0.46,
                    output: 2.3,
                    cacheRead: 0,
                    cacheWrite: 0,
                    tieredPricing: [
                      { input: 0.46, output: 2.3, cacheRead: 0, cacheWrite: 0, range: [0, 32000] },
                      {
                        input: 0.7,
                        output: 3.5,
                        cacheRead: 0,
                        cacheWrite: 0,
                        range: [32000, 128000],
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const cost = resolveModelCostConfig({
      provider: "volcengine",
      model: "doubao-seed-2-0-pro",
    });
    const tiers = requireTieredPricing(requireCostConfig(cost, "models.json"), "models.json");

    expect(tiers).toHaveLength(2);
    expect(expectDefined(tiers[0], "tiers[0] test invariant").range).toEqual([0, 32000]);
    expect(expectDefined(tiers[1], "tiers[1] test invariant").input).toBe(0.7);
  });

  it("resolves tiered pricing from cached gateway (LiteLLM)", () => {
    setGatewayModelPricing([
      {
        provider: "volcengine",
        model: "doubao-seed",
        pricing: {
          input: 0.46,
          output: 2.3,
          cacheRead: 0,
          cacheWrite: 0,
          tieredPricing: [
            {
              input: 0.46,
              output: 2.3,
              cacheRead: 0,
              cacheWrite: 0,
              range: [0, 32000] as [number, number],
            },
            {
              input: 0.7,
              output: 3.5,
              cacheRead: 0,
              cacheWrite: 0,
              range: [32000, 128000] as [number, number],
            },
          ],
        },
      },
    ]);

    const cost = resolveModelCostConfig({
      provider: "volcengine",
      model: "doubao-seed",
    });
    const tiers = requireTieredPricing(requireCostConfig(cost, "cached gateway"), "cached gateway");

    expect(tiers).toHaveLength(2);
  });
});
