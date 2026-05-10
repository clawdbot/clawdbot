import { describe, expect, it } from "vitest";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

describe("parseTelegramTopicConversation", () => {
  it("parses direct chatId:topic:topicId strings", () => {
    expect(
      parseTelegramTopicConversation({
        conversationId: "-1001234567890:topic:42",
      }),
    ).toEqual({
      chatId: "-1001234567890",
      topicId: "42",
      canonicalConversationId: "-1001234567890:topic:42",
    });
  });

  it("parses a bare topic id against a group parentConversationId", () => {
    expect(
      parseTelegramTopicConversation({
        conversationId: "42",
        parentConversationId: "-1001234567890",
      }),
    ).toEqual({
      chatId: "-1001234567890",
      topicId: "42",
      canonicalConversationId: "-1001234567890:topic:42",
    });
  });

  it("returns null when a DM binding carries the chat id in both fields", () => {
    expect(
      parseTelegramTopicConversation({
        conversationId: "1234",
        parentConversationId: "1234",
      }),
    ).toBeNull();
  });

  it("returns null when neither shape matches", () => {
    expect(
      parseTelegramTopicConversation({
        conversationId: "not-a-topic",
      }),
    ).toBeNull();
  });

  it("returns null for a bare topic id without a parentConversationId", () => {
    expect(
      parseTelegramTopicConversation({
        conversationId: "42",
      }),
    ).toBeNull();
  });
});
