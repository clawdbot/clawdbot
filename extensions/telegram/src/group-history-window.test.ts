// Telegram tests cover group history window prompt-context retention.
import { describe, expect, it } from "vitest";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";
import { retainTelegramGroupHistoryPromptContext } from "./group-history-window.js";

function chatWindowEntry(messages: Record<string, unknown>[]): TelegramPromptContextEntry {
  return {
    label: "Conversation context",
    source: "telegram",
    type: "chat_window",
    payload: {
      order: "chronological",
      relation: "selected_for_current_message",
      messages,
    },
  };
}

describe("retainTelegramGroupHistoryPromptContext", () => {
  it("keeps a reply-target message even when it has no matching history entry", () => {
    const replyTargetMessage = {
      message_id: "5",
      sender: "Pat",
      body: "Original message being replied to",
      is_reply_target: true,
    };
    const promptContext = [chatWindowEntry([replyTargetMessage])];

    const result = retainTelegramGroupHistoryPromptContext({
      promptContext,
      // No buffered group history entries at all — previously this made the
      // whole chat_window entry disappear, taking the reply target with it.
      entries: [],
    });

    expect(result).toHaveLength(1);
    const payload = result[0]?.payload as { messages: Record<string, unknown>[] };
    expect(payload.messages).toEqual([replyTargetMessage]);
  });

  it("drops non-reply-target messages that have no matching history entry", () => {
    const replyTargetMessage = {
      message_id: "5",
      sender: "Pat",
      body: "Original message being replied to",
      is_reply_target: true,
    };
    const unmatchedMessage = {
      message_id: "6",
      sender: "Sam",
      body: "Some other message not in the retained history window",
    };
    const promptContext = [chatWindowEntry([replyTargetMessage, unmatchedMessage])];

    const result = retainTelegramGroupHistoryPromptContext({
      promptContext,
      entries: [],
    });

    const payload = result[0]?.payload as { messages: Record<string, unknown>[] };
    expect(payload.messages).toEqual([replyTargetMessage]);
  });

  it("keeps a non-reply-target message when its key matches a history entry", () => {
    const matchedMessage = {
      message_id: "7",
      sender: "Sam",
      body: "This message is still within the retained history window",
    };
    const promptContext = [chatWindowEntry([matchedMessage])];

    const result = retainTelegramGroupHistoryPromptContext({
      promptContext,
      entries: [{ sender: "Sam", body: "unused", messageId: "7" }],
    });

    const payload = result[0]?.payload as { messages: Record<string, unknown>[] };
    expect(payload.messages).toEqual([matchedMessage]);
  });

  it("drops the chat_window entry entirely when no messages survive filtering", () => {
    const unmatchedMessage = {
      message_id: "6",
      sender: "Sam",
      body: "Not a reply target and not in history",
    };
    const promptContext = [chatWindowEntry([unmatchedMessage])];

    const result = retainTelegramGroupHistoryPromptContext({
      promptContext,
      entries: [],
    });

    expect(result).toEqual([]);
  });

  it("leaves non-chat_window prompt context entries untouched", () => {
    const otherEntry: TelegramPromptContextEntry = {
      label: "Other context",
      source: "telegram",
      type: "reply_chain",
      payload: { note: "not a chat window" },
    };
    const promptContext = [otherEntry];

    const result = retainTelegramGroupHistoryPromptContext({
      promptContext,
      entries: [],
    });

    expect(result).toEqual([otherEntry]);
  });
});
