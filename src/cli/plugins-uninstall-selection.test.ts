// Plugin uninstall selection tests cover CLI uninstall target matching.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginUninstallId } from "./plugins-uninstall-selection.js";

describe("resolvePluginUninstallId", () => {
  it("accepts the recorded ClawHub spec as an uninstall target", () => {
    const plugin = {
      id: "linkmind-context",
      name: "linkmind-context",
      channelIds: ["linkmind-channel"],
    };
    const result = resolvePluginUninstallId({
      rawId: "clawhub:linkmind-context",
      config: {
        plugins: {
          entries: {
            "linkmind-context": { enabled: true },
          },
          installs: {
            "linkmind-context": {
              source: "npm",
              spec: "clawhub:linkmind-context",
              clawhubPackage: "linkmind-context",
            },
          },
        },
      } as OpenClawConfig,
      plugins: [plugin],
    });

    expect(result.pluginId).toBe("linkmind-context");
    expect(result.plugin).toBe(plugin);
  });

  it("accepts a versionless ClawHub spec when the install was pinned", () => {
    const plugin = {
      id: "linkmind-context",
      name: "linkmind-context",
      channelIds: ["linkmind-channel"],
    };
    const result = resolvePluginUninstallId({
      rawId: "clawhub:linkmind-context",
      config: {
        plugins: {
          entries: {
            "linkmind-context": { enabled: true },
          },
          installs: {
            "linkmind-context": {
              source: "npm",
              spec: "clawhub:linkmind-context@1.2.3",
            },
          },
        },
      } as OpenClawConfig,
      plugins: [plugin],
    });

    expect(result.pluginId).toBe("linkmind-context");
    expect(result.plugin).toBe(plugin);
  });
});
