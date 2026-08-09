// Pricing provenance tests for usage cost estimation and the mutable cost
// index: marked-unknown pricing must never surface as a confident $0.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
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
