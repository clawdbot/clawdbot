import { describe, expect, it } from "vitest";
import {
  createAllowedChatSenderMatcher,
  isAllowedParsedChatSender,
  type ParsedChatAllowTarget,
} from "./chat-target-prefixes.js";

function normalizeSender(sender: string): string {
  return sender.trim().toLowerCase();
}

function parseAllowTarget(entry: string): ParsedChatAllowTarget {
  const trimmed = entry.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("chat_id:")) {
    return { kind: "chat_id", chatId: Number.parseInt(trimmed.slice("chat_id:".length), 10) };
  }
  if (lower.startsWith("chat_guid:")) {
    return { kind: "chat_guid", chatGuid: trimmed.slice("chat_guid:".length).trim() };
  }
  if (lower.startsWith("chat_identifier:")) {
    return {
      kind: "chat_identifier",
      chatIdentifier: trimmed.slice("chat_identifier:".length).trim(),
    };
  }
  return { kind: "handle", handle: normalizeSender(trimmed) };
}

describe("isAllowedParsedChatSender", () => {
  it("matches wildcard and normalized sender handles", () => {
    expect(
      isAllowedParsedChatSender({
        allowFrom: ["owner@example.com"],
        sender: "Owner@Example.com",
        normalizeSender,
        parseAllowTarget,
      }),
    ).toBe(true);

    expect(
      isAllowedParsedChatSender({
        allowFrom: ["*"],
        sender: "other@example.com",
        normalizeSender,
        parseAllowTarget,
      }),
    ).toBe(true);
  });

  it("does not match conversation targets unless explicitly enabled", () => {
    for (const entry of ["chat_id:123", "chat_guid:thread-123", "chat_identifier:team"]) {
      expect(
        isAllowedParsedChatSender({
          allowFrom: [entry],
          sender: "other@example.com",
          chatId: 123,
          chatGuid: "thread-123",
          chatIdentifier: "team",
          normalizeSender,
          parseAllowTarget,
        }),
      ).toBe(false);

      expect(
        isAllowedParsedChatSender({
          allowFrom: [entry],
          sender: "other@example.com",
          chatId: 123,
          chatGuid: "thread-123",
          chatIdentifier: "team",
          allowConversationTargets: true,
          normalizeSender,
          parseAllowTarget,
        }),
      ).toBe(true);
    }
  });
});

describe("createAllowedChatSenderMatcher", () => {
  it("keeps conversation targets disabled unless the matcher opts in", () => {
    const matcher = createAllowedChatSenderMatcher({
      normalizeSender,
      parseAllowTarget,
    });

    for (const entry of ["chat_id:123", "chat_guid:thread-123", "chat_identifier:team"]) {
      expect(
        matcher({
          allowFrom: [entry],
          sender: "other@example.com",
          chatId: 123,
          chatGuid: "thread-123",
          chatIdentifier: "team",
        }),
      ).toBe(false);
    }
  });

  it("matches conversation targets when the matcher explicitly opts in", () => {
    const matcher = createAllowedChatSenderMatcher({
      normalizeSender,
      parseAllowTarget,
      allowConversationTargets: true,
    });

    for (const entry of ["chat_id:123", "chat_guid:thread-123", "chat_identifier:team"]) {
      expect(
        matcher({
          allowFrom: [entry],
          sender: "other@example.com",
          chatId: 123,
          chatGuid: "thread-123",
          chatIdentifier: "team",
        }),
      ).toBe(true);
    }
  });
});
