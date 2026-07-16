// Channel plugin blocker tests cover doctor diagnostics for blocked channel plugin setup.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as manifestRegistry from "../../../plugins/manifest-registry.js";
import {
  channelPluginBlockerHitToHealthFinding,
  collectConfiguredChannelPluginBlockerWarnings,
  isWarningBlockedByChannelPlugin,
  scanConfiguredChannelPluginBlockers,
} from "./channel-plugin-blockers.js";

describe("channel plugin blockers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no blockers when config and manifest env have no channel surfaces", () => {
    const registrySpy = vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    const hits = scanConfiguredChannelPluginBlockers({
      channels: {
        defaults: {
          groupPolicy: "disabled",
        },
      },
    });

    expect(hits).toStrictEqual([]);
    expect(registrySpy).toHaveBeenCalled();
  });

  it("reports external channel plugins that are installed but not explicitly enabled", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      channels: {
        discord: {
          enabled: true,
          token: "configured",
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "missing explicit enablement",
      },
    ]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.discord: channel is configured, but external plugin "discord" is installed without explicit trust. Add plugins.entries.discord.enabled=true. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
    expect(
      channelPluginBlockerHitToHealthFinding(expectDefined(hits[0], "hits[0] test invariant")),
    ).toEqual({
      checkId: "core/doctor/channel-plugin-blockers",
      severity: "warning",
      message:
        'channels.discord: channel is configured, but external plugin "discord" is installed without explicit trust. Add plugins.entries.discord.enabled=true. Fix plugin enablement before relying on setup guidance for this channel.',
      path: "channels.discord",
      target: "discord",
      requirement: "missing explicit enablement",
      fixHint: "Fix plugin enablement before relying on setup guidance for this channel.",
    });
  });

  it("uses provided manifest records without loading the registry", () => {
    const registrySpy = vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    const hits = scanConfiguredChannelPluginBlockers(
      {
        channels: {
          discord: {
            token: "configured",
          },
        },
      },
      {},
      {},
      {
        manifestRecords: [
          {
            id: "discord",
            origin: "global",
            channels: ["discord"],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            enabledByDefault: false,
            rootDir: "/plugins/discord",
            source: "test",
            manifestPath: "/plugins/discord/plugin.json",
          },
        ],
      },
    );

    expect(registrySpy).not.toHaveBeenCalled();
    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("reports blockers for enabled-only channel intent", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        enabled: false,
      },
      channels: {
        discord: {
          enabled: true,
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "plugins disabled",
      },
    ]);
  });

  it("normalizes explicit channel ids before matching plugin owners", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      channels: {
        Discord: {
          enabled: true,
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("accepts plugins.allow as explicit trust for external channel plugins", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        allow: ["discord"],
      },
      channels: {
        discord: {
          enabled: true,
          token: "configured",
        },
      },
    });

    expect(hits).toStrictEqual([]);
  });

  it("diagnoses trust from the pre-auto-enable config", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const channels = {
      discord: {
        enabled: true,
        token: "configured",
      },
    };
    const hits = scanConfiguredChannelPluginBlockers(
      {
        channels,
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
      },
      process.env,
      { channels },
    );

    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("uses effective config for preferOver fallback disablement", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "legacy-chat",
          origin: "bundled",
          channels: ["legacy-chat"],
          enabledByDefault: true,
        },
        {
          id: "modern-chat",
          origin: "config",
          channels: ["legacy-chat"],
          enabledByDefault: false,
          channelConfigs: {
            "legacy-chat": {
              schema: { type: "object" },
              preferOver: ["legacy-chat"],
            },
          },
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const channels = {
      "legacy-chat": {
        token: "configured",
      },
    };
    const hits = scanConfiguredChannelPluginBlockers(
      {
        channels,
        plugins: {
          entries: {
            "legacy-chat": { enabled: false },
            "modern-chat": { enabled: true },
          },
        },
      },
      process.env,
      { channels },
    );

    expect(hits).toEqual([
      {
        channelId: "legacy-chat",
        pluginId: "modern-chat",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("diagnoses an env-only channel whose preferred external owner lacks trust", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "telegram",
          origin: "bundled",
          channels: ["telegram"],
          enabledByDefault: true,
        },
        {
          id: "modern-telegram",
          origin: "config",
          channels: ["telegram"],
          enabledByDefault: false,
          channelConfigs: {
            telegram: {
              schema: { type: "object" },
              preferOver: ["telegram"],
            },
          },
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        plugins: {
          entries: {
            telegram: { enabled: false },
            "modern-telegram": { enabled: true },
          },
        },
      },
      {
        TELEGRAM_BOT_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
      {},
    );

    expect(hits).toEqual([
      {
        channelId: "telegram",
        pluginId: "modern-telegram",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("diagnoses an external-only manifest env channel that lacks source trust", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          channelEnvVars: {
            discord: ["DISCORD_BOT_TOKEN"],
          },
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
      },
      {
        DISCORD_BOT_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
      {},
    );

    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("keeps manifest env trust diagnostics scoped to the declaring owner", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "bundled-chat",
          origin: "bundled",
          channels: ["shared-chat"],
          enabledByDefault: true,
        },
        {
          id: "external-chat",
          origin: "config",
          channels: ["shared-chat"],
          channelEnvVars: {
            "shared-chat": ["EXTERNAL_CHAT_TOKEN"],
          },
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        plugins: {
          entries: {
            "external-chat": { enabled: true },
          },
        },
      },
      {
        EXTERNAL_CHAT_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
      {},
    );

    expect(hits).toEqual([
      {
        channelId: "shared-chat",
        pluginId: "external-chat",
        reason: "missing explicit enablement",
        channelAvailable: true,
      },
    ]);
  });

  it("preserves channel-wide warnings when only a co-owner is blocked", () => {
    expect(
      isWarningBlockedByChannelPlugin("channels.shared-chat.groupPolicy: warning", [
        {
          channelId: "shared-chat",
          pluginId: "external-chat",
          reason: "missing explicit enablement",
          channelAvailable: true,
        },
      ]),
    ).toBe(false);
    expect(
      isWarningBlockedByChannelPlugin("channels.shared-chat.groupPolicy: warning", [
        {
          channelId: "shared-chat",
          pluginId: "external-chat",
          reason: "missing explicit enablement",
        },
      ]),
    ).toBe(true);
  });

  it("accepts an available co-owner for the same manifest env trigger", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "bundled-chat",
          origin: "bundled",
          channels: ["shared-chat"],
          channelEnvVars: {
            "shared-chat": ["SHARED_CHAT_TOKEN"],
          },
          enabledByDefault: true,
        },
        {
          id: "external-chat",
          origin: "config",
          channels: ["shared-chat"],
          channelEnvVars: {
            "shared-chat": ["SHARED_CHAT_TOKEN"],
          },
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({}, {
      SHARED_CHAT_TOKEN: "configured",
    } as NodeJS.ProcessEnv);

    expect(hits).toStrictEqual([]);
  });

  it("deduplicates global plugin disablement across manifest env triggers", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "first-chat",
          origin: "config",
          channels: ["shared-chat"],
          channelEnvVars: {
            "shared-chat": ["FIRST_CHAT_TOKEN"],
          },
          enabledByDefault: false,
        },
        {
          id: "second-chat",
          origin: "config",
          channels: ["shared-chat"],
          channelEnvVars: {
            "shared-chat": ["SECOND_CHAT_TOKEN"],
          },
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        plugins: {
          enabled: false,
        },
      },
      {
        FIRST_CHAT_TOKEN: "configured",
        SECOND_CHAT_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
    );

    expect(hits).toEqual([
      {
        channelId: "shared-chat",
        pluginId: "first-chat",
        reason: "plugins disabled",
      },
    ]);
  });

  it("does not report unrelated blocked owners for a manifest env trigger", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "triggered-chat",
          origin: "config",
          channels: ["shared-chat"],
          channelEnvVars: {
            "shared-chat": ["TRIGGERED_CHAT_TOKEN"],
          },
          enabledByDefault: false,
        },
        {
          id: "unrelated-chat",
          origin: "config",
          channels: ["shared-chat"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({}, {
      TRIGGERED_CHAT_TOKEN: "configured",
    } as NodeJS.ProcessEnv);

    expect(hits).toEqual([
      {
        channelId: "shared-chat",
        pluginId: "triggered-chat",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("ignores manifest env mappings for channels the plugin does not own", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "external-chat",
          origin: "config",
          channels: ["external-chat"],
          channelEnvVars: {
            discord: ["EXTERNAL_CHAT_TOKEN"],
          },
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({}, {
      EXTERNAL_CHAT_TOKEN: "configured",
    } as NodeJS.ProcessEnv);

    expect(hits).toStrictEqual([]);
  });

  it("diagnoses a manifest env channel whose bundled owner is opt-in", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "twitch",
          origin: "bundled",
          channels: ["twitch"],
          channelEnvVars: {
            twitch: ["OPENCLAW_TWITCH_ACCESS_TOKEN"],
          },
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({}, {
      OPENCLAW_TWITCH_ACCESS_TOKEN: "configured",
    } as NodeJS.ProcessEnv);

    expect(hits).toEqual([
      {
        channelId: "twitch",
        pluginId: "twitch",
        reason: "not enabled",
      },
    ]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.twitch: channel is configured, but plugin "twitch" is installed but not enabled. Add plugins.entries.twitch.enabled=true. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("includes both actions for a bundled opt-in owner under a restrictive allowlist", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "twitch",
          origin: "bundled",
          channels: ["twitch"],
          channelEnvVars: {
            twitch: ["OPENCLAW_TWITCH_ACCESS_TOKEN"],
          },
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        plugins: {
          allow: ["browser"],
        },
      },
      {
        OPENCLAW_TWITCH_ACCESS_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
    );

    expect(hits).toEqual([
      {
        channelId: "twitch",
        pluginId: "twitch",
        reason: "not enabled and not in allowlist",
      },
    ]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.twitch: channel is configured, but plugin "twitch" is not enabled and is omitted from plugins.allow. Add plugins.entries.twitch.enabled=true and include "twitch" in plugins.allow. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("keeps manifest env blockers when another channel is explicitly configured", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          channelEnvVars: {
            discord: ["DISCORD_BOT_TOKEN"],
          },
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
      },
      {
        DISCORD_BOT_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
      {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    );

    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("honors explicit channel disablement over manifest env triggers", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          channelEnvVars: {
            discord: ["DISCORD_BOT_TOKEN"],
          },
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        channels: {
          discord: {
            enabled: false,
          },
        },
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
      },
      {
        DISCORD_BOT_TOKEN: "configured",
      } as NodeJS.ProcessEnv,
      {
        channels: {
          discord: {
            enabled: false,
          },
        },
      },
    );

    expect(hits).toStrictEqual([]);
  });

  it("accepts an auto-enabled bundled owner under a restrictive source allowlist", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "telegram-plugin",
          origin: "bundled",
          channels: ["telegram"],
          enabledByDefault: false,
        },
        {
          id: "untrusted-telegram",
          origin: "config",
          channels: ["telegram"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const channels = {
      telegram: {
        botToken: "configured",
      },
    };
    const hits = scanConfiguredChannelPluginBlockers(
      {
        channels,
        plugins: {
          allow: ["browser", "telegram-plugin"],
          entries: {
            "telegram-plugin": { enabled: true },
          },
        },
      },
      process.env,
      {
        channels,
        plugins: {
          allow: ["browser"],
        },
      },
    );

    expect(hits).toStrictEqual([]);
  });

  it("preserves explicit external trust across an auto-materialized allowlist", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const sourceConfig: OpenClawConfig = {
      channels: {
        discord: {
          enabled: true,
        },
      },
      plugins: {
        allow: ["browser"],
        entries: {
          discord: { enabled: true },
        },
      },
    };
    const hits = scanConfiguredChannelPluginBlockers(
      {
        ...sourceConfig,
        plugins: {
          ...sourceConfig.plugins,
          allow: ["browser", "discord"],
        },
      },
      process.env,
      sourceConfig,
    );

    expect(hits).toStrictEqual([]);
  });

  it("preserves explicit workspace trust across an auto-materialized allowlist", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "workspace-chat",
          origin: "workspace",
          channels: ["workspace-chat"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const sourceConfig: OpenClawConfig = {
      channels: {
        "workspace-chat": {
          enabled: true,
        },
      },
      plugins: {
        allow: ["browser"],
        entries: {
          "workspace-chat": { enabled: true },
        },
      },
    };
    const hits = scanConfiguredChannelPluginBlockers(
      {
        ...sourceConfig,
        plugins: {
          ...sourceConfig.plugins,
          allow: ["browser", "workspace-chat"],
        },
      },
      process.env,
      sourceConfig,
    );

    expect(hits).toStrictEqual([]);
  });

  it("accepts an env-auto-enabled bundled owner absent from the source config", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "telegram",
          origin: "bundled",
          channels: ["telegram"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          allow: ["browser", "telegram"],
        },
      },
      process.env,
      {
        plugins: {
          allow: ["browser"],
        },
      },
    );

    expect(hits).toStrictEqual([]);
  });

  it("reports external channel plugins omitted from a restrictive allowlist", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        allow: ["brave"],
      },
      channels: {
        discord: {
          enabled: true,
          token: "configured",
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "not in allowlist",
      },
    ]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.discord: channel is configured, but plugin "discord" is installed but omitted from plugins.allow. Include "discord" in plugins.allow. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("keeps blocker reasons scoped to each external owner", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "denied-chat",
          origin: "config",
          channels: ["shared-chat"],
          enabledByDefault: false,
        },
        {
          id: "untrusted-chat",
          origin: "config",
          channels: ["shared-chat"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        deny: ["denied-chat"],
      },
      channels: {
        "shared-chat": {
          token: "configured",
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "shared-chat",
        pluginId: "denied-chat",
        reason: "blocked by denylist",
      },
      {
        channelId: "shared-chat",
        pluginId: "untrusted-chat",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("reports a single channel owner blocked by plugins.deny", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "global",
          channels: ["discord"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        deny: ["discord"],
      },
      channels: {
        discord: {
          enabled: true,
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "discord",
        pluginId: "discord",
        reason: "blocked by denylist",
      },
    ]);
    expect(collectConfiguredChannelPluginBlockerWarnings(hits)).toEqual([
      '- channels.discord: channel is configured, but plugin "discord" is blocked by plugins.deny. Remove "discord" from plugins.deny. Fix plugin enablement before relying on setup guidance for this channel.',
    ]);
  });

  it("accepts workspace channel owners activated through a plugin slot", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "workspace-chat",
          origin: "workspace",
          channels: ["workspace-chat"],
          enabledByDefault: false,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        allow: ["browser"],
        slots: {
          contextEngine: "workspace-chat",
        },
      },
      channels: {
        "workspace-chat": {
          token: "configured",
        },
      },
    });

    expect(hits).toStrictEqual([]);
  });

  it("still evaluates configured channels when plugins are disabled globally", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "slack",
          origin: "bundled",
          channels: ["slack"],
          enabledByDefault: true,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        enabled: false,
      },
      channels: {
        slack: {
          accounts: {
            work: {
              allowFrom: ["alice"],
            },
          },
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "slack",
        pluginId: "slack",
        reason: "plugins disabled",
      },
    ]);
  });

  it("ignores ambient channel env when reporting plugin blockers", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "slack",
          origin: "bundled",
          channels: ["slack"],
          enabledByDefault: true,
        },
        {
          id: "telegram",
          origin: "bundled",
          channels: ["telegram"],
          enabledByDefault: true,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        plugins: {
          enabled: false,
        },
        channels: {
          telegram: {
            botToken: "configured",
          },
        },
      },
      {
        SLACK_BOT_TOKEN: "ambient",
      } as NodeJS.ProcessEnv,
    );

    expect(hits).toEqual([
      {
        channelId: "telegram",
        pluginId: "telegram",
        reason: "plugins disabled",
      },
    ]);
  });

  it("does not report a disabled bundled owner when a configured external plugin owns the channel", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "feishu",
          origin: "bundled",
          channels: ["feishu"],
          enabledByDefault: true,
        },
        {
          id: "openclaw-lark",
          origin: "config",
          channels: ["feishu"],
          enabledByDefault: false,
          channelConfigs: {
            feishu: {
              schema: {
                type: "object",
              },
            },
          },
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        entries: {
          feishu: {
            enabled: false,
          },
          "openclaw-lark": {
            enabled: true,
          },
        },
      },
      channels: {
        feishu: {
          footer: {
            model: false,
          },
        },
      },
    });

    expect(hits).toStrictEqual([]);
  });

  it("reports each blocked owner when no channel owner is active", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "feishu",
          origin: "bundled",
          channels: ["feishu"],
          enabledByDefault: true,
        },
        {
          id: "openclaw-lark",
          origin: "config",
          channels: ["feishu"],
          enabledByDefault: false,
          channelConfigs: {
            feishu: {
              schema: {
                type: "object",
              },
            },
          },
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        entries: {
          feishu: {
            enabled: false,
          },
        },
      },
      channels: {
        feishu: {
          footer: {
            model: false,
          },
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "feishu",
        pluginId: "feishu",
        reason: "disabled in config",
      },
      {
        channelId: "feishu",
        pluginId: "openclaw-lark",
        reason: "missing explicit enablement",
      },
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
