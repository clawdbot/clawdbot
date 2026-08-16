import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  channelSupportsThreadDelivery,
  getLoadedChannelThreadingAdapter,
  resolveChannelThreadAddressing,
} from "./thread-addressing.js";

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
    expect(getLoadedChannelThreadingAdapter("messagechat")?.threadAddressing).toBe("message");
  });
});

describe("channelSupportsThreadDelivery", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("stays false for missing channels and undeclared thread capability", () => {
    expect(channelSupportsThreadDelivery()).toBe(false);
    expect(channelSupportsThreadDelivery("missing")).toBe(false);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "plainchat",
          source: "test",
          plugin: createChannelTestPluginBase({ id: "plainchat" }),
        },
      ]),
    );
    expect(channelSupportsThreadDelivery("plainchat")).toBe(false);
  });

  it("reads declared thread capability from the loaded channel plugin", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "threadchat",
          source: "test",
          plugin: createChannelTestPluginBase({
            id: "threadchat",
            capabilities: { chatTypes: ["channel", "thread"], threads: true },
          }),
        },
      ]),
    );
    expect(channelSupportsThreadDelivery("threadchat")).toBe(true);
  });
});
