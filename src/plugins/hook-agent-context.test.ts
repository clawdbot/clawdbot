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
        agentAccountId: "work",
        senderId: "user-123",
      }),
    ).toEqual({
      channel: "discord",
      accountId: "work",
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
        messageId: "msg-1",
        senderIsOwner: true,
      }),
    ).toEqual({});
  });

  it("carries the authenticated message id and owner bit for user turns", () => {
    expect(
      buildAgentHookContextIdentityFields({
        trigger: "user",
        senderId: "open-id-1",
        chatId: "chat-1",
        messageId: 4242,
        senderIsOwner: true,
      }),
    ).toEqual({
      senderId: "open-id-1",
      chatId: "chat-1",
      // Numeric provider ids (Telegram) stringify so plugins get one stable type.
      messageId: "4242",
      senderIsOwner: true,
      channelContext: {
        sender: { id: "open-id-1" },
        chat: { id: "chat-1" },
      },
    });
  });

  it("keeps a host-resolved non-owner distinguishable from an unresolved sender", () => {
    expect(buildAgentHookContextIdentityFields({ senderId: "s1", senderIsOwner: false })).toEqual({
      senderId: "s1",
      senderIsOwner: false,
      channelContext: { sender: { id: "s1" } },
    });
    expect(buildAgentHookContextIdentityFields({ senderId: "s1" })).toEqual({
      senderId: "s1",
      channelContext: { sender: { id: "s1" } },
    });
  });

  it("drops blank and unusable message ids instead of emitting an empty coordinate", () => {
    for (const messageId of ["   ", null, undefined]) {
      expect(buildAgentHookContextIdentityFields({ senderId: "s1", messageId })).not.toHaveProperty(
        "messageId",
      );
    }
  });
});
