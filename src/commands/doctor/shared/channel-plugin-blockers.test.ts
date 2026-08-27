// Channel plugin blocker tests cover doctor diagnostics for blocked channel plugin setup.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as manifestRegistry from "../../../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import {
  channelPluginBlockerHitToHealthFinding,
  collectConfiguredChannelPluginBlockerWarnings,
  isWarningBlockedByChannelPlugin,
  scanConfiguredChannelPluginBlockers,
} from "./channel-plugin-blockers.js";

function createPackageChannelEnv(channelId: string, envVars: string[]) {
  return {
    id: channelId,
    configuredState: { env: { anyOf: envVars } },
  };
}

function plugin(
  id: string,
  options: {
    origin?: "bundled" | "config" | "global" | "workspace";
    channelId?: string;
    enabledByDefault?: boolean;
    [key: string]: unknown;
  } = {},
) {
  const { origin = "global", channelId = id, enabledByDefault = false, ...metadata } = options;
  const rootDir = `/plugins/${id}`;
  return {
    id,
    origin,
    channels: [channelId],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    enabledByDefault,
    rootDir,
    source: `${rootDir}/index.ts`,
    manifestPath: `${rootDir}/openclaw.plugin.json`,
    ...metadata,
  };
}

function mockManifestPlugins(plugins: unknown[]) {
  vi.spyOn(manifestRegistry, "loadPluginManifestRegistryCore").mockReturnValue({
    plugins,
    diagnostics: [],
  } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistryCore>);
}

describe("channel plugin blockers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
  });

  it("returns no blockers when config and package env have no channel surfaces", () => {
    const registrySpy = vi
      .spyOn(manifestRegistry, "loadPluginManifestRegistryCore")
      .mockReturnValue({
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
    mockManifestPlugins([plugin("discord")]);

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
    const registrySpy = vi
      .spyOn(manifestRegistry, "loadPluginManifestRegistryCore")
      .mockReturnValue({
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
    mockManifestPlugins([plugin("discord")]);

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
    mockManifestPlugins([plugin("discord")]);

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
    mockManifestPlugins([plugin("discord")]);

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
    mockManifestPlugins([plugin("discord")]);

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
    mockManifestPlugins([
      plugin("legacy-chat", { origin: "bundled", enabledByDefault: true }),
      plugin("modern-chat", {
        origin: "config",
        channelId: "legacy-chat",
        channelConfigs: {
          "legacy-chat": {
            schema: { type: "object" },
            preferOver: ["legacy-chat"],
          },
        },
      }),
    ]);

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
    mockManifestPlugins([
      plugin("telegram", { origin: "bundled", enabledByDefault: true }),
      plugin("modern-telegram", {
        origin: "config",
        channelId: "telegram",
        channelConfigs: {
          telegram: {
            schema: { type: "object" },
            preferOver: ["telegram"],
          },
        },
      }),
    ]);

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

  it("diagnoses an external-only package env channel that lacks source trust", () => {
    mockManifestPlugins([
      plugin("discord", {
        packageChannel: createPackageChannelEnv("discord", ["DISCORD_BOT_TOKEN"]),
      }),
    ]);

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

  it("suppresses ambient-only package env blockers for gateway startup", () => {
    mockManifestPlugins([
      plugin("discord", {
        packageChannel: createPackageChannelEnv("discord", ["DISCORD_FAKE_TEST_TRIGGER"]),
      }),
    ]);

    expect(
      scanConfiguredChannelPluginBlockers(
        {},
        { DISCORD_FAKE_TEST_TRIGGER: "configured" } as NodeJS.ProcessEnv,
        {},
        { ambientEnvTriggers: "suppress" },
      ),
    ).toStrictEqual([]);
  });

  it("requires every package channel allOf environment variable", () => {
    mockManifestPlugins([
      plugin("irc", {
        packageChannel: {
          id: "irc",
          configuredState: { env: { allOf: ["IRC_HOST", "IRC_NICK"] } },
        },
      }),
    ]);

    expect(
      scanConfiguredChannelPluginBlockers({}, { IRC_HOST: "configured" } as NodeJS.ProcessEnv),
    ).toStrictEqual([]);
    expect(
      scanConfiguredChannelPluginBlockers({}, {
        IRC_HOST: "configured",
        IRC_NICK: "configured",
      } as NodeJS.ProcessEnv),
    ).toEqual([
      {
        channelId: "irc",
        pluginId: "irc",
        reason: "missing explicit enablement",
      },
    ]);
  });

  it("keeps package env trust diagnostics scoped to the declaring owner", () => {
    mockManifestPlugins([
      plugin("bundled-chat", {
        origin: "bundled",
        channelId: "shared-chat",
        enabledByDefault: true,
      }),
      plugin("external-chat", {
        origin: "config",
        channelId: "shared-chat",
        packageChannel: createPackageChannelEnv("shared-chat", ["EXTERNAL_CHAT_TOKEN"]),
      }),
    ]);

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

  it("accepts an available co-owner for the same package env trigger", () => {
    mockManifestPlugins([
      plugin("bundled-chat", {
        origin: "bundled",
        channelId: "shared-chat",
        packageChannel: createPackageChannelEnv("shared-chat", ["SHARED_CHAT_TOKEN"]),
        enabledByDefault: true,
      }),
      plugin("external-chat", {
        origin: "config",
        channelId: "shared-chat",
        packageChannel: createPackageChannelEnv("shared-chat", ["SHARED_CHAT_TOKEN"]),
      }),
    ]);

    const hits = scanConfiguredChannelPluginBlockers({}, {
      SHARED_CHAT_TOKEN: "configured",
    } as NodeJS.ProcessEnv);

    expect(hits).toStrictEqual([]);
  });

  it("deduplicates global plugin disablement across package env triggers", () => {
    mockManifestPlugins([
      plugin("first-chat", {
        origin: "config",
        channelId: "shared-chat",
        packageChannel: createPackageChannelEnv("shared-chat", ["FIRST_CHAT_TOKEN"]),
      }),
      plugin("second-chat", {
        origin: "config",
        channelId: "shared-chat",
        packageChannel: createPackageChannelEnv("shared-chat", ["SECOND_CHAT_TOKEN"]),
      }),
    ]);

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

  it("does not report unrelated blocked owners for a package env trigger", () => {
    mockManifestPlugins([
      plugin("triggered-chat", {
        origin: "config",
        channelId: "shared-chat",
        packageChannel: createPackageChannelEnv("shared-chat", ["TRIGGERED_CHAT_TOKEN"]),
      }),
      plugin("unrelated-chat", { origin: "config", channelId: "shared-chat" }),
    ]);

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

  it("ignores package env mappings for channels the plugin does not own", () => {
    mockManifestPlugins([
      plugin("external-chat", {
        origin: "config",
        packageChannel: createPackageChannelEnv("discord", ["EXTERNAL_CHAT_TOKEN"]),
      }),
    ]);

    const hits = scanConfiguredChannelPluginBlockers({}, {
      EXTERNAL_CHAT_TOKEN: "configured",
    } as NodeJS.ProcessEnv);

    expect(hits).toStrictEqual([]);
  });

  it("diagnoses a package env channel whose bundled owner is opt-in", () => {
    mockManifestPlugins([
      plugin("twitch", {
        origin: "bundled",
        packageChannel: createPackageChannelEnv("twitch", ["OPENCLAW_TWITCH_ACCESS_TOKEN"]),
      }),
    ]);

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
    mockManifestPlugins([
      plugin("twitch", {
        origin: "bundled",
        packageChannel: createPackageChannelEnv("twitch", ["OPENCLAW_TWITCH_ACCESS_TOKEN"]),
      }),
    ]);

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

  it("keeps package env blockers when another channel is explicitly configured", () => {
    mockManifestPlugins([
      plugin("discord", {
        packageChannel: createPackageChannelEnv("discord", ["DISCORD_BOT_TOKEN"]),
      }),
    ]);

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

  it("honors explicit channel disablement over package env triggers", () => {
    mockManifestPlugins([
      plugin("discord", {
        packageChannel: createPackageChannelEnv("discord", ["DISCORD_BOT_TOKEN"]),
      }),
    ]);

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
    mockManifestPlugins([
      plugin("telegram-plugin", { origin: "bundled", channelId: "telegram" }),
      plugin("untrusted-telegram", { origin: "config", channelId: "telegram" }),
    ]);

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
    mockManifestPlugins([plugin("discord")]);

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
    mockManifestPlugins([
      plugin("workspace-chat", { origin: "workspace", channelId: "workspace-chat" }),
    ]);

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
    mockManifestPlugins([plugin("telegram", { origin: "bundled", channelId: "telegram" })]);

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
    mockManifestPlugins([plugin("discord")]);

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
    mockManifestPlugins([
      plugin("denied-chat", { origin: "config", channelId: "shared-chat" }),
      plugin("untrusted-chat", { origin: "config", channelId: "shared-chat" }),
    ]);

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
    mockManifestPlugins([plugin("discord")]);

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
    mockManifestPlugins([
      plugin("workspace-chat", { origin: "workspace", channelId: "workspace-chat" }),
    ]);

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
    mockManifestPlugins([plugin("slack", { origin: "bundled", enabledByDefault: true })]);

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
    mockManifestPlugins([
      plugin("slack", { origin: "bundled", enabledByDefault: true }),
      plugin("telegram", { origin: "bundled", enabledByDefault: true }),
    ]);

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
    mockManifestPlugins([
      plugin("feishu", { origin: "bundled", enabledByDefault: true }),
      plugin("openclaw-lark", {
        origin: "config",
        channelId: "feishu",
        channelConfigs: {
          feishu: {
            schema: {
              type: "object",
            },
          },
        },
      }),
    ]);

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
    mockManifestPlugins([
      plugin("feishu", { origin: "bundled", enabledByDefault: true }),
      plugin("openclaw-lark", {
        origin: "config",
        channelId: "feishu",
        channelConfigs: {
          feishu: {
            schema: {
              type: "object",
            },
          },
        },
      }),
    ]);

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
