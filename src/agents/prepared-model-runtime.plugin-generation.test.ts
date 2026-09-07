import { describe, expect, it } from "vitest";
import { registryContainsRuntimePluginIds } from "../plugins/active-runtime-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRecord } from "../plugins/registry-types.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { preparedPluginGenerationSupportsSelections } from "./prepared-model-runtime.plugin-generation.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

function generationWith(plugins: PluginRecord[]) {
  return {
    pluginRegistry: { ...createEmptyPluginRegistry(), plugins },
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [{ id: "qwen", providers: ["bailian-token-plan"] }],
    }),
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  } satisfies PreparedModelRuntimePluginGeneration;
}

const input: PreparedModelRuntimeInput = {
  config: { plugins: { slots: { memory: "none" } } },
  agentDir: "/tmp/agent",
  workspaceDir: "/tmp/workspace",
  runtimePluginSelections: [
    { provider: "bailian-token-plan", modelId: "qwen3.7-max", runtime: "openclaw" },
  ],
};

describe("preparedPluginGenerationSupportsSelections", () => {
  it.each(["loaded", "disabled", "error"] as const)(
    "accepts a recorded %s outcome without changing runtime availability",
    (status) => {
      const plugin = createPluginRecord({
        id: "qwen",
        origin: "bundled",
        status,
        enabled: status !== "disabled",
        imported: status === "loaded",
      });
      const generation = generationWith([plugin]);
      const selectionInput = {
        ...input,
        config: {
          plugins: {
            ...input.config.plugins,
            entries: { qwen: { enabled: plugin.enabled } },
          },
        },
      };

      expect(preparedPluginGenerationSupportsSelections(generation, selectionInput)).toBe(true);
      expect(registryContainsRuntimePluginIds(generation.pluginRegistry, ["qwen"])).toBe(
        status === "loaded",
      );
    },
  );

  it("still rejects a plan plugin that is absent from the registry", () => {
    expect(preparedPluginGenerationSupportsSelections(generationWith([]), input)).toBe(false);
  });

  it("still rejects a loaded record whose runtime was not imported", () => {
    const generation = generationWith([
      createPluginRecord({ id: "qwen", origin: "bundled", status: "loaded", imported: false }),
    ]);

    expect(preparedPluginGenerationSupportsSelections(generation, input)).toBe(false);
  });
});
