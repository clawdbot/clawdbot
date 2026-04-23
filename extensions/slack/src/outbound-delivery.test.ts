import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTestHook,
  createEmptyPluginRegistry,
  createOutboundTestPlugin,
  createTestRegistry,
  deliverOutboundPayloads,
  initializeGlobalHookRunner,
  releasePinnedPluginChannelRegistry,
  resetGlobalHookRunner,
  setActivePluginRegistry,
  type PluginHookRegistration,
} from "../../../test/helpers/plugins/outbound-delivery.js";
import { slackOutbound } from "./outbound-adapter.js";
import type { OpenClawConfig } from "./runtime-api.js";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

vi.mock("./send.runtime.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

const cfg: OpenClawConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      accounts: {
        default: {
          botToken: "xoxb-default",
          appToken: "xapp-default",
        },
      },
    },
  },
};

describe("slack outbound shared hook wiring", () => {
  beforeEach(() => {
    sendMessageSlackMock.mockReset();
    sendMessageSlackMock.mockResolvedValue({ messageId: "m1", channelId: "C123" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: createOutboundTestPlugin({ id: "slack", outbound: slackOutbound }),
          source: "test",
        },
      ]),
    );
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetGlobalHookRunner();
    releasePinnedPluginChannelRegistry();
  });

  it("fires message_sending once with shared routing fields", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const handler = vi.fn().mockResolvedValue(undefined);
    addTestHook({
      registry: hookRegistry,
      pluginId: "thread-ownership",
      hookName: "message_sending",
      handler: handler as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);

    await deliverOutboundPayloads({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "hello" }],
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "C123",
        content: "hello",
        replyToId: "1712000000.000001",
      }),
      expect.objectContaining({
        channelId: "slack",
        accountId: "default",
        conversationId: "C123",
      }),
    );
    expect(sendMessageSlackMock).toHaveBeenCalledTimes(1);
  });

  it("respects cancel from the shared hook without a second adapter pass", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const handler = vi.fn().mockResolvedValue({ cancel: true });
    addTestHook({
      registry: hookRegistry,
      pluginId: "thread-ownership",
      hookName: "message_sending",
      handler: handler as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);

    const result = await deliverOutboundPayloads({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "hello" }],
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendMessageSlackMock).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
