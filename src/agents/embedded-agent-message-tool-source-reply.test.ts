import { beforeEach, describe, expect, it } from "vitest";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import type { MessageSendResult } from "../infra/outbound/message.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { projectEmbeddedMessageDeliveryFact } from "./embedded-agent-message-delivery.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
  readMessageToolSourceReplyText,
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
  it.each([
    ["sent status", { deliveryStatus: "sent" }, true],
    ["gateway id", { result: { messageId: "msg-1" } }, true],
    ["unknown id", { result: { messageId: "unknown" } }, true],
    ["skipped id", { result: { messageId: "skipped" } }, false],
    ["suppressed id", { result: { messageId: "suppressed" } }, false],
    ["suppressed status", { deliveryStatus: "suppressed" }, false],
    ["dry run", { dryRun: true }, false],
    ["partial status", { deliveryStatus: "partial_failed" }, true],
    ["partial marker", { sentBeforeError: true }, true],
    ["failed status", { deliveryStatus: "failed" }, false],
    [
      "receipt id",
      {
        result: {
          channel: "telegram",
          messageId: "",
          receipt: {
            primaryPlatformMessageId: "receipt-1",
            platformMessageIds: ["receipt-1"],
            parts: [],
            sentAt: 1,
          },
        },
      },
      true,
    ],
  ] satisfies Array<[string, Partial<MessageSendResult>, boolean]>)(
    "preserves the differential core-send verdict for $0",
    (_name, partial, expected) => {
      const sendResult: MessageSendResult = {
        channel: "telegram",
        to: "chat-1",
        via: "direct",
        mediaUrl: null,
        ...partial,
      };
      const actionResult: MessageActionResult = {
        kind: "send",
        channel: "telegram",
        action: "send",
        to: "chat-1",
        handledBy: "core",
        payload: sendResult,
        sendResult,
        dryRun: sendResult.dryRun === true,
      };
      const fact = projectEmbeddedMessageDeliveryFact(actionResult);

      expect(fact?.status === "settled").toBe(expected);
    },
  );

  it.each([
    [
      "provider message id",
      { ok: true, payload: { ok: true, messageId: "plugin-message-1" } },
      true,
    ],
    ["provider bare ok", { ok: true, payload: { ok: true, to: "spaces/AAA" } }, true],
    [
      "provider suppressed status",
      { ok: true, payload: { ok: true, status: "suppressed" } },
      false,
    ],
    ["provider no-op marker", { ok: true, payload: { ok: true, changed: false } }, false],
    ["missing provider payload", { ok: true }, false],
    ["failed entry after partial delivery", { ok: false, sentBeforeError: true as const }, true],
  ] satisfies Array<[string, Record<string, unknown>, boolean]>)(
    "preserves the differential payload-only broadcast verdict for $0",
    (_name, entry, expected) => {
      const actionResult: MessageActionResult = {
        kind: "broadcast",
        channel: "googlechat",
        action: "broadcast",
        handledBy: "core",
        payload: {
          results: [{ channel: "googlechat", to: "space-1", ...entry }],
        },
        dryRun: false,
      };

      expect(projectEmbeddedMessageDeliveryFact(actionResult)?.status === "settled").toBe(expected);
      expect(
        isDeliveredMessagingToolResult({
          args: { action: "broadcast" },
          result: actionResult.payload,
        }),
      ).toBe(expected);
    },
  );

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

  it.each([
    ["suppressed", false],
    ["dry_run", false],
    ["failed", false],
    ["sent", true],
    ["partial_failed", true],
  ] as const)("maps plugin deliveryStatus %s to delivered=%s", (deliveryStatus, delivered) => {
    expect(
      isDeliveredMessagingToolResult({
        toolName: "message",
        args: { action: "send", to: "channel-1" },
        result: { ok: true, deliveryStatus },
      }),
    ).toBe(delivered);
  });

  it("rejects successful plugin broadcast wrappers around suppressed sends", () => {
    expect(
      isDeliveredMessagingToolResult({
        toolName: "message",
        args: { action: "broadcast" },
        result: {
          results: [{ ok: true, payload: { ok: true, status: "suppressed" } }],
        },
      }),
    ).toBe(false);
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
  it("accepts a confirmed adopted-thread reply outside message-tool-only mode", () => {
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "automatic",
        toolName: "message",
        args: { action: "thread-reply", threadId: "thread-1", message: "done" },
        result: {
          details: {
            ok: true,
            sourceReplyRoute: "current-source",
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects an unconfirmed thread reply outside message-tool-only mode", () => {
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "automatic",
        toolName: "message",
        args: { action: "thread-reply", threadId: "thread-1", message: "done" },
        result: { details: { ok: true } },
      }),
    ).toBe(false);
  });

  it("accepts a confirmed current-source poll delivery", () => {
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: { action: "poll", pollQuestion: "Preferred default?", pollOption: ["a", "b"] },
        result: {
          details: {
            ok: true,
            pollId: "poll-1",
            sourceReplyRoute: "current-source",
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects an unconfirmed poll delivery", () => {
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: { action: "poll", pollQuestion: "Preferred default?", pollOption: ["a", "b"] },
        result: { details: { ok: true, pollId: "poll-1" } },
      }),
    ).toBe(false);
  });

  it("accepts only confirmed implicit message sends", () => {
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: { action: "send", message: "reply" },
        result: { deliveryStatus: "sent" },
        deliveryConfirmed: true,
      }),
    ).toBe(true);
    expect(
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: "message_tool_only",
        toolName: "message",
        args: { action: "send", target: "elsewhere", message: "reply" },
        result: { deliveryStatus: "sent" },
        deliveryConfirmed: true,
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

describe("readMessageToolSourceReplyText", () => {
  it.each([
    {
      name: "reply",
      args: { action: "reply", message: "Visible reply" },
      expected: "Visible reply",
    },
    {
      name: "thread reply",
      args: { action: "thread-reply", text: "Visible thread reply" },
      expected: "Visible thread reply",
    },
    {
      name: "poll",
      args: { action: "poll", pollQuestion: "Preferred default?" },
      expected: "Preferred default?",
    },
    {
      name: "snake-case poll",
      args: { action: "poll", poll_question: "Ready?" },
      expected: "Ready?",
    },
  ])("reads $name visible text", ({ args, expected }) => {
    expect(readMessageToolSourceReplyText(args)).toBe(expected);
  });

  it("ignores non-source-reply actions", () => {
    expect(readMessageToolSourceReplyText({ action: "react", message: "not a reply" })).toBe(
      undefined,
    );
  });
});
