import { describe, expect, it } from "vitest";
import { checkContinuationBudget } from "./scheduler.js";
import type { ContinuationRuntimeConfig } from "./types.js";

const baseConfig: ContinuationRuntimeConfig = {
  enabled: true,
  defaultDelayMs: 15_000,
  minDelayMs: 5_000,
  maxDelayMs: 300_000,
  maxChainLength: 10,
  costCapTokens: 500_000,
  maxDelegatesPerTurn: 5,
  maxPendingWork: 32,
  crossSessionTargeting: "disabled",
};

describe("checkContinuationBudget", () => {
  it("returns null when under budget", () => {
    expect(
      checkContinuationBudget({
        chainState: { currentChainCount: 3, chainStartedAt: 0, accumulatedChainTokens: 100_000 },
        config: baseConfig,
        sessionKey: "test",
      }),
    ).toBeNull();
  });

  it("returns chain-capped at max depth", () => {
    expect(
      checkContinuationBudget({
        chainState: { currentChainCount: 10, chainStartedAt: 0, accumulatedChainTokens: 0 },
        config: baseConfig,
        sessionKey: "test",
      }),
    ).toBe("chain-capped");
  });

  it("returns cost-capped over budget", () => {
    expect(
      checkContinuationBudget({
        chainState: { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 600_000 },
        config: baseConfig,
        sessionKey: "test",
      }),
    ).toBe("cost-capped");
  });

  it("allows continuation when accumulated tokens equal costCapTokens exactly", () => {
    expect(
      checkContinuationBudget({
        chainState: { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 500_000 },
        config: baseConfig,
        sessionKey: "test",
      }),
    ).toBeNull();
  });

  it("does not cost-cap when costCapTokens is 0", () => {
    expect(
      checkContinuationBudget({
        chainState: { currentChainCount: 0, chainStartedAt: 0, accumulatedChainTokens: 999_999 },
        config: { ...baseConfig, costCapTokens: 0 },
        sessionKey: "test",
      }),
    ).toBeNull();
  });
});
