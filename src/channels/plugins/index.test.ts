import { describe, expect, it } from "vitest";
import { CHANNEL_IDS } from "../registry.js";
import { listChannelPlugins } from "./index.js";

describe("channel plugin registry", () => {
  it("stays in sync with channel ids", () => {
    const pluginIds = listChannelPlugins()
      .map((plugin) => plugin.id)
      .slice()
      .sort();
    const channelIds = [...CHANNEL_IDS].slice().sort();
    expect(pluginIds).toEqual(channelIds);
  });
});
