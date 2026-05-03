import { describe, expect, it } from "vitest";
import {
  listChannelPluginConfigTargetIds,
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
});
