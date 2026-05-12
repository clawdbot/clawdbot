import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";
import * as manifestRegistry from "../../../plugins/manifest-registry.js";
import {
  collectStalePluginConfigWarnings,
  maybeRepairStalePluginConfig,
  scanStalePluginConfig,
} from "./stale-plugin-config.js";

const installedPluginIndexMocks = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecordsSync: vi.fn<() => Record<string, PluginInstallRecord>>(
    () => ({}),
  ),
}));

vi.mock("../../../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecordsSync:
    installedPluginIndexMocks.loadInstalledPluginIndexInstallRecordsSync,
}));

function manifest(id: string): PluginManifestRecord {
  return {
    id,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/plugins/${id}`,
    source: `/plugins/${id}`,
    manifestPath: `/plugins/${id}/openclaw.plugin.json`,
  };
}

describe("doctor stale plugin config helpers", () => {
  beforeEach(() => {
    installedPluginIndexMocks.loadInstalledPluginIndexInstallRecordsSync.mockReset();
    installedPluginIndexMocks.loadInstalledPluginIndexInstallRecordsSync.mockReturnValue({});
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [manifest("discord"), manifest("voice-call"), manifest("openai")],
      diagnostics: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds stale plugin policy and entry refs", () => {
    const hits = scanStalePluginConfig({
      plugins: {
        allow: ["discord", "acpx"],
        deny: ["openai", "missing-deny"],
        entries: {
          "voice-call": { enabled: true },
          acpx: { enabled: true },
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([
      {
        pluginId: "acpx",
        pathLabel: "plugins.allow",
        surface: "allow",
      },
      {
        pluginId: "missing-deny",
        pathLabel: "plugins.deny",
        surface: "deny",
      },
      {
        pluginId: "acpx",
        pathLabel: "plugins.entries.acpx",
        surface: "entries",
      },
    ]);
  });

  it("removes stale plugin ids from policy lists and entries without changing valid refs", () => {
    const result = maybeRepairStalePluginConfig({
      plugins: {
        allow: ["discord", "acpx", "voice-call"],
        deny: ["openai", "missing-deny"],
        entries: {
          "voice-call": { enabled: true },
          acpx: { enabled: true },
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- plugins.allow: removed 1 stale plugin id (acpx)",
      "- plugins.deny: removed 1 stale plugin id (missing-deny)",
      "- plugins.entries: removed 1 stale plugin entry (acpx)",
    ]);
    expect(result.config.plugins?.allow).toEqual(["discord", "voice-call"]);
    expect(result.config.plugins?.deny).toEqual(["openai"]);
    expect(result.config.plugins?.entries).toEqual({
      "voice-call": { enabled: true },
    });
  });

  it("resets stale plugin slots without changing valid slot sentinels", () => {
    const cfg = {
      plugins: {
        slots: {
          memory: "acpx",
          contextEngine: "missing-engine",
        },
      },
    } as OpenClawConfig;

    const hits = scanStalePluginConfig(cfg);
    expect(hits).toEqual([
      {
        pluginId: "acpx",
        pathLabel: "plugins.slots.memory",
        surface: "slot",
        slotKey: "memory",
      },
      {
        pluginId: "missing-engine",
        pathLabel: "plugins.slots.contextEngine",
        surface: "slot",
        slotKey: "contextEngine",
      },
    ]);

    const result = maybeRepairStalePluginConfig(cfg);

    expect(result.changes).toEqual([
      "- plugins.slots: reset 2 stale plugin slots (memory: acpx -> memory-core, contextEngine: missing-engine -> legacy)",
    ]);
    expect(result.config.plugins?.slots).toEqual({
      memory: "memory-core",
      contextEngine: "legacy",
    });
  });

  it("does not report slot defaults or none as stale plugin refs", () => {
    expect(
      scanStalePluginConfig({
        plugins: {
          slots: {
            memory: "none",
            contextEngine: "legacy",
          },
        },
      } as OpenClawConfig),
    ).toStrictEqual([]);
  });

  it("formats stale plugin warnings with a doctor hint", () => {
    const warnings = collectStalePluginConfigWarnings({
      hits: [
        {
          pluginId: "acpx",
          pathLabel: "plugins.allow",
          surface: "allow",
        },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      '- plugins.allow: stale plugin reference "acpx" was found.',
      '- Run "openclaw doctor --fix" to remove stale plugin ids and dangling channel references.',
    ]);
  });

  it("keeps built-in channel ids in restrictive plugin config", () => {
    const result = maybeRepairStalePluginConfig({
      plugins: {
        allow: ["telegram", "whatsapp", "acpx"],
        deny: ["openai", "missing-deny"],
        entries: {
          telegram: { enabled: true },
          whatsapp: { enabled: true },
          acpx: { enabled: true },
        },
      },
      channels: {
        whatsapp: {
          enabled: true,
          allowFrom: ["+15555550123"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- plugins.allow: removed 1 stale plugin id (acpx)",
      "- plugins.deny: removed 1 stale plugin id (missing-deny)",
      "- plugins.entries: removed 1 stale plugin entry (acpx)",
    ]);
    expect(result.config.plugins?.allow).toEqual(["telegram", "whatsapp"]);
    expect(result.config.plugins?.deny).toEqual(["openai"]);
    expect(result.config.plugins?.entries).toEqual({
      telegram: { enabled: true },
      whatsapp: { enabled: true },
    });
    expect(result.config.channels?.whatsapp).toEqual({
      enabled: true,
      allowFrom: ["+15555550123"],
    });
  });

  it("removes stale third-party channel config and dependent channel refs", () => {
    const result = maybeRepairStalePluginConfig({
      plugins: {
        allow: ["discord", "missing-chat-plugin"],
        entries: {
          discord: { enabled: true },
          "missing-chat-plugin": { enabled: true },
        },
      },
      channels: {
        "missing-chat-plugin": {
          enabled: true,
          token: "stale",
        },
        telegram: {
          botToken: "keep",
        },
        modelByChannel: {
          openai: {
            "missing-chat-plugin": "openai/gpt-5.4",
            telegram: "openai/gpt-5.4",
          },
        },
      },
      agents: {
        defaults: {
          heartbeat: {
            target: "missing-chat-plugin",
            every: "30m",
          },
        },
        list: [
          {
            id: "pi",
            heartbeat: {
              target: "missing-chat-plugin",
            },
          },
          {
            id: "ops",
            heartbeat: {
              target: "telegram",
            },
          },
        ],
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- plugins.allow: removed 1 stale plugin id (missing-chat-plugin)",
      "- plugins.entries: removed 1 stale plugin entry (missing-chat-plugin)",
      "- channels: removed 1 stale channel config (missing-chat-plugin)",
      "- agents heartbeat: removed 2 stale heartbeat targets (missing-chat-plugin)",
      "- channels.modelByChannel: removed 1 stale channel model override (missing-chat-plugin)",
    ]);
    expect(result.config.plugins?.allow).toEqual(["discord"]);
    expect(result.config.plugins?.entries).toEqual({
      discord: { enabled: true },
    });
    expect(result.config.channels?.["missing-chat-plugin"]).toBeUndefined();
    expect(result.config.channels?.telegram).toEqual({ botToken: "keep" });
    expect(result.config.channels?.modelByChannel).toEqual({
      openai: {
        telegram: "openai/gpt-5.4",
      },
    });
    expect(result.config.agents?.defaults?.heartbeat).toEqual({ every: "30m" });
    expect(result.config.agents?.list?.[0]?.heartbeat).toStrictEqual({});
    expect(result.config.agents?.list?.[1]?.heartbeat).toEqual({ target: "telegram" });
  });

  it("does not remove unknown channel config without stale plugin evidence", () => {
    const cfg = {
      channels: {
        telegrm: {
          botToken: "typo",
        },
      },
    } as OpenClawConfig;

    expect(scanStalePluginConfig(cfg)).toStrictEqual([]);
    expect(maybeRepairStalePluginConfig(cfg)).toEqual({ config: cfg, changes: [] });
  });

  it("treats stale plugin refs as inert while plugins are globally disabled", () => {
    const cfg = {
      plugins: {
        enabled: false,
        allow: ["acpx"],
        entries: {
          acpx: { enabled: true },
        },
      },
      channels: {
        "openclaw-weixin": {
          enabled: true,
        },
      },
    } as OpenClawConfig;

    expect(scanStalePluginConfig(cfg)).toStrictEqual([]);
    expect(maybeRepairStalePluginConfig(cfg)).toEqual({ config: cfg, changes: [] });
    expect(manifestRegistry.loadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("uses missing persisted install records as stale channel evidence", () => {
    installedPluginIndexMocks.loadInstalledPluginIndexInstallRecordsSync.mockReturnValue({
      "missing-chat-plugin": {
        source: "npm",
        resolvedName: "@example/missing-chat-plugin",
        installedAt: "2026-04-12T00:00:00.000Z",
      },
    });

    const result = maybeRepairStalePluginConfig({
      channels: {
        "missing-chat-plugin": {
          enabled: true,
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- channels: removed 1 stale channel config (missing-chat-plugin)",
    ]);
    expect(result.config.channels?.["missing-chat-plugin"]).toBeUndefined();
  });

  it("does not auto-repair stale refs while plugin discovery has errors", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [],
      diagnostics: [
        { level: "error", message: "plugin path not found: /missing", source: "/missing" },
      ],
    });

    const cfg = {
      plugins: {
        allow: ["acpx"],
        entries: {
          acpx: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const hits = scanStalePluginConfig(cfg);
    expect(hits).toEqual([
      {
        pluginId: "acpx",
        pathLabel: "plugins.allow",
        surface: "allow",
      },
      {
        pluginId: "acpx",
        pathLabel: "plugins.entries.acpx",
        surface: "entries",
      },
    ]);

    const result = maybeRepairStalePluginConfig(cfg);
    expect(result.changes).toStrictEqual([]);
    expect(result.config).toEqual(cfg);

    const warnings = collectStalePluginConfigWarnings({
      hits,
      doctorFixCommand: "openclaw doctor --fix",
      autoRepairBlocked: true,
    });
    expect(warnings[2]).toContain("Auto-removal is paused");
  });

  it("treats legacy plugin aliases as valid ids during scan and repair", () => {
    const cfg = {
      plugins: {
        allow: ["openai-codex", "acpx"],
        entries: {
          "openai-codex": { enabled: true },
          acpx: { enabled: true },
        },
      },
    } as OpenClawConfig;

    expect(scanStalePluginConfig(cfg)).toEqual([
      {
        pluginId: "acpx",
        pathLabel: "plugins.allow",
        surface: "allow",
      },
      {
        pluginId: "acpx",
        pathLabel: "plugins.entries.acpx",
        surface: "entries",
      },
    ]);

    const result = maybeRepairStalePluginConfig(cfg);
    expect(result.config.plugins?.allow).toEqual(["openai-codex"]);
    expect(result.config.plugins?.entries).toEqual({
      "openai-codex": { enabled: true },
    });
  });
});
