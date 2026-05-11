import { beforeEach, describe, expect, it } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
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
    SessionKey: "session-1",
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

  it("falls back to raw body when command body is blank", () => {
    const canonical = deriveInboundMessageHookContext(
      makeInboundCtx({
        BodyForCommands: " \n\t",
        RawBody: "Readiness probe failed",
      }),
    );

    expect(canonical.content).toBe("Readiness probe failed");
    expect(toPluginMessageReceivedEvent(canonical).content).toBe("Readiness probe failed");
    expect(toInternalMessageReceivedContext(canonical).content).toBe("Readiness probe failed");
  });

  it("keeps nonblank command body ahead of raw body for hook content", () => {
    const canonical = deriveInboundMessageHookContext(
      makeInboundCtx({
        BodyForCommands: "/status",
        RawBody: "Readiness probe failed",
      }),
    );

    expect(canonical.content).toBe("/status");
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
        MediaUrl: undefined,
        MediaType: undefined,
        MediaPaths: ["/tmp/tree.jpg", "/tmp/ramp.jpg"],
        MediaUrls: ["https://example.test/tree.jpg", "https://example.test/ramp.jpg"],
        MediaTypes: ["image/jpeg", "image/jpeg"],
      }),
    );

    expect(canonical.mediaPath).toBe("/tmp/tree.jpg");
    expect(canonical.mediaUrl).toBe("https://example.test/tree.jpg");
    expect(canonical.mediaType).toBe("image/jpeg");
    expect(canonical.mediaPaths).toEqual(["/tmp/tree.jpg", "/tmp/ramp.jpg"]);
    expect(canonical.mediaUrls).toEqual([
      "https://example.test/tree.jpg",
      "https://example.test/ramp.jpg",
    ]);
    expect(canonical.mediaTypes).toEqual(["image/jpeg", "image/jpeg"]);
    const claimEvent = toPluginInboundClaimEvent(canonical);
    expect(claimEvent.metadata?.mediaPath).toBe("/tmp/tree.jpg");
    expect(claimEvent.metadata?.mediaUrl).toBe("https://example.test/tree.jpg");
    expect(claimEvent.metadata?.mediaType).toBe("image/jpeg");
    expect(claimEvent.metadata?.mediaPaths).toEqual(["/tmp/tree.jpg", "/tmp/ramp.jpg"]);
    expect(claimEvent.metadata?.mediaUrls).toEqual([
      "https://example.test/tree.jpg",
      "https://example.test/ramp.jpg",
    ]);
    expect(claimEvent.metadata?.mediaTypes).toEqual(["image/jpeg", "image/jpeg"]);
  });

  it("maps canonical inbound context to plugin/internal received payloads", () => {
    const trace: DiagnosticTraceContext = {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      parentSpanId: "3333333333333333",
    };
    const canonical = {
      ...deriveInboundMessageHookContext(makeInboundCtx({ TopicName: "Deployments" })),
      runId: "run-1",
      trace,
      callDepth: 2,
    };

    const pluginContext = toPluginMessageContext(canonical);
    const receivedEvent = toPluginMessageReceivedEvent(canonical);
    const { metadata: receivedMetadata, ...receivedEventBase } = receivedEvent;
    expect(pluginContext).toEqual({
      channelId: "demo-chat",
      accountId: "acc-1",
      conversationId: "demo-chat:chat:456",
      sessionKey: "session-1",
      runId: "run-1",
      messageId: "msg-1",
      senderId: "sender-1",
      trace,
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      parentSpanId: "3333333333333333",
      callDepth: 2,
    });
    expect(pluginContext.trace).not.toBe(trace);
    expect(pluginContext.trace).toEqual(trace);
    expect(Object.isFrozen(pluginContext.trace)).toBe(true);
    expect(receivedEvent.trace).not.toBe(trace);
    expect(receivedEvent.trace).toEqual(trace);
    expect(Object.isFrozen(receivedEvent.trace)).toBe(true);
    expect(receivedEventBase).toEqual({
      from: "demo-chat:user:123",
      content: "commands-body",
      timestamp: 1710000000,
      threadId: 42,
      messageId: "msg-1",
      senderId: "sender-1",
      sessionKey: "session-1",
      runId: "run-1",
      trace: receivedEvent.trace,
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      parentSpanId: "3333333333333333",
    });
    expect(receivedMetadata?.messageId).toBe("msg-1");
    expect(receivedMetadata?.senderName).toBe("User One");
    expect(receivedMetadata?.threadId).toBe(42);
    expect(receivedMetadata?.topicName).toBe("Deployments");
    const internalReceived = toInternalMessageReceivedContext(canonical);
    const { metadata: internalMetadata, ...internalReceivedBase } = internalReceived;
    expect(internalReceivedBase).toEqual({
      from: "demo-chat:user:123",
      content: "commands-body",
      timestamp: 1710000000,
      channelId: "demo-chat",
      accountId: "acc-1",
      conversationId: "demo-chat:chat:456",
      messageId: "msg-1",
    });
    expect(internalMetadata?.senderUsername).toBe("userone");
    expect(internalMetadata?.senderE164).toBe("+15551234567");
    expect(internalMetadata?.topicName).toBe("Deployments");
  });

  it("passes frozen trace copies to inbound claim and sent plugin hooks", () => {
    const trace: DiagnosticTraceContext = {
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      parentSpanId: "cccccccccccccccc",
      traceFlags: "01",
    };
    const inbound = {
      ...deriveInboundMessageHookContext(makeInboundCtx()),
      trace,
    };
    const inboundContext = toPluginInboundClaimContext(inbound);
    const inboundEvent = toPluginInboundClaimEvent(inbound);
    expect(inboundContext.trace).not.toBe(trace);
    expect(inboundContext.trace).toEqual(trace);
    expect(Object.isFrozen(inboundContext.trace)).toBe(true);
    expect(inboundEvent.trace).not.toBe(trace);
    expect(inboundEvent.trace).toEqual(trace);
    expect(Object.isFrozen(inboundEvent.trace)).toBe(true);

    const sent = buildCanonicalSentMessageHookContext({
      to: "demo-chat:chat:456",
      content: "reply",
      success: true,
      channelId: "demo-chat",
      trace,
    });
    const sentEvent = toPluginMessageSentEvent(sent);
    expect(sentEvent.trace).not.toBe(trace);
    expect(sentEvent.trace).toEqual(trace);
    expect(Object.isFrozen(sentEvent.trace)).toBe(true);
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
      sessionKey: "session-1",
      parentConversationId: undefined,
      senderId: "sender-1",
      messageId: "msg-1",
      runId: undefined,
      trace: undefined,
      traceId: undefined,
      spanId: undefined,
      parentSpanId: undefined,
      callDepth: undefined,
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
      sessionKey: "session-1",
      parentConversationId: undefined,
      senderId: "sender-1",
      messageId: "msg-1",
      runId: undefined,
      trace: undefined,
      traceId: undefined,
      spanId: undefined,
      parentSpanId: undefined,
      callDepth: undefined,
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
      sessionKey: "session-1",
      messageId: "out-1",
      runId: "run-out-1",
      isGroup: true,
      groupId: "demo-chat:chat:456",
    });

    expect(toPluginMessageContext(canonical)).toEqual({
      channelId: "demo-chat",
      accountId: "acc-1",
      conversationId: "demo-chat:chat:456",
      sessionKey: "session-1",
      runId: "run-out-1",
      messageId: "out-1",
    });
    expect(toPluginMessageSentEvent(canonical)).toEqual({
      to: "demo-chat:chat:456",
      content: "reply",
      success: false,
      messageId: "out-1",
      sessionKey: "session-1",
      runId: "run-out-1",
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
