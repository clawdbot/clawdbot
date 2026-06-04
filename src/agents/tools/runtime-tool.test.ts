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
});
