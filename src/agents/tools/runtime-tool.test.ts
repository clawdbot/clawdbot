import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createRuntimeTool } from "./runtime-tool.js";

function createConfig(): OpenClawConfig {
  return {
    runtimeContext: {
      source: "static",
      expose: { mode: "tool_hint" },
      value: {
        id: "openclaw-dev",
        current: {
          id: "openclaw-dev",
          locality: "local",
        },
        resources: {
          cpu: {
            effectiveCores: 8,
          },
        },
        actions: [
          {
            kind: "scale_up",
            label: "Resize this runtime",
            ref: "runtime-action://gateway/current/scale-up",
            requiresApproval: true,
          },
        ],
        offload: {
          targets: [
            {
              id: "gateway-large",
              locality: "cloud",
              workloadKinds: ["codex", "long_task"],
              cost: {
                model: "metered",
                currency: "USD",
                estimateRef: "runtime-cost://gateway-large/estimate",
              },
            },
          ],
        },
      },
    },
  };
}

describe("runtime tool", () => {
  it("is omitted when runtime context exposure is none", () => {
    expect(
      createRuntimeTool({
        config: {
          runtimeContext: {
            expose: { mode: "none" },
            value: { id: "hidden" },
          },
        },
      }),
    ).toBeNull();
  });

  it("is omitted when exposure mode is unset (defaults to none)", () => {
    expect(
      createRuntimeTool({
        config: {
          runtimeContext: {
            value: { id: "hidden" },
          },
        },
      }),
    ).toBeNull();
  });

  it("returns filtered runtime details", async () => {
    const tool = createRuntimeTool({ config: createConfig() });
    expect(tool).not.toBeNull();
    const result = await tool!.execute("runtime-1", {
      action: "describe",
      include: ["current", "actions"],
    });
    expect(result.details).toEqual({
      value: {
        id: "openclaw-dev",
        current: {
          id: "openclaw-dev",
          locality: "local",
        },
        actions: [
          {
            kind: "scale_up",
            label: "Resize this runtime",
            ref: "runtime-action://gateway/current/scale-up",
            requiresApproval: true,
          },
        ],
      },
    });
  });

  it("returns unavailable status when configured without a runtime value", async () => {
    const tool = createRuntimeTool({
      config: {
        runtimeContext: {
          source: "provider",
          expose: { mode: "tool_hint" },
          validUntil: "2026-06-03T20:00:00-07:00",
        },
      },
    });
    expect(tool).not.toBeNull();
    const result = await tool!.execute("runtime-empty", { action: "describe" });
    expect(result.details).toEqual({
      status: "unavailable",
      source: "provider",
      expose: { mode: "tool_hint" },
      validUntil: "2026-06-03T20:00:00-07:00",
      reason: "Runtime context is configured but no runtime value is available.",
    });
  });

  it("returns static offload cost hints before provider estimators exist", async () => {
    const tool = createRuntimeTool({ config: createConfig() });
    const result = await tool!.execute("runtime-2", {
      action: "cost_estimate",
      targetId: "gateway-large",
      workload: { kind: "build" },
    });
    expect(result.details).toEqual({
      targetId: "gateway-large",
      cost: {
        model: "metered",
        currency: "USD",
        estimateRef: "runtime-cost://gateway-large/estimate",
      },
      workload: { kind: "build" },
      estimate: {
        status: "not_available",
        reason: "No provider-backed runtime cost estimator is registered in this v1 slice.",
      },
    });
  });

  it("does not inherit current runtime cost hints for target estimates", async () => {
    const config = createConfig();
    config.runtimeContext!.value!.cost = {
      model: "metered",
      currency: "USD",
      roughUnitCost: "current runtime only",
    };
    const target = config.runtimeContext!.value!.offload!.targets![0];
    expect(target).toBeDefined();
    delete target!.cost;
    const tool = createRuntimeTool({ config });
    const result = await tool!.execute("runtime-current-cost", {
      action: "cost_estimate",
      targetId: "gateway-large",
    });
    expect(result.details).toMatchObject({
      targetId: "gateway-large",
      cost: { model: "unknown" },
      estimate: { status: "not_available" },
    });
  });

  it("returns target_not_found for unknown cost target ids", async () => {
    const tool = createRuntimeTool({ config: createConfig() });
    const result = await tool!.execute("runtime-3", {
      action: "cost_estimate",
      targetId: "missing",
    });
    expect(result.details).toEqual({
      targetId: "missing",
      estimate: {
        status: "target_not_found",
        reason: "No configured offload target matched targetId.",
      },
    });
  });

  it("requires targetId for cost estimates when multiple offload targets exist", async () => {
    const config = createConfig();
    config.runtimeContext?.value?.offload?.targets?.push({
      id: "gateway-medium",
      locality: "cloud",
      workloadKinds: ["codex"],
      cost: { model: "quota" },
    });
    const tool = createRuntimeTool({ config });
    await expect(tool!.execute("runtime-4", { action: "cost_estimate" })).rejects.toThrow(
      "targetId required when multiple offload targets are configured",
    );
  });
});
