/**
 * Tests channel message helper behavior and mocked runtime interactions.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defineChannelMessageAdapter as defineCoreChannelMessageAdapter } from "../channels/message/index.js";
import {
  defineChannelMessageAdapter,
  type ChannelMessageDurableFinalAdapter,
} from "./channel-outbound.js";

describe("defineChannelMessageAdapter", () => {
  const loadPluginSdkSubpaths = async () =>
    await Promise.all([
      import("openclaw/plugin-sdk/channel-outbound"),
      import("openclaw/plugin-sdk/channel-message"),
      import("openclaw/plugin-sdk/channel-reply-pipeline"),
    ] as const);
  let pluginSdkSubpaths: Awaited<ReturnType<typeof loadPluginSdkSubpaths>>;

  beforeAll(async () => {
    pluginSdkSubpaths = await loadPluginSdkSubpaths();
  });

  it("keeps channel plugin SDK subpaths aligned", async () => {
    const [channelOutbound, channelMessage, channelReplyPipeline] = pluginSdkSubpaths;

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
    expect(channelOutbound.defineChannelMessageAdapter).toBe(defineCoreChannelMessageAdapter);
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

  it("exposes the synchronous deferred-delivery admission contract", () => {
    const admitDeferredDelivery = vi.fn<
      NonNullable<ChannelMessageDurableFinalAdapter["admitDeferredDelivery"]>
    >((ctx) =>
      ctx.phase === "recovery"
        ? { status: "permanent_rejection", reason: "account no longer supports replay" }
        : { status: "allowed" },
    );
    const adapter = defineChannelMessageAdapter({
      id: "demo",
      durableFinal: { admitDeferredDelivery },
    });
    const context = {
      cfg: {},
      channel: "demo",
      to: "conversation-1",
      accountId: "workspace-1",
    } as Parameters<typeof admitDeferredDelivery>[0];

    expect(adapter.durableFinal?.admitDeferredDelivery?.({ ...context, phase: "live" })).toEqual({
      status: "allowed",
    });
    expect(
      adapter.durableFinal?.admitDeferredDelivery?.({ ...context, phase: "recovery" }),
    ).toEqual({
      status: "permanent_rejection",
      reason: "account no longer supports replay",
    });
  });
});
