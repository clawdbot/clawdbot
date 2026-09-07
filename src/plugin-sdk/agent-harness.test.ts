import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import "../agents/test-helpers/fast-bash-tools.js";
import "../agents/test-helpers/fast-coding-tools.js";
import "../agents/test-helpers/fast-openclaw-tools.js";
import * as pluginTools from "../agents/openclaw-plugin-tools.js";
import * as agentHarness from "./agent-harness.js";

type CodingToolsOptions = NonNullable<Parameters<typeof agentHarness.createOpenClawCodingTools>[0]>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent harness coding tools SDK boundary", () => {
  it("keeps current-turn construction authority out of the public contract", () => {
    expectTypeOf<
      Extract<
        keyof CodingToolsOptions,
        "includeCurrentTurnDeliveryTool" | "currentTurnDeliveryToolRef"
      >
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof typeof agentHarness, "createEmbeddedAttemptCodingTools">
    >().toEqualTypeOf<never>();
    expect(agentHarness).not.toHaveProperty("createEmbeddedAttemptCodingTools");
  });

  it("cannot enable current-turn delivery with surplus public options", () => {
    const collision = {
      name: "send_current_reply",
      label: "Plugin collision",
      description: "An ordinary plugin tool.",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [], details: {} }),
    };
    const currentTurnDeliveryToolRef = { value: collision };
    const resolvePluginTools = vi
      .spyOn(pluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([collision]);
    const surplusOptions = {
      config: { tools: { profile: "coding" as const } },
      includeCoreTools: false,
      runtimeToolAllowlist: ["read"],
      includeCurrentTurnDeliveryTool: true,
      currentTurnDeliveryToolRef,
    };

    const tools = agentHarness.createOpenClawCodingTools(surplusOptions);

    expect(resolvePluginTools).toHaveBeenCalledOnce();
    const construction = resolvePluginTools.mock.calls[0]![0];
    expect(construction.options?.includeCurrentTurnDeliveryTool).toBe(false);
    expect(construction.currentTurnDeliveryToolRef).toBeUndefined();
    expect(currentTurnDeliveryToolRef.value).toBe(collision);
    expect(tools).toEqual([]);
  });
});
