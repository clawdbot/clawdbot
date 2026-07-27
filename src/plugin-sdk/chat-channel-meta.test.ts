/**
 * Regression tests for SDK chat channel metadata resolution across bundled and
 * third-party plugin channels (openclaw/openclaw#114553).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { getChatChannelMeta } from "./core.js";

const emptyRegistry = createTestRegistry([]);

function createThirdPartyChannelPlugin(id: string, label: string): ChannelPlugin {
  return createChannelTestPluginBase({ id, label }) as ChannelPlugin;
}

describe("plugin-sdk getChatChannelMeta", () => {
  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("resolves metadata for bundled chat channels", () => {
    const meta = getChatChannelMeta("telegram");

    expect(meta.id).toBe("telegram");
    expect(meta.label).toBeTruthy();
  });

  it("resolves metadata for a registered third-party channel plugin", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "zulip",
          source: "test",
          plugin: createThirdPartyChannelPlugin("zulip", "Zulip"),
        },
      ]),
    );

    const meta = getChatChannelMeta("zulip");

    expect(meta.id).toBe("zulip");
    expect(meta.label).toBe("Zulip");
  });

  it("still throws a clear error for unknown channel ids", () => {
    expect(() => getChatChannelMeta("no-such-channel")).toThrow(
      "expected chat channel metadata: no-such-channel to be defined",
    );
  });
});
