import { beforeEach, describe, expect, it } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  buildCanonicalSentMessageHookContext,
  deriveInboundMessageHookContext,
  toPluginInboundClaimEvent,
  toPluginInboundClaimContext,
  toInternalMessagePreprocessedContext,
  toInternalMessageReceivedContext,
  toInternalMessageSentContext,
  toInternalMessageTranscribedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
  toPluginMessageSentEvent,
} from "./message-hook-mappers.js";

function makeInboundCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    From: "demo-chat:user:123",
    To: "demo-chat:chat:456",
    Body: "body",
    BodyForAgent: "body-for-agent",
    BodyForCommands: "commands-body",
    RawBody: "raw-body",
    Transcript: "hello transcript",
    Timestamp: 1710000000,
    Provider: "demo-chat",
    Surface: "demo-chat",
    OriginatingChannel: "demo-chat",
    OriginatingTo: "demo-chat:chat:456",
    AccountId: "acc-1",
    MessageSid: "msg-1",
    SenderId: "sender-1",
    SenderName: "User One",
    SenderUsername: "userone",
    SenderE164: "+15551234567",
    MessageThreadId: 42,
    MediaPath: "/tmp/audio.ogg",
    MediaType: "audio/ogg",
    GroupSubject: "ops",
    GroupChannel: "ops-room",
    GroupSpace: "guild-1",
    ...overrides,
  } as FinalizedMsgContext;
}

describe("message hook mappers", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "claim-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "claim-chat", label: "Claim chat" }),
            messaging: {
              resolveInboundConversation: ({
                from,
                to,
                isGroup,
              }: {
                from?: string;
                to?: string;
                isGroup?: boolean;
              }) => {
                const normalizedTo = to?.replace(/^channel:/i, "").trim();
                const normalizedFrom = from?.replace(/^claim-chat:/i, "").trim();
                if (isGroup && normalizedTo) {
                  return { conversationId: `channel:${normalizedTo}` };
                }
                if (normalizedFrom) {
                  return { conversationId: `user:${normalizedFrom}` };
                }
                return null;
              },
            },
          },
        },
      ]),
    );
  });

  it("derives canonical inbound context with body precedence and group metadata", () => {
    const canonical = deriveInboundMessageHookContext(makeInboundCtx());

    expect(canonical.content).toBe("commands-body");
    expect(canonical.channelId).toBe("demo-chat");
    expect(canonical.conversationId).toBe("demo-chat:chat:456");
    expect(canonical.messageId).toBe("msg-1");
    expect(canonical.isGroup).toBe(true);
    expect(canonical.groupId).toBe("demo-chat:chat:456");
    expect(canonical.guildId).toBe("guild-1");
  });

  it("supports explicit content/messageId overrides", () => {
    const canonical = deriveInboundMessageHookContext(makeInboundCtx(), {
      content: "override-content",
      messageId: "override-msg",
    });

    expect(canonical.content).toBe("override-content");
    expect(canonical.messageId).toBe("override-msg");
  });

  it("preserves multi-attachment arrays for inbound claim metadata", () => {
    const canonical = deriveInboundMessageHookContext(
      makeInboundCtx({
        MediaPath: undefined,
        MediaType: undefined,
        MediaPaths: ["/tmp/tree.jpg", "/tmp/ramp.jpg"],
        MediaTypes: ["image/jpeg", "image/jpeg"],
      }),
    );

    expect(canonical.mediaPath).toBe("/tmp/tree.jpg");
    expect(canonical.mediaType).toBe("image/jpeg");
    expect(canonical.mediaPaths).toEqual(["/tmp/tree.jpg", "/tmp/ramp.jpg"]);
    expect(canonical.mediaTypes).toEqual(["image/jpeg", "image/jpeg"]);
    expect(toPluginInboundClaimEvent(canonical)).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          mediaPath: "/tmp/tree.jpg",
          mediaType: "image/jpeg",
          mediaPaths: ["/tmp/tree.jpg", "/tmp/ramp.jpg"],
          mediaTypes: ["image/jpeg", "image/jpeg"],
        }),
      }),
    );
  });

  it("maps canonical inbound context to plugin/internal received payloads", () => {
    const canonical = deriveInboundMessageHookContext(makeInboundCtx({ TopicName: "Deployments" }));

    expect(toPluginMessageContext(canonical)).toEqual({
      channelId: "demo-chat",
      accountId: "acc-1",
      conversationId: "demo-chat:chat:456",
    });
    expect(toPluginMessageReceivedEvent(canonical)).toEqual({
      from: "demo-chat:user:123",
      content: "commands-body",
      timestamp: 1710000000,
      threadId: 42,
      metadata: expect.objectContaining({
        messageId: "msg-1",
        senderName: "User One",
        threadId: 42,
        topicName: "Deployments",
      }),
    });
    expect(toInternalMessageReceivedContext(canonical)).toEqual({
      from: "demo-chat:user:123",
      content: "commands-body",
      timestamp: 1710000000,
      channelId: "demo-chat",
      accountId: "acc-1",
      conversationId: "demo-chat:chat:456",
      messageId: "msg-1",
      metadata: expect.objectContaining({
        senderUsername: "userone",
        senderE164: "+15551234567",
        topicName: "Deployments",
      }),
    });
  });

  it("uses channel plugin claim resolvers for grouped conversations", () => {
    const canonical = deriveInboundMessageHookContext(
      makeInboundCtx({
        Provider: "claim-chat",
        Surface: "claim-chat",
        OriginatingChannel: "claim-chat",
        To: "channel:123456789012345678",
        OriginatingTo: "channel:123456789012345678",
        GroupChannel: "general",
        GroupSubject: "guild",
      }),
    );

    expect(toPluginInboundClaimContext(canonical)).toEqual({
      channelId: "claim-chat",
      accountId: "acc-1",
      conversationId: "channel:123456789012345678",
      parentConversationId: undefined,
      senderId: "sender-1",
      messageId: "msg-1",
    });
  });

  it("uses channel plugin claim resolvers for direct-message conversations", () => {
    const canonical = deriveInboundMessageHookContext(
      makeInboundCtx({
        Provider: "claim-chat",
        Surface: "claim-chat",
        OriginatingChannel: "claim-chat",
        From: "claim-chat:1177378744822943744",
        To: "channel:1480574946919846079",
        OriginatingTo: "channel:1480574946919846079",
        GroupChannel: undefined,
        GroupSubject: undefined,
      }),
    );

    expect(toPluginInboundClaimContext(canonical)).toEqual({
      channelId: "claim-chat",
      accountId: "acc-1",
      conversationId: "user:1177378744822943744",
      parentConversationId: undefined,
      senderId: "sender-1",
      messageId: "msg-1",
    });
  });

  it("maps transcribed and preprocessed internal payloads", () => {
    const cfg = {} as OpenClawConfig;
    const canonical = deriveInboundMessageHookContext(makeInboundCtx({ Transcript: undefined }));

    const transcribed = toInternalMessageTranscribedContext(canonical, cfg);
    expect(transcribed.transcript).toBe("");
    expect(transcribed.cfg).toBe(cfg);

    const preprocessed = toInternalMessagePreprocessedContext(canonical, cfg);
    expect(preprocessed.transcript).toBeUndefined();
    expect(preprocessed.isGroup).toBe(true);
    expect(preprocessed.groupId).toBe("demo-chat:chat:456");
    expect(preprocessed.cfg).toBe(cfg);
  });

  it("maps sent context consistently for plugin/internal hooks", () => {
    const canonical = buildCanonicalSentMessageHookContext({
      to: "demo-chat:chat:456",
      content: "reply",
      success: false,
      error: "network error",
      channelId: "demo-chat",
      accountId: "acc-1",
      messageId: "out-1",
      isGroup: true,
      groupId: "demo-chat:chat:456",
    });

    expect(toPluginMessageContext(canonical)).toEqual({
      channelId: "demo-chat",
      accountId: "acc-1",
      conversationId: "demo-chat:chat:456",
    });
    expect(toPluginMessageSentEvent(canonical)).toEqual({
      to: "demo-chat:chat:456",
      content: "reply",
      success: false,
      error: "network error",
    });
    expect(toInternalMessageSentContext(canonical)).toEqual({
      to: "demo-chat:chat:456",
      content: "reply",
      success: false,
      error: "network error",
      channelId: "demo-chat",
      accountId: "acc-1",
      conversationId: "demo-chat:chat:456",
      messageId: "out-1",
      isGroup: true,
      groupId: "demo-chat:chat:456",
    });
  });
});
