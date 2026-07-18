import { describe, expect, it } from "vitest";
import {
  buildConversationIdentity,
  conversationIdentityFromMsgContext,
  conversationIdentityFromSessionEntry,
} from "./conversation-identity.js";

function directEntry(peer: string) {
  return {
    sessionId: "session-main",
    updatedAt: 100,
    chatType: "direct" as const,
    deliveryContext: {
      channel: "reef",
      accountId: "default",
      to: `reef:${peer}`,
    },
    origin: {
      provider: "reef",
      accountId: "default",
      nativeDirectUserId: peer,
    },
  };
}

describe("conversation identity", () => {
  it("does not present a stripped peer id as an exact delivery target", () => {
    expect(
      conversationIdentityFromSessionEntry({
        sessionId: "session-1",
        updatedAt: 1,
        chatType: "channel",
        channel: "discord",
        groupId: "ops-room",
      }),
    ).toBeNull();
  });

  it("derives the same opaque address from prefixed and native direct targets", () => {
    const native = conversationIdentityFromSessionEntry(directEntry("peer-a"));
    const prefixed = conversationIdentityFromSessionEntry({
      ...directEntry("peer-a"),
      origin: { provider: "reef", accountId: "default" },
    });

    expect(native).toMatchObject({
      accountId: "default",
      channel: "reef",
      deliveryTarget: "reef:peer-a",
      kind: "direct",
      peerId: "peer-a",
    });
    expect(native?.conversationRef).toMatch(/^conv_[a-f0-9]{32}$/u);
    expect(prefixed?.conversationRef).toBe(native?.conversationRef);
  });

  it("keeps different peers independently addressable inside one model session", () => {
    const peerA = conversationIdentityFromSessionEntry(directEntry("peer-a"));
    const peerB = conversationIdentityFromSessionEntry(directEntry("peer-b"));

    expect(peerA?.conversationRef).not.toBe(peerB?.conversationRef);
  });

  it("uses the canonical delivery snapshot when stale origin metadata disagrees", () => {
    const identity = conversationIdentityFromSessionEntry({
      ...directEntry("peer-a"),
      origin: {
        provider: "reef",
        accountId: "default",
        nativeDirectUserId: "peer-a",
        from: "reef:stale-peer",
      },
    });

    expect(identity?.deliveryTarget).toBe("reef:peer-a");
    expect(identity?.peerId).toBe("peer-a");
    expect(identity?.conversationRef).toBe(
      conversationIdentityFromSessionEntry(directEntry("peer-a"))?.conversationRef,
    );
  });

  it("never lets stale native metadata label another delivery target", () => {
    const identity = conversationIdentityFromSessionEntry({
      ...directEntry("peer-b"),
      origin: {
        provider: "reef",
        accountId: "default",
        nativeDirectUserId: "peer-a",
      },
    });

    expect(identity).toMatchObject({
      deliveryTarget: "reef:peer-b",
      nativeDirectUserId: "peer-a",
      peerId: "peer-b",
    });
    expect(identity?.conversationRef).toBe(
      conversationIdentityFromSessionEntry(directEntry("peer-b"))?.conversationRef,
    );
    expect(identity?.conversationRef).not.toBe(
      conversationIdentityFromSessionEntry(directEntry("peer-a"))?.conversationRef,
    );
  });

  it("keeps a paired canonical outbound peer separate from its delivery alias", () => {
    const identity = conversationIdentityFromSessionEntry({
      sessionId: "session-main",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: {
        channel: "discord",
        accountId: "default",
        to: "user:delivery-alias-456",
      },
      origin: {
        provider: "discord",
        accountId: "default",
        chatType: "direct",
        from: "discord:canonical-peer-123",
        to: "user:delivery-alias-456",
        nativeDirectUserId: "canonical-peer-123",
      },
    });

    expect(identity).toMatchObject({
      channel: "discord",
      deliveryTarget: "user:delivery-alias-456",
      nativeDirectUserId: "canonical-peer-123",
      peerId: "canonical-peer-123",
    });
    expect(identity?.conversationRef).toBe(
      buildConversationIdentity({
        channel: "discord",
        accountId: "default",
        kind: "direct",
        peerId: "canonical-peer-123",
        deliveryTarget: "user:delivery-alias-456",
      })?.conversationRef,
    );
  });

  it("keeps a group bound to its room instead of the paired origin sender", () => {
    const identity = conversationIdentityFromSessionEntry({
      sessionId: "session-group",
      updatedAt: 100,
      chatType: "group",
      deliveryContext: {
        channel: "discord",
        accountId: "default",
        to: "channel:ops-room",
      },
      origin: {
        provider: "discord",
        accountId: "default",
        chatType: "group",
        from: "discord:user:participant-123",
        to: "channel:ops-room",
        nativeChannelId: "ops-room",
      },
    });

    expect(identity).toMatchObject({
      deliveryTarget: "channel:ops-room",
      nativeChannelId: "ops-room",
      peerId: "ops-room",
    });
  });

  it("keeps fallback origin targets paired with their origin channel", () => {
    const identity = conversationIdentityFromSessionEntry({
      sessionId: "session-main",
      updatedAt: 100,
      chatType: "direct",
      channel: "discord",
      origin: {
        provider: "reef",
        accountId: "work",
        from: "reef:peer-b",
      },
    });

    expect(identity).toMatchObject({
      accountId: "work",
      channel: "reef",
      deliveryTarget: "reef:peer-b",
      peerId: "peer-b",
    });
  });

  it("derives live direct identity from the exact reply target, not native metadata", () => {
    const identity = conversationIdentityFromMsgContext({
      ctx: {
        Provider: "reef",
        ChatType: "direct",
        From: "reef:peer-b",
        OriginatingTo: "reef:self",
        NativeDirectUserId: "peer-a",
      },
    });

    expect(identity).toMatchObject({
      deliveryTarget: "reef:peer-b",
      nativeDirectUserId: "peer-a",
      peerId: "peer-b",
    });
    expect(identity?.conversationRef).toBe(
      conversationIdentityFromSessionEntry(directEntry("peer-b"))?.conversationRef,
    );
  });

  it.each([
    { fallback: { origin: { provider: "reef", accountId: "work" } }, label: "origin" },
    { fallback: { lastAccountId: "work" }, label: "last route" },
  ])("fills an omitted delivery account from the persisted $label", ({ fallback }) => {
    const identity = conversationIdentityFromSessionEntry({
      sessionId: "session-main",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: { channel: "reef", to: "reef:peer-a" },
      ...fallback,
    });
    const explicit = conversationIdentityFromSessionEntry({
      sessionId: "session-main",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "work", to: "reef:peer-a" },
    });

    expect(identity?.accountId).toBe("work");
    expect(identity?.conversationRef).toBe(explicit?.conversationRef);
  });

  it("pairs a partial delivery target with the persisted session channel", () => {
    const identity = conversationIdentityFromSessionEntry({
      sessionId: "session-main",
      updatedAt: 100,
      chatType: "direct",
      channel: "reef",
      deliveryContext: { to: "reef:peer-a" },
    });

    expect(identity).toMatchObject({
      channel: "reef",
      deliveryTarget: "reef:peer-a",
      peerId: "peer-a",
    });
  });

  it("derives the same threaded address from live and persisted route facts", () => {
    const persisted = conversationIdentityFromSessionEntry({
      sessionId: "thread-session",
      updatedAt: 100,
      chatType: "channel",
      groupId: "ops-room",
      deliveryContext: {
        channel: "discord",
        accountId: "default",
        to: "channel:ops-room",
        threadId: "user-context",
      },
      origin: { provider: "discord", accountId: "default", nativeChannelId: "ops-room" },
    });
    const live = conversationIdentityFromMsgContext({
      ctx: {
        Provider: "discord",
        AccountId: "default",
        ChatType: "channel",
        From: "discord:channel:ops-room",
        OriginatingTo: "channel:ops-room",
        NativeChannelId: "ops-room",
        MessageThreadId: "user-context",
        ThreadParentId: "unpersisted-parent-id",
      },
      groupResolution: {
        key: "discord:channel:ops-room",
        channel: "discord",
        id: "ops-room",
        chatType: "channel",
      },
    });

    expect(live?.conversationRef).toBe(persisted?.conversationRef);
    expect(live?.deliveryTarget).toBe("channel:ops-room");
    expect(persisted?.deliveryTarget).toBe("channel:ops-room");
    expect(live?.parentConversationRef).toBeUndefined();
  });
});
