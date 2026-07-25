import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
} from "./embedded-agent-message-tool-source-reply.js";
import {
  isMessagingToolDeliveryAction,
  isMessagingToolSendAction,
  isMessagingToolTargetEvidenceAction,
} from "./embedded-agent-messaging.js";

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "native-messaging",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "native-messaging" }),
          actions: {
            describeMessageTool: () => null,
            isToolDeliveryAction: ({ args }: { args: Record<string, unknown> }) =>
              args.action === "editMessage" || args.action === "deleteMessage",
          },
        },
      },
    ]),
  );
});

describe("messaging delivery action classification", () => {
  it("classifies exact conversation sends as visible messaging delivery", () => {
    for (const toolName of ["conversations_send", "conversations_turn"]) {
      expect(isMessagingToolSendAction(toolName, {})).toBe(true);
      expect(isMessagingToolTargetEvidenceAction(toolName, {})).toBe(true);
      expect(isMessagingToolDeliveryAction(toolName, {})).toBe(true);
    }
  });

  it("keeps visible side effects broader than terminal reply sends", () => {
    expect(isMessagingToolSendAction("message", { action: "poll" })).toBe(false);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "poll" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "reply" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "sticker" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "thread-create" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "topic-create" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "threadCreate" })).toBe(true);
    expect(isMessagingToolTargetEvidenceAction("message", { action: "createForumTopic" })).toBe(
      true,
    );
    expect(isMessagingToolTargetEvidenceAction("message", { action: "edit" })).toBe(false);
    expect(isMessagingToolDeliveryAction("message", { action: "poll" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "broadcast" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "thread-create" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "topic-create" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "createForumTopic" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "channel-create" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "event-create" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "react" })).toBe(true);
    expect(isMessagingToolDeliveryAction("message", { action: "read" })).toBe(false);
    expect(isMessagingToolDeliveryAction("message", { action: "channel-list" })).toBe(false);
  });

  it("uses provider-native mutation contracts", () => {
    expect(isMessagingToolDeliveryAction("native-messaging", { action: "editMessage" })).toBe(true);
    expect(isMessagingToolDeliveryAction("native-messaging", { action: "deleteMessage" })).toBe(
      true,
    );
    expect(isMessagingToolDeliveryAction("native-messaging", { action: "readMessages" })).toBe(
      false,
    );
  });
});

describe("isDeliveredMessagingToolResult", () => {
  it("accepts confirmed delivery receipts from direct CLI text blocks", () => {
    expect(
      isDeliveredMessagingToolResult({
        result: [{ type: "text", text: JSON.stringify({ result: { messageId: "msg-1" } }) }],
      }),
    ).toBe(true);
    expect(isDeliveredMessagingToolResult({ result: { content: [{ text: "sent" }] } })).toBe(true);
    expect(isDeliveredMessagingToolResult({ result: { status: "sent" } })).toBe(true);
  });

  it("rejects bare success markers without delivery evidence", () => {
    expect(isDeliveredMessagingToolResult({ result: { ok: true, to: "spaces/AAA" } })).toBe(false);
  });

  it("accepts action-specific bare success delivery contracts", () => {
    expect(
      isDeliveredMessagingToolResult({
        args: { action: "poll" },
        result: { ok: true },
      }),
    ).toBe(true);
    expect(
      isDeliveredMessagingToolResult({
        args: { action: "sticker" },
        result: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      }),
    ).toBe(true);
    expect(
      isDeliveredMessagingToolResult({
        args: { action: "channel-create" },
        result: { ok: true },
      }),
    ).toBe(true);
  });

  it("rejects successful no-op mutation results", () => {
    for (const result of [
      { ok: true, removed: null },
      { ok: true, removed: 0 },
      { ok: true, removed: [] },
      { ok: true, changed: false },
      { content: [{ text: "sent" }], details: { sent: false } },
    ]) {
      expect(
        isDeliveredMessagingToolResult({
          args: { action: "react" },
          result,
        }),
      ).toBe(false);
    }
  });

  it("accepts sessions_send acknowledgement statuses only for sessions_send", () => {
    expect(
      isDeliveredMessagingToolResult({
        toolName: "sessions_send",
        result: { status: "accepted" },
      }),
    ).toBe(true);
    expect(
      isDeliveredMessagingToolResult({
        toolName: "sessions_send",
        result: { status: "ok" },
      }),
    ).toBe(true);
    expect(isDeliveredMessagingToolResult({ toolName: "message", result: { status: "ok" } })).toBe(
      false,
    );
  });

  it("accepts post-start sessions_send timeout and error evidence", () => {
    expect(
      isDeliveredMessagingToolResult({
        toolName: "sessions_send",
        result: { status: "timeout", sentBeforeError: true },
      }),
    ).toBe(true);
    expect(
      isDeliveredMessagingToolResult({
        toolName: "sessions_send",
        result: { status: "error", sentBeforeError: true },
      }),
    ).toBe(true);
    expect(
      isDeliveredMessagingToolResult({
        toolName: "sessions_send",
        result: { status: "timeout" },
      }),
    ).toBe(false);
    expect(
      isDeliveredMessagingToolResult({
        toolName: "sessions_send",
        result: { status: "error" },
      }),
    ).toBe(false);
  });

  it("accepts poll delivery identifiers", () => {
    expect(isDeliveredMessagingToolResult({ result: { pollId: "poll-1" } })).toBe(true);
  });

  it("accepts successful thread and topic creation receipts", () => {
    expect(
      isDeliveredMessagingToolResult({
        args: { action: "thread-create" },
        result: { ok: true, thread: { id: "thread-1" } },
      }),
    ).toBe(true);
    expect(
      isDeliveredMessagingToolResult({
        args: { action: "topic-create" },
        result: { ok: true, topicId: 42 },
      }),
    ).toBe(true);
    expect(
      isDeliveredMessagingToolResult({
        args: { action: "topic-create" },
        isError: true,
        result: { topicId: 43, error: "post-create metadata update failed" },
      }),
    ).toBe(true);
  });

  it("accepts only broadcast result entries with concrete delivery evidence", () => {
    expect(
      isDeliveredMessagingToolResult({
        toolName: "message",
        result: { results: [{ ok: true, messageId: "message-1" }] },
      }),
    ).toBe(true);
    expect(
      isDeliveredMessagingToolResult({
        args: { action: "broadcast" },
        result: {
          results: [
            {
              channel: "telegram",
              to: "chat-1",
              ok: true,
              payload: { ok: true, messageId: "gateway-message-1" },
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isDeliveredMessagingToolResult({
        args: { action: "broadcast" },
        result: { results: [{ channel: "googlechat", to: "space-1", ok: true }] },
      }),
    ).toBe(false);
    expect(
      isDeliveredMessagingToolResult({
        args: { action: "broadcast" },
        result: {
          results: [
            {
              channel: "googlechat",
              to: "space-1",
              ok: true,
              payload: { ok: true, to: "spaces/AAA" },
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("rejects successful broadcast wrappers around suppressed sends", () => {
    expect(
      isDeliveredMessagingToolResult({
        toolName: "message",
        args: { action: "broadcast" },
        result: { results: [{ ok: true, result: { messageId: "suppressed" } }] },
      }),
    ).toBe(false);
    expect(
      isDeliveredMessagingToolResult({
        toolName: "message",
        args: { action: "broadcast" },
        result: { results: [{ ok: true, result: { deliveryStatus: "suppressed" } }] },
      }),
    ).toBe(false);
    expect(
      isDeliveredMessagingToolResult({
        toolName: "message",
        args: { action: "broadcast" },
        result: {
          results: [{ ok: true, payload: { ok: true, deliveryStatus: "suppressed" } }],
        },
      }),
    ).toBe(false);
  });

  it("accepts failed broadcast entries with partial-delivery evidence", () => {
    expect(
      isDeliveredMessagingToolResult({
        args: { action: "broadcast" },
        result: {
          results: [{ channel: "telegram", to: "chat-1", ok: false, sentBeforeError: true }],
        },
      }),
    ).toBe(true);
  });

  it("rejects non-delivery message id sentinels", () => {
    expect(isDeliveredMessagingToolResult({ result: { messageId: "skipped" } })).toBe(false);
    expect(isDeliveredMessagingToolResult({ result: { messageId: "suppressed" } })).toBe(false);
  });

  it("accepts successful sends with an unknown message id", () => {
    expect(isDeliveredMessagingToolResult({ result: { messageId: "unknown" } })).toBe(true);
  });

  it("rejects dry-run, suppressed, and errored results", () => {
    expect(
      isDeliveredMessagingToolResult({
        args: { dryRun: true },
        result: { result: { messageId: "msg-1" } },
      }),
    ).toBe(false);
    expect(isDeliveredMessagingToolResult({ result: { status: "suppressed" } })).toBe(false);
    expect(
      isDeliveredMessagingToolResult({
        isError: true,
        result: { result: { messageId: "msg-1" } },
      }),
    ).toBe(false);
  });

  it("accepts errored results that prove partial visible delivery", () => {
    expect(
      isDeliveredMessagingToolResult({
        isError: true,
        result: Object.assign(new Error("second chunk failed"), { sentBeforeError: true }),
      }),
    ).toBe(true);
    expect(
      isDeliveredMessagingToolResult({
        isError: true,
        result: { deliveryStatus: "partial_failed" },
      }),
    ).toBe(true);
  });

  it("accepts a nested provider message id as delivery evidence", () => {
    expect(
      isDeliveredMessagingToolResult({
        toolName: "message",
        args: {
          action: "send",
          channel: "qa-channel",
          target: "qa-a2a-requester",
          message: "reply",
        },
        result: {
          content: [{ type: "text", text: '{"message":{"id":"qa-message-242"}}' }],
          details: { message: { id: "qa-message-242" } },
        },
      }),
    ).toBe(true);
  });
});

describe("isDeliveredMessageToolOnlySourceReplyResult", () => {
  it("accepts only confirmed implicit message sends", () => {
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: { action: "send", message: "reply" },
        result: { deliveryStatus: "sent" },
      }),
    ).toBe(true);
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: { action: "send", target: "elsewhere", message: "reply" },
        result: { deliveryStatus: "sent" },
      }),
    ).toBe(false);
  });

  it("accepts confirmed explicit routes when the caller verified the source route", () => {
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: {
          action: "reply",
          channel: "imessage",
          target: "+12069106512",
          message: "reply",
        },
        result: { ok: true, messageId: "imessage-853" },
        allowExplicitSourceRoute: true,
      }),
    ).toBe(true);
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: {
          action: "reply",
          channel: "imessage",
          target: "+12069106512",
          message: "reply",
        },
        result: { ok: true, messageId: "imessage-853" },
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: {
          action: "react",
          channel: "imessage",
          target: "+12069106512",
        },
        result: { ok: true },
        allowExplicitSourceRoute: true,
      }),
    ).toBe(false);
  });

  it("accepts explicit sends with a structured current-source marker", () => {
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: {
          action: "send",
          channel: "telegram",
          target: "8455538490",
          message: "reply",
        },
        result: {
          content: [{ type: "text", text: '{"ok":true}' }],
          details: {
            ok: true,
            messageId: "telegram-242",
            sourceReplyRoute: "current-source",
          },
        },
      }),
    ).toBe(true);
  });

  it("does not trust current-source markers echoed in result text", () => {
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: {
          action: "send",
          target: "elsewhere",
          message: "reply",
        },
        result: {
          content: [
            {
              type: "text",
              text: '{"ok":true,"sourceReplyRoute":"current-source"}',
            },
          ],
          details: { ok: true, messageId: "remote-242" },
        },
      }),
    ).toBe(false);
  });
});
