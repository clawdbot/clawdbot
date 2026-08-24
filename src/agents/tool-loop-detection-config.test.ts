// Covers the runLoop guard config resolver: per-key activation, built-in
// defaults, the `enabled: false` kill switch, and agent-over-global cascade.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveLoopGuardRuntimeConfig,
  resolveToolLoopDetectionConfig,
} from "./tool-loop-detection-config.js";

describe("resolveLoopGuardRuntimeConfig", () => {
  it("keeps every guard off when no loopDetection block exists (opt-in)", () => {
    expect(resolveLoopGuardRuntimeConfig({})).toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
    expect(resolveLoopGuardRuntimeConfig({ cfg: { tools: {} } })).toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
  });

  it("keeps every guard off when a block exists without any guard key (opt-in)", () => {
    // An existing `tools.loopDetection: { enabled: true }` must not activate
    // hard cutoffs on upgrade: `enabled: true` only activates the existing
    // rolling-history detectors. At least one guard key is required.
    expect(
      resolveLoopGuardRuntimeConfig({ cfg: { tools: { loopDetection: { enabled: true } } } }),
    ).toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
    expect(resolveLoopGuardRuntimeConfig({ cfg: { tools: { loopDetection: {} } } })).toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
  });

  it("activates a guard with the configured value when the guard key is explicitly set", () => {
    const cfg: OpenClawConfig = {
      tools: { loopDetection: { turnLimit: 200 } },
    };
    expect(resolveLoopGuardRuntimeConfig({ cfg })).toEqual({
      maxTurns: 200,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
  });

  it("activates each guard independently when its key is set", () => {
    const cfg: OpenClawConfig = {
      tools: {
        loopDetection: { enabled: true, turnLimit: 50, maxIdleRepeatCalls: 5 },
      },
    };
    expect(resolveLoopGuardRuntimeConfig({ cfg })).toEqual({
      maxTurns: 50,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: 5,
    });
  });

  it("activates guards by key even without enabled:true", () => {
    // `enabled` is not required: setting a guard key is itself the activation
    // path. This lets operators opt into hard cutoffs without also changing
    // the rolling-history detector switch.
    const cfg: OpenClawConfig = {
      tools: {
        loopDetection: { turnLimit: 50, maxIdleRepeatCalls: 5 },
      },
    };
    expect(resolveLoopGuardRuntimeConfig({ cfg })).toEqual({
      maxTurns: 50,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: 5,
    });
  });

  it("disables every guard when enabled is explicitly false", () => {
    const cfg: OpenClawConfig = {
      tools: { loopDetection: { enabled: false, turnLimit: 1 } },
    };
    expect(resolveLoopGuardRuntimeConfig({ cfg })).toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
  });

  it("cascades per-agent guard keys over global values", () => {
    const cfg: OpenClawConfig = {
      tools: {
        loopDetection: { enabled: true, turnLimit: 300, maxConsecutiveErrorBatches: 4 },
      },
      agents: {
        list: [
          {
            id: "worker",
            tools: { loopDetection: { turnLimit: 25 } },
          },
        ],
      },
    };
    expect(resolveLoopGuardRuntimeConfig({ cfg, agentId: "worker" })).toEqual({
      maxTurns: 25,
      maxConsecutiveErrorBatches: 4,
      maxIdleRepeatCalls: undefined,
    });
    // Other agents keep the global values.
    expect(resolveLoopGuardRuntimeConfig({ cfg, agentId: "other" })).toEqual({
      maxTurns: 300,
      maxConsecutiveErrorBatches: 4,
      maxIdleRepeatCalls: undefined,
    });
  });

  it("lets a per-agent enabled:false override global guard keys", () => {
    const cfg: OpenClawConfig = {
      tools: { loopDetection: { enabled: true, turnLimit: 200 } },
      agents: {
        list: [{ id: "worker", tools: { loopDetection: { enabled: false } } }],
      },
    };
    expect(resolveLoopGuardRuntimeConfig({ cfg, agentId: "worker" })).toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
    expect(resolveLoopGuardRuntimeConfig({ cfg, agentId: "other" })).toEqual({
      maxTurns: 200,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
  });
});

describe("resolveToolLoopDetectionConfig merge", () => {
  it("merges agent keys over global keys field by field", () => {
    const cfg: OpenClawConfig = {
      tools: {
        loopDetection: {
          enabled: true,
          turnLimit: 100,
          maxConsecutiveErrorBatches: 5,
          maxIdleRepeatCalls: 7,
        },
      },
      agents: {
        list: [
          {
            id: "worker",
            tools: { loopDetection: { turnLimit: 40, maxIdleRepeatCalls: 2 } },
          },
        ],
      },
    };
    expect(resolveToolLoopDetectionConfig({ cfg, agentId: "worker" })).toEqual({
      enabled: true,
      turnLimit: 40,
      maxConsecutiveErrorBatches: 5,
      maxIdleRepeatCalls: 2,
    });
  });
});
