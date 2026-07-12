import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { PluginControlUiDescriptor } from "../plugins/host-hooks.js";
import { projectControlUiPluginTabs } from "./control-ui-plugin-tabs.js";

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

describe("projectControlUiPluginTabs", () => {
  it("projects only tab descriptors", () => {
    const tabs = projectControlUiPluginTabs(
      [
        { pluginId: "logbook", descriptor: tabDescriptor() },
        { pluginId: "other", descriptor: tabDescriptor({ id: "run-panel", surface: "run" }) },
      ],
      ["operator.admin"],
    );
    expect(tabs.map((tab) => tab.id)).toEqual(["logbook"]);
    expect(expectDefined(tabs[0], "tabs[0] test invariant").pluginId).toBe("logbook");
  });

  it("hides tabs whose required scopes are not granted", () => {
    const entries = [
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
    ];
    expect(projectControlUiPluginTabs(entries, ["operator.read"])).toEqual([]);
    // Admin implies write for visibility.
    expect(projectControlUiPluginTabs(entries, ["operator.write"]).map((tab) => tab.id)).toEqual([
      "logbook",
    ]);
    expect(projectControlUiPluginTabs(entries, ["operator.admin"]).map((tab) => tab.id)).toEqual([
      "adminy",
      "logbook",
    ]);
  });

  it("orders deterministically by order, label, then id", () => {
    const tabs = projectControlUiPluginTabs(
      [
        { pluginId: "b", descriptor: tabDescriptor({ id: "beta", label: "Beta" }) },
        { pluginId: "a", descriptor: tabDescriptor({ id: "alpha", label: "Alpha", order: 5 }) },
        { pluginId: "c", descriptor: tabDescriptor({ id: "zed", label: "Beta" }) },
      ],
      [],
    );
    expect(tabs.map((tab) => tab.id)).toEqual(["beta", "zed", "alpha"]);
  });
});
