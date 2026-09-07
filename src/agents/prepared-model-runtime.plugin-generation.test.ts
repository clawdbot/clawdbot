import { describe, expect, it, vi } from "vitest";
import { preparedPluginGenerationSupportsSelections } from "./prepared-model-runtime.plugin-generation.js";

vi.mock("./harness/runtime-plugin-load-plan.js", () => ({
  resolveAgentRuntimePluginLoadPlan: vi.fn(() => ({ pluginIds: ["qwen"] })),
}));

function generationWith(plugins: Array<{ id: string; status: "loaded" | "disabled" | "error" }>) {
  return {
    pluginRegistry: { plugins },
    pluginMetadataSnapshot: { workspaceDir: "/tmp/workspace" },
  } as never;
}

const input = {
  config: {},
  workspaceDir: "/tmp/workspace",
  runtimePluginSelections: [{ provider: "bailian-token-plan", modelId: "qwen3.7-max" }],
} as never;

describe("preparedPluginGenerationSupportsSelections", () => {
  it("treats a disabled plan plugin as a recorded outcome, like a failed load", () => {
    expect(
      preparedPluginGenerationSupportsSelections(
        generationWith([{ id: "qwen", status: "disabled" }]),
        input,
      ),
    ).toBe(true);
    expect(
      preparedPluginGenerationSupportsSelections(
        generationWith([{ id: "qwen", status: "error" }]),
        input,
      ),
    ).toBe(true);
  });

  it("still rejects a plan plugin that is absent from the registry", () => {
    expect(
      preparedPluginGenerationSupportsSelections(
        generationWith([{ id: "anthropic", status: "loaded" }]),
        input,
      ),
    ).toBe(false);
  });
});
