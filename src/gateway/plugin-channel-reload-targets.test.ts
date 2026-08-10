/**
 * Plugin channel reload target tests.
 */
import { describe, expect, it } from "vitest";
import {
  listChannelPluginConfigTargetIds,
  listRunningCommandCatalogChannelIds,
  pluginConfigTargetsChanged,
} from "./plugin-channel-reload-targets.js";

describe("plugin channel reload targets", () => {
  it("matches channel plugin config changes by owning plugin id", () => {
    const targets = listChannelPluginConfigTargetIds({
      channelId: "matrix",
      pluginId: "acme-chat",
      aliases: ["matrix-chat"],
    });

    expect(pluginConfigTargetsChanged(targets, ["plugins.entries.acme-chat.config.mode"])).toBe(
      true,
    );
    expect(pluginConfigTargetsChanged(targets, ["plugins.installs.acme-chat.source"])).toBe(true);
    expect(pluginConfigTargetsChanged(targets, ["plugins.entries.matrix.config.mode"])).toBe(true);
    expect(pluginConfigTargetsChanged(targets, ["plugins.entries.matrix-chat.enabled"])).toBe(true);
    expect(pluginConfigTargetsChanged(targets, ["plugins.entries.other.enabled"])).toBe(false);
  });

  it("selects only running command-catalog channels for plugin replacement", () => {
    const selected = listRunningCommandCatalogChannelIds(
      [
        { id: "discord", commands: { nativeCommandsAutoEnabled: true } },
        { id: "slack", commands: { nativeCommandsAutoEnabled: false } },
        { id: "telegram", commands: { nativeCommandsAutoEnabled: true } },
        { id: "signal" },
      ],
      {
        channels: {},
        channelAccounts: {
          discord: { default: { accountId: "default", running: true } },
          slack: { default: { accountId: "default", running: true } },
          telegram: { default: { accountId: "default", running: false } },
          signal: { default: { accountId: "default", running: true } },
        },
      },
    );

    expect([...selected]).toEqual(["discord", "slack"]);
  });
});
