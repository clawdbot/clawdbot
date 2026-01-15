import { describe, expect, it } from "vitest";
import { CHANNEL_IDS } from "../registry.js";
import { listChannelPlugins } from "./index.js";

describe("channel plugin registry", () => {
  it("includes the built-in channel ids", () => {
    const pluginIds = listChannelPlugins().map((plugin) => plugin.id);
    for (const id of CHANNEL_IDS) {
      expect(pluginIds).toContain(id);
    }
  });
});
