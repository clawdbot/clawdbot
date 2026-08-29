import { describe, expect, it } from "vitest";
import { resolvePreparedModelThinkingCompat } from "./model-catalog-lookup.js";

describe("prepared thinking disablement ownership", () => {
  it.each([
    {
      name: "retains route disablement while replacing enabled tiers",
      selected: ["none", "low"],
      prepared: ["max", "ultra"],
      expected: ["none", "max", "ultra"],
    },
    {
      name: "does not grant disablement to an unknown route",
      selected: undefined,
      prepared: ["none", "max", "ultra"],
      expected: ["max", "ultra"],
    },
    {
      name: "does not grant disablement from nullable route metadata",
      selected: null,
      prepared: ["none", "max"],
      expected: ["max"],
    },
    {
      name: "retains route disablement when enabled tiers are unknown",
      selected: ["none", "low"],
      prepared: null,
      expected: ["none"],
    },
    {
      name: "preserves nullable unknown metadata",
      selected: undefined,
      prepared: null,
      expected: null,
    },
    {
      name: "leaves an absent effort overlay absent",
      selected: ["none", "high"],
      prepared: undefined,
      expected: undefined,
    },
    {
      name: "accepts disablement from the exact physical route",
      selected: undefined,
      prepared: ["none", "high"],
      expected: ["none", "high"],
      routeBound: true,
    },
    {
      name: "accepts nullable metadata from the exact physical route",
      selected: ["none", "high"],
      prepared: null,
      expected: null,
      routeBound: true,
    },
  ])("$name", ({ selected, prepared, expected, routeBound }) => {
    const route = { api: "openai-responses", baseUrl: "https://reasoning.example/v1" } as const;
    const model = {
      provider: "reasoning-provider",
      id: "reasoning-model",
      ...route,
      compat: { supportedReasoningEfforts: selected },
    };
    const result = resolvePreparedModelThinkingCompat({
      model,
      agentRuntime: "native-harness",
      capability: {
        provider: model.provider,
        modelId: model.id,
        agentRuntime: "native-harness",
        ...(routeBound ? { route } : {}),
        compat: { thinkingFormat: "openai", supportedReasoningEfforts: prepared },
      },
    });

    expect(result).toEqual({ thinkingFormat: "openai", supportedReasoningEfforts: expected });
  });
});
