// Usage format tests cover display formatting for token and cost usage.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as manifestModelIdNormalization from "../plugins/manifest-model-id-normalization.js";
import { captureEnv } from "../test-utils/env.js";
import {
  resetUsageFormatCachesForTest,
  estimateUsageCost,
  formatUsd,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "./usage-format.js";

type ModelCostConfig = NonNullable<ReturnType<typeof resolveModelCostConfig>>;

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
  });

  afterEach(async () => {
    envSnapshot?.restore();
    envSnapshot = undefined;
    resetUsageFormatCachesForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
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

  it("prefers explicit configured pricing over a provider-owned static model price", () => {
    const config = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.4",
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        provider: "openai",
        model: "gpt-5.4",
        config,
      }),
    ).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it("prefers agent-local pricing over configured and provider-owned static model prices", async () => {
    const config = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.4",
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.4",
                cost: { input: 7, output: 11, cacheRead: 0.5, cacheWrite: 0.25 },
              },
            ],
          },
        },
      }),
      "utf8",
    );

    expect(
      resolveModelCostConfig({
        provider: "openai",
        model: "gpt-5.4",
        config,
      }),
    ).toEqual({ input: 7, output: 11, cacheRead: 0.5, cacheWrite: 0.25 });
  });

  it("scopes models.json pricing by agent directory before configured and default pricing", async () => {
    const secondAgentDir = path.join(stateDir, "agents", "second", "agent");
    const configuredOnlyAgentDir = path.join(stateDir, "agents", "configured-only", "agent");
    const writePricing = async (targetAgentDir: string, input: number) => {
      await fs.mkdir(targetAgentDir, { recursive: true });
      await fs.writeFile(
        path.join(targetAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            "demo-scoped": {
              models: [
                {
                  id: "demo-model",
                  cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        }),
        "utf8",
      );
    };
    await writePricing(agentDir, 10);
    await writePricing(secondAgentDir, 20);
    await fs.mkdir(configuredOnlyAgentDir, { recursive: true });

    const config = {
      models: {
        providers: {
          "demo-scoped": {
            models: [
              {
                id: "demo-model",
                cost: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolveInputPrice = (scopedAgentDir?: string) =>
      resolveModelCostConfig({
        provider: "demo-scoped",
        model: "demo-model",
        config,
        agentDir: scopedAgentDir,
      })?.input;

    expect(resolveInputPrice(agentDir)).toBe(10);
    expect(resolveInputPrice(secondAgentDir)).toBe(20);
    expect(resolveInputPrice(configuredOnlyAgentDir)).toBe(30);
    expect(resolveInputPrice()).toBe(10);
  });

  it("bounds the agent-directory models.json pricing cache", async () => {
    const writePricing = async (targetAgentDir: string, input: number) => {
      await fs.mkdir(targetAgentDir, { recursive: true });
      await fs.writeFile(
        path.join(targetAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            "demo-bounded": {
              models: [
                {
                  id: "demo-model",
                  cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        }),
        "utf8",
      );
    };
    const agentDirs = Array.from({ length: 129 }, (_, index) =>
      path.join(stateDir, "agents", `bounded-${index}`, "agent"),
    );
    for (const [index, targetAgentDir] of agentDirs.entries()) {
      await writePricing(targetAgentDir, index + 1);
      expect(
        resolveModelCostConfig({
          provider: "demo-bounded",
          model: "demo-model",
          agentDir: targetAgentDir,
        })?.input,
      ).toBe(index + 1);
    }

    const firstAgentDir = expectDefined(agentDirs[0], "first bounded agent directory");
    await writePricing(firstAgentDir, 999);
    expect(
      resolveModelCostConfig({
        provider: "demo-bounded",
        model: "demo-model",
        agentDir: firstAgentDir,
      })?.input,
    ).toBe(999);
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

    expect(before).toMatch(/^[0-9a-f]{64}$/u);
    expect(after).toMatch(/^[0-9a-f]{64}$/u);
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
});
