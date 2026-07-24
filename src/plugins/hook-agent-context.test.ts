/** Verifies hook callbacks receive agent context and scoped plugin metadata. */
import { describe, expect, it } from "vitest";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "./hook-agent-context.js";

describe("buildAgentHookContextChannelFields", () => {
  it("keeps provider and conversation id separate", () => {
    expect(
      buildAgentHookContextChannelFields({
        sessionKey: "agent:main:discord:channel:c1",
        messageChannel: "discord",
        messageProvider: "discord",
        senderId: "user-123",
      }),
    ).toEqual({
      channel: "discord",
      messageProvider: "discord",
      channelId: "c1",
      chatId: "c1",
      senderId: "user-123",
    });
  });

  it("uses the provider as channel when message channel is a target id", () => {
    expect(
      buildAgentHookContextChannelFields({
        messageChannel: "channel:1472750640760623226",
        messageProvider: "discord",
      }),
    ).toEqual({
      channel: "discord",
      messageProvider: "discord",
      channelId: "1472750640760623226",
      chatId: "1472750640760623226",
      senderId: undefined,
    });
  });

  it("preserves the exact live transport target for a threaded external-user replay", () => {
    expect(
      buildAgentHookContextChannelFields({
        sessionKey: "agent:main:slack:channel:c0ausu28nd7:thread:1784896784.051849",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "agfunder",
        currentChannelId: "C0AUSU28ND7",
        currentMessageId: "1784896784.051849",
        currentThreadTs: "1784896784.051849",
        messageThreadId: "stale-thread",
        senderId: "U028EKM2A",
      }),
    ).toEqual({
      accountId: "agfunder",
      channel: "slack",
      messageProvider: "slack",
      channelId: "C0AUSU28ND7",
      chatId: "C0AUSU28ND7",
      messageId: "1784896784.051849",
      senderId: "U028EKM2A",
      threadId: "1784896784.051849",
    });
  });
});

describe("buildAgentHookContextIdentityFields", () => {
  it("mirrors flat sender and chat ids into channel-owned context", () => {
    expect(
      buildAgentHookContextIdentityFields({
        senderId: "open-id-1",
        chatId: "chat-1",
      }),
    ).toEqual({
      senderId: "open-id-1",
      chatId: "chat-1",
      channelContext: {
        sender: { id: "open-id-1" },
        chat: { id: "chat-1" },
      },
    });
  });

  it("preserves plugin-augmented channel fields while keeping id compatible", () => {
    expect(
      buildAgentHookContextIdentityFields({
        senderId: "open-id-1",
        channelContext: {
          sender: { id: "stale-id", userId: "user-1" } as { id?: string; userId: string },
        },
      }),
    ).toEqual({
      senderId: "open-id-1",
      channelContext: {
        sender: { id: "open-id-1", userId: "user-1" },
      },
    });
  });

  it("omits identity fields for system-originated triggers", () => {
    expect(
      buildAgentHookContextIdentityFields({
        trigger: "cron",
        senderId: "open-id-1",
        chatId: "chat-1",
      }),
    ).toEqual({});
  });
});
