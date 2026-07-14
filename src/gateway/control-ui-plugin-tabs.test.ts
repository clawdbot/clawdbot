import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginControlUiDescriptor } from "../plugins/host-hooks.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { listControlUiPluginTabs } from "./control-ui-plugin-tabs.js";

function tabDescriptor(
  overrides: Partial<PluginControlUiDescriptor> = {},
): PluginControlUiDescriptor {
  return {
    id: "logbook",
    surface: "tab",
    label: "Logbook",
    ...overrides,
  };
}

function activateDescriptors(
  entries: Array<{ pluginId: string; descriptor: PluginControlUiDescriptor }>,
): void {
  const registry = createTestRegistry([]);
  registry.controlUiDescriptors = entries.map((entry) => ({
    ...entry,
    source: `test:${entry.pluginId}`,
  }));
  setActivePluginRegistry(registry);
}

describe("listControlUiPluginTabs", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("projects only tab descriptors", () => {
    activateDescriptors([
      { pluginId: "logbook", descriptor: tabDescriptor() },
      { pluginId: "other", descriptor: tabDescriptor({ id: "run-panel", surface: "run" }) },
    ]);

    const tabs = listControlUiPluginTabs(["operator.admin"]);
    expect(tabs.map((tab) => tab.id)).toEqual(["logbook"]);
    expect(expectDefined(tabs[0], "tabs[0] test invariant").pluginId).toBe("logbook");
  });

  it("hides tabs whose required scopes are not granted", () => {
    activateDescriptors([
      {
        pluginId: "logbook",
        descriptor: tabDescriptor({ requiredScopes: ["operator.write"] }),
      },
      {
        pluginId: "adminy",
        descriptor: tabDescriptor({
          id: "adminy",
          label: "Admin",
          requiredScopes: ["operator.admin"],
        }),
      },
    ]);

    expect(listControlUiPluginTabs(["operator.read"])).toEqual([]);
    expect(listControlUiPluginTabs(["operator.write"]).map((tab) => tab.id)).toEqual(["logbook"]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.id)).toEqual([
      "adminy",
      "logbook",
    ]);
  });

  it("orders deterministically by order, label, then id", () => {
    activateDescriptors([
      { pluginId: "b", descriptor: tabDescriptor({ id: "beta", label: "Beta" }) },
      { pluginId: "a", descriptor: tabDescriptor({ id: "alpha", label: "Alpha", order: 5 }) },
      { pluginId: "c", descriptor: tabDescriptor({ id: "zed", label: "Beta" }) },
    ]);

    expect(listControlUiPluginTabs([]).map((tab) => tab.id)).toEqual(["beta", "zed", "alpha"]);
  });
});
