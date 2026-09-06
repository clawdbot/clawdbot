import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { WidgetPresenter } from "./plugin-registration.types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-fixtures.js";
import {
  adoptRuntimeWidgetPresenterRegistrations,
  resolveWidgetPresenters,
} from "./widget-presenters.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function currentPresenter(description: string): WidgetPresenter {
  return {
    target: "current_channel",
    description,
    capabilities: { sourceKinds: ["html"] },
    match: () => true,
    availability: async () => ({ ok: true, value: { available: true } }),
    present: async () => ({
      ok: false,
      error: { code: "unavailable", message: "not used" },
    }),
  };
}

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

  it("allows multiple contextual presenters while keeping explicit targets unique", () => {
    const { config, registry } = createPluginRegistryFixture();
    for (const id of ["discord-presenter", "slack-presenter"]) {
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({ id }),
        register(api) {
          api.registerWidgetPresenter({
            target: "current_channel",
            description: `Present through ${id}`,
            capabilities: { sourceKinds: ["html"] },
            match: (context) => context.messageChannel === id.split("-")[0],
            availability: async () => ({ ok: true, value: { available: true } }),
            present: async () => ({
              ok: false,
              error: { code: "unavailable", message: "not used" },
            }),
          });
        },
      });
    }

    expect(registry.registry.widgetPresenters.map(({ pluginId }) => pluginId)).toEqual([
      "discord-presenter",
      "slack-presenter",
    ]);
    expect(registry.registry.diagnostics).toEqual([]);
  });

  it("adopts full-only presenters only from the matching lifecycle owner", () => {
    const source = "/tmp/discord/index.ts";
    const target = createEmptyPluginRegistry();
    const runtime = createEmptyPluginRegistry();
    target.plugins.push(createPluginRecord({ id: "discord", source }));
    runtime.plugins.push(createPluginRecord({ id: "discord", source }));
    runtime.widgetPresenters.push({
      pluginId: "discord",
      presenter: currentPresenter("Runtime Discord"),
      source,
    });

    const adopted = adoptRuntimeWidgetPresenterRegistrations(target, runtime);
    expect(adopted.widgetPresenters).toEqual(runtime.widgetPresenters);

    target.plugins[0] = createPluginRecord({ id: "discord", source: "/tmp/other/index.ts" });
    expect(adoptRuntimeWidgetPresenterRegistrations(target, runtime)).toBe(target);
  });

  it("keeps request-scoped presenters ahead of the active lifecycle registry", () => {
    const active = createEmptyPluginRegistry();
    const scoped = createEmptyPluginRegistry();
    active.widgetPresenters.push({
      pluginId: "active",
      presenter: currentPresenter("Active"),
      source: "/tmp/active/index.ts",
    });
    scoped.widgetPresenters.push({
      pluginId: "scoped",
      presenter: currentPresenter("Scoped"),
      source: "/tmp/scoped/index.ts",
    });
    setActivePluginRegistry(active);

    expect(
      withPluginRuntimeRegistryScope(scoped, () =>
        resolveWidgetPresenters().map(({ pluginId }) => pluginId),
      ),
    ).toEqual(["scoped"]);
  });
});
