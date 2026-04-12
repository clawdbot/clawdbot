import { describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnv } from "../../test-utils/env.js";
import type { TemplateContext } from "../templating.js";
import { buildInboundMetaSystemPrompt, buildInboundUserContextPrefix } from "./inbound-meta.js";

vi.mock("../../channels/plugins/registry-loaded.js", () => ({
  getLoadedChannelPluginById: (channelId: string) =>
    channelId === "slack"
      ? {
          agentPrompt: {
            inboundFormattingHints: () => ({
              text_markup: "slack_mrkdwn",
              rules: [
                "Use Slack mrkdwn, not standard Markdown.",
                "Bold uses *single asterisks*.",
                "Links use <url|label>.",
                "Code blocks use triple backticks without a language identifier.",
                "Do not use markdown headings or pipe tables.",
              ],
            }),
          },
        }
      : undefined,
}));

vi.mock("../../channels/registry.js", () => ({
  normalizeAnyChannelId: (channelId?: string) => channelId?.trim().toLowerCase(),
}));

function parseInboundMetaPayload(text: string): Record<string, unknown> {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error("missing inbound meta json block");
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function parseConversationInfoPayload(text: string): Record<string, unknown> {
  const match = text.match(/Conversation info \(untrusted metadata\):\n```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error("missing conversation info json block");
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function parseSenderInfoPayload(text: string): Record<string, unknown> {
  const match = text.match(/Sender \(untrusted metadata\):\n```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error("missing sender info json block");
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("buildInboundMetaSystemPrompt", () => {
  it("includes session-stable routing fields", () => {
    const prompt = buildInboundMetaSystemPrompt({
      MessageSid: "123",
      MessageSidFull: "123",
      ReplyToId: "99",
      OriginatingTo: "telegram:5494292670",
      AccountId: " work ",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["schema"]).toBe("openclaw.inbound_meta.v1");
    expect(payload["chat_id"]).toBe("telegram:5494292670");
    expect(payload["account_id"]).toBe("work");
    expect(payload["channel"]).toBe("telegram");
  });

  it("does not include per-turn message identifiers (cache stability)", () => {
    const prompt = buildInboundMetaSystemPrompt({
      MessageSid: "123",
      MessageSidFull: "123",
      ReplyToId: "99",
      SenderId: "289522496",
      OriginatingTo: "telegram:5494292670",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["message_id"]).toBeUndefined();
    expect(payload["message_id_full"]).toBeUndefined();
    expect(payload["reply_to_id"]).toBeUndefined();
    expect(payload["sender_id"]).toBeUndefined();
  });

  it("does not include per-turn flags in system metadata", () => {
    const prompt = buildInboundMetaSystemPrompt({
      ReplyToBody: "quoted",
      ForwardedFrom: "sender",
      ThreadStarterBody: "starter",
      InboundHistory: [{ sender: "a", body: "b", timestamp: 1 }],
      WasMentioned: true,
      OriginatingTo: "telegram:-1001249586642",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["flags"]).toBeUndefined();
  });

  it("omits sender_id when blank", () => {
    const prompt = buildInboundMetaSystemPrompt({
      MessageSid: "458",
      SenderId: "   ",
      OriginatingTo: "telegram:-1001249586642",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["sender_id"]).toBeUndefined();
  });

  it("includes Slack mrkdwn response format hints for Slack chats", () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack-plugin",
          source: "test",
          plugin: {
            id: "slack",
            meta: {
              id: "slack",
              label: "Slack",
              selectionLabel: "Slack",
              docsPath: "/channels/slack",
              blurb: "test stub",
            },
            capabilities: { chatTypes: ["channel"] },
            config: { listAccountIds: () => [], resolveAccount: () => ({}) },
            agentPrompt: {
              inboundFormattingHints: () => ({
                text_markup: "slack_mrkdwn",
                rules: [
                  "Use Slack mrkdwn, not standard Markdown.",
                  "Bold uses *single asterisks*.",
                  "Links use <url|label>.",
                  "Code blocks use triple backticks without a language identifier.",
                  "Do not use markdown headings or pipe tables.",
                ],
              }),
            },
          },
        },
      ]),
    );

    const prompt = buildInboundMetaSystemPrompt({
      OriginatingTo: "channel:C123",
      OriginatingChannel: "slack",
      Provider: "slack",
      Surface: "slack",
      ChatType: "channel",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["response_format"]).toEqual({
      text_markup: "slack_mrkdwn",
      rules: [
        "Use Slack mrkdwn, not standard Markdown.",
        "Bold uses *single asterisks*.",
        "Links use <url|label>.",
        "Code blocks use triple backticks without a language identifier.",
        "Do not use markdown headings or pipe tables.",
      ],
    });
  });

  it("omits response format hints for non-Slack chats", () => {
    const prompt = buildInboundMetaSystemPrompt({
      OriginatingTo: "telegram:123",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
    } as TemplateContext);

    const payload = parseInboundMetaPayload(prompt);
    expect(payload["response_format"]).toBeUndefined();
  });
});

describe("buildInboundUserContextPrefix", () => {
  it("omits conversation label block for direct chats", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "direct",
      ConversationLabel: "openclaw-tui",
    } as TemplateContext);

    expect(text).toBe("");
  });

  it("hides message identifiers for direct webchat chats", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "direct",
      OriginatingChannel: "webchat",
      MessageSid: "short-id",
      MessageSidFull: "provider-full-id",
    } as TemplateContext);

    expect(text).toBe("");
  });

  it("includes message identifiers for direct external-channel chats", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "direct",
      OriginatingChannel: "whatsapp",
      MessageSid: "short-id",
      MessageSidFull: "provider-full-id",
      SenderE164: " +15551234567 ",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["message_id"]).toBe("short-id");
    expect(conversationInfo["message_id_full"]).toBeUndefined();
    expect(conversationInfo["sender"]).toBe("+15551234567");
    expect(conversationInfo["conversation_label"]).toBeUndefined();
  });

  it("includes message identifiers for direct chats when channel is inferred from Provider", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "direct",
      Provider: "whatsapp",
      MessageSid: "provider-only-id",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["message_id"]).toBe("provider-only-id");
  });

  it("does not treat group chats as direct based on sender id", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      SenderId: "openclaw-control-ui",
      MessageSid: "123",
      ConversationLabel: "some-label",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["message_id"]).toBe("123");
    expect(conversationInfo["sender_id"]).toBe("openclaw-control-ui");
    expect(conversationInfo["conversation_label"]).toBe("some-label");
  });

  it("keeps conversation label for group chats", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      ConversationLabel: "ops-room",
    } as TemplateContext);

    expect(text).toContain("Conversation info (untrusted metadata):");
    expect(text).toContain('"conversation_label": "ops-room"');
  });

  it("includes sender identifier in conversation info", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      SenderE164: " +15551234567 ",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["sender"]).toBe("+15551234567");
  });

  it("prefers SenderName in conversation info sender identity", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      SenderName: " Tyler ",
      SenderId: " +15551234567 ",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["sender"]).toBe("Tyler");
  });

  it("includes sender metadata block for direct chats", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "direct",
      SenderName: "Tyler",
      SenderId: "+15551234567",
    } as TemplateContext);

    const senderInfo = parseSenderInfoPayload(text);
    expect(senderInfo["label"]).toBe("Tyler (+15551234567)");
    expect(senderInfo["id"]).toBe("+15551234567");
  });

  it("includes formatted timestamp in conversation info when provided", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      MessageSid: "msg-with-ts",
      Timestamp: Date.UTC(2026, 1, 15, 13, 35),
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["timestamp"]).toEqual(expect.any(String));
  });

  it("honors envelope user timezone for conversation timestamps", () => {
    withEnv({ TZ: "America/Los_Angeles" }, () => {
      const text = buildInboundUserContextPrefix(
        {
          ChatType: "group",
          MessageSid: "msg-with-user-tz",
          Timestamp: Date.UTC(2026, 2, 19, 0, 0),
        } as TemplateContext,
        {
          timezone: "user",
          userTimezone: "Asia/Tokyo",
        },
      );

      const conversationInfo = parseConversationInfoPayload(text);
      expect(conversationInfo["timestamp"]).toBe("Thu 2026-03-19 09:00 GMT+9");
    });
  });

  it("omits invalid timestamps instead of throwing", () => {
    expect(() =>
      buildInboundUserContextPrefix({
        ChatType: "group",
        MessageSid: "msg-with-bad-ts",
        Timestamp: 1e20,
      } as TemplateContext),
    ).not.toThrow();

    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      MessageSid: "msg-with-bad-ts",
      Timestamp: 1e20,
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["timestamp"]).toBeUndefined();
  });

  it("includes message_id in conversation info", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      MessageSid: "  msg-123  ",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["message_id"]).toBe("msg-123");
  });

  it("prefers MessageSid when both MessageSid and MessageSidFull are present", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      MessageSid: "short-id",
      MessageSidFull: "full-provider-message-id",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["message_id"]).toBe("short-id");
    expect(conversationInfo["message_id_full"]).toBeUndefined();
  });

  it("falls back to MessageSidFull when MessageSid is missing", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      MessageSid: "   ",
      MessageSidFull: "full-provider-message-id",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["message_id"]).toBe("full-provider-message-id");
    expect(conversationInfo["message_id_full"]).toBeUndefined();
  });

  it("includes reply_to_id in conversation info", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      MessageSid: "msg-200",
      ReplyToId: "msg-199",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["reply_to_id"]).toBe("msg-199");
  });

  it("includes sender_id in conversation info", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      MessageSid: "msg-456",
      SenderId: "289522496",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["sender_id"]).toBe("289522496");
  });

  it("includes dynamic per-turn flags in conversation info", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      WasMentioned: true,
      ReplyToBody: "quoted",
      ForwardedFrom: "sender",
      ThreadStarterBody: "starter",
      InboundHistory: [{ sender: "a", body: "b", timestamp: 1 }],
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["is_group_chat"]).toBe(true);
    expect(conversationInfo["was_mentioned"]).toBe(true);
    expect(conversationInfo["has_reply_context"]).toBe(true);
    expect(conversationInfo["has_forwarded_context"]).toBe(true);
    expect(conversationInfo["has_thread_starter"]).toBe(true);
    expect(conversationInfo["history_count"]).toBe(1);
  });

  it("trims sender_id in conversation info", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      MessageSid: "msg-457",
      SenderId: "  289522496  ",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["sender_id"]).toBe("289522496");
  });

  it("falls back to SenderId when sender phone is missing", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      SenderId: " user@example.com ",
    } as TemplateContext);

    const conversationInfo = parseConversationInfoPayload(text);
    expect(conversationInfo["sender"]).toBe("user@example.com");
  });
});
