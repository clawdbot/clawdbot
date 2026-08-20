// Pricing provenance tests for usage cost estimation and the mutable cost
// index: marked-unknown pricing must never surface as a confident $0.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildManifestModelProviderConfig } from "../plugin-sdk/provider-catalog-shared.js";
import { captureEnv } from "../test-utils/env.js";
import {
  resetUsageFormatCachesForTest,
  estimateUsageCost,
  resolveModelCostConfig,
} from "./usage-format.js";

describe("usage-format pricing provenance", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let agentDir: string;
  let stateDir: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_AGENT_DIR", "OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-pricing-"));
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

  it("returns undefined for pricing marked pricingUnavailable", () => {
    const marked = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      pricingUnavailable: true as const,
    };
    expect(
      estimateUsageCost({ usage: { input: 1000, output: 500, cacheRead: 2000 }, cost: marked }),
    ).toBeUndefined();
  });

  it("keeps a numeric zero estimate for unmarked all-zero pricing", () => {
    const confirmedFree = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(
      estimateUsageCost({
        usage: { input: 1000, output: 500, cacheRead: 2000 },
        cost: confirmedFree,
      }),
    ).toBe(0);
  });

  it("omits cost for a missing-price static manifest model through the usage boundary", () => {
    // Mirrors the Claude CLI rows in extensions/anthropic/openclaw.plugin.json,
    // which omit cost entirely: the shared manifest producer must mark the
    // zero-filled rates as unknown pricing so usage stays omitted, not $0.
    const providerConfig = buildManifestModelProviderConfig({
      providerId: "acme-cli",
      catalog: {
        baseUrl: "https://api.acme.test/v1",
        models: [
          {
            id: "acme-opus",
            name: "Acme Opus",
            contextWindow: 200_000,
            maxTokens: 64_000,
          },
          {
            id: "acme-free",
            name: "Acme Free",
            contextWindow: 200_000,
            maxTokens: 64_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    });
    const config = {
      models: { providers: { "acme-cli": providerConfig } },
    } as unknown as OpenClawConfig;

    const unknownCost = resolveModelCostConfig({
      provider: "acme-cli",
      model: "acme-opus",
      config,
    });
    expect(unknownCost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      pricingUnavailable: true,
    });
    expect(
      estimateUsageCost({ usage: { input: 1000, output: 500 }, cost: unknownCost }),
    ).toBeUndefined();

    // Explicit all-zero manifest pricing stays a confirmed free $0.
    const freeCost = resolveModelCostConfig({
      provider: "acme-cli",
      model: "acme-free",
      config,
    });
    expect(freeCost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(estimateUsageCost({ usage: { input: 1000, output: 500 }, cost: freeCost })).toBe(0);
  });

  it("refreshes the cached cost index when only pricingUnavailable mutates", () => {
    const mutableModel = {
      id: "demo-model",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as {
      id: string;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        pricingUnavailable?: boolean;
      };
    };
    const config = {
      models: {
        providers: {
          "demo-marker-mutation": {
            models: [mutableModel],
          },
        },
      },
    } as unknown as OpenClawConfig;

    // First resolve caches the unmarked zero-cost entry.
    expect(
      resolveModelCostConfig({
        provider: "demo-marker-mutation",
        model: "demo-model",
        config,
      }),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    // A marker-only mutation must invalidate the cached entry, or downstream
    // output keeps reporting the stale confident $0 for unknown pricing.
    mutableModel.cost.pricingUnavailable = true;
    expect(
      resolveModelCostConfig({
        provider: "demo-marker-mutation",
        model: "demo-model",
        config,
      }),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, pricingUnavailable: true });
  });
});
