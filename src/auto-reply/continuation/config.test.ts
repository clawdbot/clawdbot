import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  getRuntimeConfigSnapshot: vi.fn(() => null),
}));

import { getRuntimeConfigSnapshot } from "../../config/config.js";
import {
  clampDelayMs,
  resolveContinuationRuntimeConfig,
  resolveLiveContinuationRuntimeConfig,
} from "./config.js";
import type { ContinuationRuntimeConfig } from "./types.js";

const getRuntimeConfigSnapshotMock = vi.mocked(getRuntimeConfigSnapshot);

describe("resolveContinuationRuntimeConfig", () => {
  it("returns defaults when continuation is not configured", () => {
    const config = resolveContinuationRuntimeConfig({} as never);
    expect(config).toMatchObject({
      enabled: false,

      defaultDelayMs: 15_000,
      minDelayMs: 5_000,
      maxDelayMs: 300_000,
      maxChainLength: 10,
      costCapTokens: 500_000,
      maxDelegatesPerTurn: 5,
      maxPendingWork: 32,
      crossSessionTargeting: "disabled",
      earlyWarningBand: 0.3125,
    });
    expect(config.contextPressureThreshold).toBeUndefined();
  });

  it("resolves configured values with clamping", () => {
    const config = resolveContinuationRuntimeConfig({
      agents: {
        defaults: {
          continuation: {
            enabled: true,

            maxChainLength: 100,
            costCapTokens: 0,
            maxDelegatesPerTurn: 20,
            maxPendingWork: 32,
            crossSessionTargeting: "enabled",
            contextPressureThreshold: 0.8,
            earlyWarningBand: 0,
            defaultDelayMs: 30_000,
            minDelayMs: 1_000,
            maxDelayMs: 600_000,
          },
        },
      },
    } as never);
    expect(config).toMatchObject({
      enabled: true,

      maxChainLength: 100,
      costCapTokens: 0,
      maxDelegatesPerTurn: 20,
      maxPendingWork: 32,
      crossSessionTargeting: "enabled",
      contextPressureThreshold: 0.8,
      earlyWarningBand: 0,
      defaultDelayMs: 30_000,
      minDelayMs: 1_000,
      maxDelayMs: 600_000,
    });
  });

  it("clamps negative values to defaults", () => {
    const config = resolveContinuationRuntimeConfig({
      agents: {
        defaults: {
          continuation: {
            maxChainLength: -5,
            costCapTokens: -1,
            maxDelegatesPerTurn: 0,
          },
        },
      },
    } as never);
    expect(config.maxChainLength).toBe(10);
    expect(config.costCapTokens).toBe(500_000);
    expect(config.maxDelegatesPerTurn).toBe(5);
  });

  it("clamps maxPendingWork to default when non-positive", () => {
    const zero = resolveContinuationRuntimeConfig({
      agents: { defaults: { continuation: { maxPendingWork: 0 } } },
    } as never);
    expect(zero.maxPendingWork).toBe(32);
    const negative = resolveContinuationRuntimeConfig({
      agents: { defaults: { continuation: { maxPendingWork: -7 } } },
    } as never);
    expect(negative.maxPendingWork).toBe(32);
    const configured = resolveContinuationRuntimeConfig({
      agents: { defaults: { continuation: { maxPendingWork: 8 } } },
    } as never);
    expect(configured.maxPendingWork).toBe(8);
  });

  it("rejects invalid contextPressureThreshold", () => {
    expect(
      resolveContinuationRuntimeConfig({
        agents: { defaults: { continuation: { contextPressureThreshold: 0 } } },
      } as never).contextPressureThreshold,
    ).toBeUndefined();
    expect(
      resolveContinuationRuntimeConfig({
        agents: { defaults: { continuation: { contextPressureThreshold: 1.5 } } },
      } as never).contextPressureThreshold,
    ).toBeUndefined();
  });

  it("defaults invalid earlyWarningBand and preserves explicit opt-out", () => {
    expect(
      resolveContinuationRuntimeConfig({
        agents: { defaults: { continuation: { earlyWarningBand: 0 } } },
      } as never).earlyWarningBand,
    ).toBe(0);
    expect(
      resolveContinuationRuntimeConfig({
        agents: { defaults: { continuation: { earlyWarningBand: 1.5 } } },
      } as never).earlyWarningBand,
    ).toBe(0.3125);
  });

  it("has no generationGuardTolerance field", () => {
    const config = resolveContinuationRuntimeConfig({} as never);
    expect("generationGuardTolerance" in config).toBe(false);
  });

  it("defaults busySkipBackoff to 1s base ×2 capped at maxDelayMs", () => {
    const config = resolveContinuationRuntimeConfig({} as never);
    expect(config.busySkipBackoff).toEqual({ baseMs: 1_000, ceilingMs: 300_000, factor: 2 });
    // ceiling tracks a configured maxDelayMs.
    const tight = resolveContinuationRuntimeConfig({
      agents: { defaults: { continuation: { maxDelayMs: 60_000 } } },
    } as never);
    expect(tight.busySkipBackoff?.ceilingMs).toBe(60_000);
  });

  it("resolves configured busySkipBackoff and clamps invalid values", () => {
    const config = resolveContinuationRuntimeConfig({
      agents: {
        defaults: {
          continuation: { busySkipBackoff: { baseMs: 500, ceilingMs: 120_000, factor: 3 } },
        },
      },
    } as never);
    expect(config.busySkipBackoff).toEqual({ baseMs: 500, ceilingMs: 120_000, factor: 3 });
    // factor must exceed 1; non-positive base falls back to the default.
    const clamped = resolveContinuationRuntimeConfig({
      agents: {
        defaults: { continuation: { busySkipBackoff: { baseMs: 0, factor: 1 } } },
      },
    } as never);
    expect(clamped.busySkipBackoff).toEqual({ baseMs: 1_000, ceilingMs: 300_000, factor: 2 });
  });

  it("leaves orphanReapStaleCutoffMs unset by default and resolves a positive override", () => {
    expect(resolveContinuationRuntimeConfig({} as never).orphanReapStaleCutoffMs).toBeUndefined();
    const configured = resolveContinuationRuntimeConfig({
      agents: { defaults: { continuation: { orphanReapStaleCutoffMs: 1_800_000 } } },
    } as never);
    expect(configured.orphanReapStaleCutoffMs).toBe(1_800_000);
    // Non-positive is rejected (stays unset → subagent default).
    expect(
      resolveContinuationRuntimeConfig({
        agents: { defaults: { continuation: { orphanReapStaleCutoffMs: 0 } } },
      } as never).orphanReapStaleCutoffMs,
    ).toBeUndefined();
  });

  it("prefers the active runtime snapshot when resolving live config", () => {
    getRuntimeConfigSnapshotMock.mockReturnValueOnce({
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 9 } } },
    } as never);

    const config = resolveLiveContinuationRuntimeConfig({
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 3 } } },
    } as never);

    expect(config.maxDelegatesPerTurn).toBe(9);
  });

  it("falls back to the provided config when no runtime snapshot is active", () => {
    const config = resolveLiveContinuationRuntimeConfig({
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 4 } } },
    } as never);

    expect(config.maxDelegatesPerTurn).toBe(4);
  });

  it("uses active runtime snapshot defaults when continuation config was unset", () => {
    getRuntimeConfigSnapshotMock.mockReturnValueOnce({} as never);

    const config = resolveLiveContinuationRuntimeConfig({
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 6 } } },
    } as never);

    expect(config.maxDelegatesPerTurn).toBe(5);
  });
});

describe("clampDelayMs", () => {
  const config: ContinuationRuntimeConfig = {
    enabled: true,

    defaultDelayMs: 15_000,
    minDelayMs: 5_000,
    maxDelayMs: 300_000,
    maxChainLength: 10,
    costCapTokens: 500_000,
    maxDelegatesPerTurn: 5,
    maxPendingWork: 32,
    crossSessionTargeting: "disabled",
    earlyWarningBand: 0.3125,
  };

  it("uses default when undefined", () => {
    expect(clampDelayMs(undefined, config)).toBe(15_000);
  });

  it("treats an explicit zero as the immediate sentinel → 0, NOT defaultDelayMs", () => {
    // anchor: an explicit `delaySeconds=0` must NOT fall back to the 15s
    // default via a `|| defaultDelayMs` falsy check (0 is not "absent").
    // refinement: a real 0 is the IMMEDIATE sentinel and passes through
    // as 0 rather than clamping up to minDelayMs — matching the model-facing
    // "0 = immediate" schema. Omitted (undefined) still → defaultDelayMs (below),
    // so the 0-is-not-default distinction guards is preserved.
    expect(clampDelayMs(0, config)).toBe(0);
  });

  it("clamps below minimum", () => {
    expect(clampDelayMs(1_000, config)).toBe(5_000);
  });

  it("clamps above maximum", () => {
    expect(clampDelayMs(600_000, config)).toBe(300_000);
  });

  it("passes through values in range", () => {
    expect(clampDelayMs(60_000, config)).toBe(60_000);
  });
});
