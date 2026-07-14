import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

describe("plugin readiness registration", () => {
  it("namespaces criteria and keeps duplicate registration idempotent", () => {
    const pluginRegistry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "storage",
      name: "Storage",
      source: "/plugins/storage/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, {
      config: {} as OpenClawConfig,
      pluginConfig: { endpoint: "https://storage.example" },
    });
    const criterion = {
      id: "backend",
      description: "Reports storage backend availability.",
      check: () => ({ status: "True" as const, reason: "Ready", message: "Ready." }),
    };

    api.registerReadinessCriterion(criterion);
    api.registerReadinessCriterion(criterion);

    expect(pluginRegistry.registry.readinessCriteria).toEqual([
      expect.objectContaining({
        id: "plugin.storage.backend",
        pluginId: "storage",
        criterion: expect.objectContaining({
          description: "Reports storage backend availability.",
        }),
        pluginConfig: { endpoint: "https://storage.example" },
      }),
    ]);
  });
});
