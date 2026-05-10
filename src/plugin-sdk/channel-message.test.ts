import { describe, expect, it, vi } from "vitest";
import { defineChannelMessageAdapter } from "./channel-message.js";

describe("defineChannelMessageAdapter", () => {
  it("keeps new and legacy channel plugin SDK subpaths importable", async () => {
    const [channelMessage, channelMessageRuntime, channelReplyPipeline, compat] = await Promise.all(
      [
        import("openclaw/plugin-sdk/channel-message"),
        import("openclaw/plugin-sdk/channel-message-runtime"),
        import("openclaw/plugin-sdk/channel-reply-pipeline"),
        import("openclaw/plugin-sdk/compat"),
      ],
    );

    expect(channelMessage.createChannelMessageReplyPipeline).toBe(
      channelReplyPipeline.createChannelReplyPipeline,
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
