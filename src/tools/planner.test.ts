import { describe, expect, it } from "vitest";
import { ToolPlanContractError } from "./diagnostics.js";
import { formatToolExecutorRef } from "./execution.js";
import { buildToolPlan } from "./planner.js";
import { toToolProtocolDescriptors } from "./protocol.js";
import type { ToolDescriptor } from "./types.js";

function descriptor(name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
    owner: { kind: "core" },
    executor: { kind: "core", executorId: name },
    ...overrides,
  };
}

describe("buildToolPlan", () => {
  it("sorts visible and hidden tools deterministically", () => {
    const plan = buildToolPlan({
      descriptors: [
        descriptor("zeta"),
        descriptor("alpha"),
        descriptor("hidden", {
          sortKey: "middle",
          availability: { kind: "env", name: "MISSING_ENV" },
        }),
      ],
      availability: { env: {} },
    });

    expect(plan.visible.map((entry) => entry.descriptor.name)).toEqual(["alpha", "zeta"]);
    expect(plan.hidden.map((entry) => entry.descriptor.name)).toEqual(["hidden"]);
    expect(plan.hidden[0]?.diagnostics.map((entry) => entry.reason)).toEqual(["env-missing"]);
  });

  it("fails deterministically on duplicate tool names", () => {
    let error: unknown;
    try {
      buildToolPlan({
        descriptors: [descriptor("read"), descriptor("read")],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ToolPlanContractError);
    expect(error).toMatchObject({
      code: "duplicate-tool-name",
      toolName: "read",
    });
  });

  it("fails closed when a visible descriptor has no executor", () => {
    let error: unknown;
    try {
      buildToolPlan({
        descriptors: [descriptor("read", { executor: undefined })],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ToolPlanContractError);
    expect(error).toMatchObject({
      code: "missing-executor",
      toolName: "read",
    });
  });

  it("does not require an executor for unavailable descriptors", () => {
    const plan = buildToolPlan({
      descriptors: [
        descriptor("plugin_tool", {
          executor: undefined,
          availability: { kind: "plugin-enabled", pluginId: "demo" },
        }),
      ],
      availability: { enabledPluginIds: new Set() },
    });

    expect(plan.visible).toEqual([]);
    expect(plan.hidden[0]?.descriptor.name).toBe("plugin_tool");
    expect(plan.hidden[0]?.diagnostics[0]?.reason).toBe("plugin-disabled");
  });

  it("hides descriptors with malformed empty allOf availability", () => {
    const plan = buildToolPlan({
      descriptors: [descriptor("malformed", { availability: { allOf: [] } })],
    });

    expect(plan.visible).toEqual([]);
    expect(plan.hidden[0]?.descriptor.name).toBe("malformed");
    expect(plan.hidden[0]?.diagnostics).toEqual([
      {
        reason: "unsupported-signal",
        message: "Empty availability allOf group",
      },
    ]);
  });

  it("keeps protocol conversion separate from executor refs and model normalization", () => {
    const plan = buildToolPlan({
      descriptors: [
        descriptor("plugin_tool", {
          owner: { kind: "plugin", pluginId: "demo" },
          executor: { kind: "plugin", pluginId: "demo", toolName: "plugin_tool" },
        }),
      ],
    });

    expect(formatToolExecutorRef(plan.visible[0].executor)).toBe("plugin:demo:plugin_tool");
    expect(toToolProtocolDescriptors(plan.visible)).toEqual([
      {
        name: "plugin_tool",
        description: "plugin_tool description",
        inputSchema: { type: "object" },
      },
    ]);
  });
});
