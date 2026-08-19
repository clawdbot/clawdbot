import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import type { WidgetPresenter } from "./plugin-registration.types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

describe("plugin widget presenter registry", () => {
  it("registers one presenter for a target and rejects a competing owner", () => {
    const { config, registry } = createPluginRegistryFixture();
    const presenter: WidgetPresenter = {
      target: "node_panel" as const,
      description: "Show on a connected device panel",
      availability: async () => ({ ok: true, value: { available: true } }),
      present: async () => ({
        ok: false,
        error: { code: "no_eligible_node", message: "none" },
      }),
    };
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "first-presenter" }),
      register(api) {
        api.registerWidgetPresenter(presenter);
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "second-presenter" }),
      register(api) {
        api.registerWidgetPresenter(presenter);
      },
    });

    expect(registry.registry.widgetPresenters).toEqual([
      expect.objectContaining({ pluginId: "first-presenter", presenter }),
    ]);
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: "second-presenter",
        message: "widget presenter already registered for node_panel (first-presenter)",
      }),
    );
  });
});
