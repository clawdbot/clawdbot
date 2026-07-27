import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveChannelThreadAddressing } from "./thread-addressing.js";

describe("resolveChannelThreadAddressing", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("defaults missing channel metadata to address-scoped threads", () => {
    expect(resolveChannelThreadAddressing()).toBe("address");
    expect(resolveChannelThreadAddressing("missing")).toBe("address");
  });

  it("reads message-scoped thread identity from the loaded channel plugin", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "messagechat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "messagechat" }),
            threading: { threadAddressing: "message" },
          },
        },
      ]),
    );

    expect(resolveChannelThreadAddressing("messagechat")).toBe("message");
  });
});
