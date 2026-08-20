// Plugin uninstall selection tests cover CLI uninstall target matching.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginUninstallId } from "./plugins-uninstall-selection.js";

describe("resolvePluginUninstallId", () => {
  it("prefers an exact plugin id over an earlier plugin display name", () => {
    const alias = { id: "unrelated-plugin", name: "calendar" };
    const target = { id: "calendar", name: "Real Calendar" };

    const result = resolvePluginUninstallId({
      rawId: "calendar",
      config: {},
      plugins: [alias, target],
    });

    expect(result).toEqual({ ok: true, value: { pluginId: "calendar", plugin: target } });
  });

  it.each([
    { label: "an installed plugin", plugins: { installs: { calendar: { source: "npm" } } } },
    { label: "a stale plugin entry", plugins: { entries: { calendar: { enabled: true } } } },
    { label: "an allowlist entry", plugins: { allow: ["calendar"] } },
    { label: "a denylist entry", plugins: { deny: ["calendar"] } },
    { label: "the memory slot", plugins: { slots: { memory: "calendar" } } },
    { label: "the context-engine slot", plugins: { slots: { contextEngine: "calendar" } } },
  ])("prefers the exact id recorded by $label over a display-name alias", ({ plugins }) => {
    const alias = { id: "unrelated-plugin", name: "calendar" };

    const result = resolvePluginUninstallId({
      rawId: "calendar",
      config: { plugins } as OpenClawConfig,
      plugins: [alias],
    });

    expect(result).toEqual({ ok: true, value: { pluginId: "calendar" } });
  });

  it("rejects an ambiguous plugin display name", () => {
    const result = resolvePluginUninstallId({
      rawId: "calendar",
      config: {},
      plugins: [
        { id: "calendar-one", name: "calendar" },
        { id: "calendar-two", name: "calendar" },
      ],
    });

    expect(result).toEqual({
      ok: false,
      error:
        'Plugin uninstall target "calendar" is ambiguous; matches: calendar-one, calendar-two. Use an exact plugin id.',
    });
  });

  it("rejects a package alias shared by multiple installed plugins", () => {
    const result = resolvePluginUninstallId({
      rawId: "@scope/calendar",
      config: {
        plugins: {
          installs: {
            "calendar-one": { source: "npm", resolvedName: "@scope/calendar" },
            "calendar-two": { source: "npm", resolvedName: "@scope/calendar" },
          },
        },
      } as OpenClawConfig,
      plugins: [],
    });

    expect(result).toEqual({
      ok: false,
      error:
        'Plugin uninstall target "@scope/calendar" is ambiguous; matches: calendar-one, calendar-two. Use an exact plugin id.',
    });
  });

  it("rejects a ClawHub alias shared by multiple installed plugins", () => {
    const result = resolvePluginUninstallId({
      rawId: "clawhub:calendar",
      config: {
        plugins: {
          installs: {
            "calendar-one": { source: "npm", spec: "clawhub:calendar@1.0.0" },
            "calendar-two": { source: "npm", clawhubPackage: "calendar" },
          },
        },
      } as OpenClawConfig,
      plugins: [],
    });

    expect(result).toEqual({
      ok: false,
      error:
        'Plugin uninstall target "clawhub:calendar" is ambiguous; matches: calendar-one, calendar-two. Use an exact plugin id.',
    });
  });

  it("deduplicates display and package aliases owned by the same plugin", () => {
    const plugin = { id: "calendar-owner", name: "calendar" };

    const result = resolvePluginUninstallId({
      rawId: "calendar",
      config: {
        plugins: {
          installs: {
            "calendar-owner": { source: "npm", resolvedName: "calendar" },
          },
        },
      } as OpenClawConfig,
      plugins: [plugin],
    });

    expect(result).toEqual({
      ok: true,
      value: { pluginId: "calendar-owner", plugin },
    });
  });

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

    expect(result).toEqual({
      ok: true,
      value: { pluginId: "linkmind-context", plugin },
    });
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

    expect(result).toEqual({
      ok: true,
      value: { pluginId: "linkmind-context", plugin },
    });
  });
});
