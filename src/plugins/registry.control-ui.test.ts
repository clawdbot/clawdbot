// Control UI registry tests cover compatibility for plugin-declared descriptors.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./status.test-fixtures.js";

describe("plugin registry Control UI descriptors", () => {
  it("keeps legacy flat descriptors loadable for shipped JavaScript plugins", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "legacy-descriptor-fixture",
        name: "Legacy Descriptor Fixture",
      }),
      register(api) {
        api.registerControlUiDescriptor({
          id: "legacy-card",
          name: "Legacy Card",
          description: "Legacy descriptor from a JavaScript plugin",
        } as never);
      },
    });

    expect(registry.registry.controlUiDescriptors).toEqual([
      expect.objectContaining({
        pluginId: "legacy-descriptor-fixture",
        descriptor: expect.objectContaining({
          id: "legacy-card",
          surface: "session",
          label: "Legacy Card",
        }),
      }),
    ]);
  });

  it("accepts tab descriptors and normalizes their placement fields", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "tab-fixture", name: "Tab Fixture" }),
      register(api) {
        api.registerControlUiDescriptor({
          surface: "tab",
          id: "journal",
          label: "Journal",
          icon: "sun",
          group: "control",
          order: 5,
          requiredScopes: ["operator.read"],
        });
      },
    });

    expect(registry.registry.controlUiDescriptors).toEqual([
      expect.objectContaining({
        pluginId: "tab-fixture",
        descriptor: expect.objectContaining({
          id: "journal",
          surface: "tab",
          label: "Journal",
          icon: "sun",
          group: "control",
          order: 5,
          requiredScopes: ["operator.read"],
        }),
      }),
    ]);
  });

  it("accepts trusted dashboard widget descriptors", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "workboard", name: "Workboard" }),
      register(api) {
        api.session.controls.registerControlUiDescriptor({
          surface: "widget",
          id: "card",
          label: "Workboard card",
          requiredScopes: ["operator.read"],
        });
      },
    });

    expect(registry.registry.controlUiDescriptors).toEqual([
      expect.objectContaining({
        pluginId: "workboard",
        descriptor: expect.objectContaining({
          id: "card",
          surface: "widget",
          label: "Workboard card",
        }),
      }),
    ]);
  });

  it("rejects protocol-relative tab paths that would iframe external content", () => {
    for (const path of ["//attacker.example/panel", "/\\attacker.example/panel"]) {
      const { config, registry } = createPluginRegistryFixture();
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({ id: "external-tab", name: "External Tab" }),
        register(api) {
          api.registerControlUiDescriptor({
            surface: "tab",
            id: "journal",
            label: "Journal",
            path,
          });
        },
      });
      expect(registry.registry.controlUiDescriptors).toEqual([]);
      expect(registry.registry.diagnostics).toContainEqual(
        expect.objectContaining({ level: "error", pluginId: "external-tab" }),
      );
    }
  });

  it("rejects tab descriptors whose path is not absolute", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "bad-tab-fixture", name: "Bad Tab Fixture" }),
      register(api) {
        api.registerControlUiDescriptor({
          surface: "tab",
          id: "journal",
          label: "Journal",
          path: "relative/frame.html",
        });
      },
    });

    expect(registry.registry.controlUiDescriptors).toEqual([]);
    expect(registry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "bad-tab-fixture",
        message: expect.stringContaining("gateway-local absolute path"),
      }),
    );
  });
});
