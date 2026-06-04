/**
 * Tests channel message helper behavior and mocked runtime interactions.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defineChannelMessageAdapter as defineCoreChannelMessageAdapter } from "../channels/message/index.js";
import { defineChannelMessageAdapter } from "./channel-outbound.js";

describe("defineChannelMessageAdapter", () => {
  const loadPluginSdkSubpaths = async () =>
    await Promise.all([
      import("openclaw/plugin-sdk/channel-outbound"),
      import("openclaw/plugin-sdk/channel-message"),
      import("openclaw/plugin-sdk/channel-message-runtime"),
      import("openclaw/plugin-sdk/channel-reply-pipeline"),
      import("openclaw/plugin-sdk/compat"),
    ] as const);
  let pluginSdkSubpaths: Awaited<ReturnType<typeof loadPluginSdkSubpaths>>;

  beforeAll(async () => {
    pluginSdkSubpaths = await loadPluginSdkSubpaths();
  });

  it("keeps new and legacy channel plugin SDK subpaths importable", async () => {
    const [channelOutbound, channelMessage, channelMessageRuntime, channelReplyPipeline, compat] =
      pluginSdkSubpaths;

    expect(channelOutbound.createChannelMessageReplyPipeline).toBe(
      channelReplyPipeline.createChannelReplyPipeline,
    );
    expect(channelMessage.createChannelMessageReplyPipeline).toBe(
      channelOutbound.createChannelMessageReplyPipeline,
    );
    expect(channelMessage.createReplyPrefixOptions).toBe(
      channelReplyPipeline.createReplyPrefixOptions,
    );
    expect(channelMessage.createTypingCallbacks).toBe(channelReplyPipeline.createTypingCallbacks);
    expect(channelMessageRuntime.sendDurableMessageBatch).toBe(
      channelMessage.sendDurableMessageBatch,
    );
    expect(channelMessageRuntime.withDurableMessageSendContext).toBe(
      channelMessage.withDurableMessageSendContext,
    );
    expect(channelOutbound.defineChannelMessageAdapter).toBe(defineCoreChannelMessageAdapter);
    expect(compat.createChannelReplyPipeline).toBe(channelReplyPipeline.createChannelReplyPipeline);
  });

  it("defaults new message adapters to plugin-owned receive acknowledgement", () => {
    const adapter = defineChannelMessageAdapter({
      id: "demo",
      durableFinal: { capabilities: { text: true } },
      send: {
        text: vi.fn(async () => ({
          receipt: {
            primaryPlatformMessageId: "msg-1",
            platformMessageIds: ["msg-1"],
            parts: [],
            sentAt: 123,
          },
        })),
      },
    });

    expect(adapter.receive).toEqual({
      defaultAckPolicy: "manual",
      supportedAckPolicies: ["manual"],
    });
  });

  it("preserves explicit receive acknowledgement policy declarations", () => {
    const adapter = defineChannelMessageAdapter({
      id: "demo",
      receive: {
        defaultAckPolicy: "after_agent_dispatch",
        supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
      },
    });

    expect(adapter.receive).toEqual({
      defaultAckPolicy: "after_agent_dispatch",
      supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
    });
  });
});
