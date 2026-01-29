import { describe, expect, it } from "vitest";
import type { MessageHandlerConfig } from "../config/types.hooks.js";
import type { MessageReceivedHookContext } from "./internal-hooks.js";
import { matchMessageHandler } from "./message-handler-match.js";

function createContext(
  overrides: Partial<MessageReceivedHookContext> = {},
): MessageReceivedHookContext {
  return {
    from: "+1234567890",
    content: "Hello world",
    timestamp: Date.now(),
    channelId: "whatsapp",
    accountId: "default",
    conversationId: "chat-123",
    metadata: {
      to: "bot",
      provider: "whatsapp",
      surface: "whatsapp",
      senderId: "user-1",
      senderName: "Test User",
    },
    ...overrides,
  };
}

function createHandler(overrides: Partial<MessageHandlerConfig> = {}): MessageHandlerConfig {
  return {
    id: "test-handler",
    action: "agent",
    match: {},
    ...overrides,
  };
}

describe("matchMessageHandler", () => {
  describe("channelId matching", () => {
    it("matches single channelId", () => {
      const handlers = [createHandler({ match: { channelId: "whatsapp" } })];
      const ctx = createContext({ channelId: "whatsapp" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("matches channelId from array", () => {
      const handlers = [createHandler({ match: { channelId: ["telegram", "whatsapp"] } })];
      const ctx = createContext({ channelId: "whatsapp" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("does not match wrong channelId", () => {
      const handlers = [createHandler({ match: { channelId: "telegram" } })];
      const ctx = createContext({ channelId: "whatsapp" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBeNull();
    });

    it("matches wildcard channelId", () => {
      const handlers = [createHandler({ match: { channelId: "*" } })];
      const ctx = createContext({ channelId: "discord" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });
  });

  describe("conversationId matching", () => {
    it("matches single conversationId", () => {
      const handlers = [createHandler({ match: { conversationId: "chat-123" } })];
      const ctx = createContext({ conversationId: "chat-123" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("matches conversationId from array", () => {
      const handlers = [
        createHandler({ match: { conversationId: ["chat-111", "chat-123", "chat-456"] } }),
      ];
      const ctx = createContext({ conversationId: "chat-123" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("does not match wrong conversationId", () => {
      const handlers = [createHandler({ match: { conversationId: "chat-999" } })];
      const ctx = createContext({ conversationId: "chat-123" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBeNull();
    });

    it("does not match when conversationId is undefined", () => {
      const handlers = [createHandler({ match: { conversationId: "chat-123" } })];
      const ctx = createContext({ conversationId: undefined });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBeNull();
    });
  });

  describe("from matching", () => {
    it("matches single from value", () => {
      const handlers = [createHandler({ match: { from: "+1234567890" } })];
      const ctx = createContext({ from: "+1234567890" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("matches from array", () => {
      const handlers = [createHandler({ match: { from: ["+1111111111", "+1234567890"] } })];
      const ctx = createContext({ from: "+1234567890" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("does not match wrong from", () => {
      const handlers = [createHandler({ match: { from: "+9999999999" } })];
      const ctx = createContext({ from: "+1234567890" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBeNull();
    });
  });

  describe("contentPattern matching", () => {
    it("matches simple regex pattern", () => {
      const handlers = [createHandler({ match: { contentPattern: "hello" } })];
      const ctx = createContext({ content: "Hello world" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("matches complex regex pattern", () => {
      const handlers = [createHandler({ match: { contentPattern: "bug|error|broken" } })];
      const ctx = createContext({ content: "There is an error in the code" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("does not match when pattern not found", () => {
      const handlers = [createHandler({ match: { contentPattern: "urgent" } })];
      const ctx = createContext({ content: "This is a normal message" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBeNull();
    });

    it("handles invalid regex gracefully", () => {
      const handlers = [createHandler({ match: { contentPattern: "[invalid(" } })];
      const ctx = createContext({ content: "Some content" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBeNull();
    });

    it("rejects unsafe regex patterns (ReDoS protection)", () => {
      // This pattern causes catastrophic backtracking: (a+)+ on "aaaaaaaaaaaaaaaaaaaaaaaa!"
      const handlers = [createHandler({ match: { contentPattern: "(a+)+" } })];
      const ctx = createContext({ content: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBeNull(); // Unsafe pattern should be rejected
    });

    it("allows safe regex patterns", () => {
      const handlers = [createHandler({ match: { contentPattern: "bug|error|broken" } })];
      const ctx = createContext({ content: "Found a bug" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });
  });

  describe("contentContains matching", () => {
    it("matches single keyword", () => {
      const handlers = [createHandler({ match: { contentContains: "bug" } })];
      const ctx = createContext({ content: "There is a bug in the system" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("matches keyword array (any match)", () => {
      const handlers = [createHandler({ match: { contentContains: ["bug", "error", "issue"] } })];
      const ctx = createContext({ content: "Found an issue with the login" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("matches case-insensitively", () => {
      const handlers = [createHandler({ match: { contentContains: "BUG" } })];
      const ctx = createContext({ content: "there is a bug here" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("does not match when no keywords found", () => {
      const handlers = [createHandler({ match: { contentContains: ["urgent", "critical"] } })];
      const ctx = createContext({ content: "This is a normal message" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBeNull();
    });
  });

  describe("combined conditions", () => {
    it("matches when all conditions are met", () => {
      const handlers = [
        createHandler({
          match: {
            channelId: "whatsapp",
            conversationId: "chat-123",
            contentContains: "bug",
          },
        }),
      ];
      const ctx = createContext({
        channelId: "whatsapp",
        conversationId: "chat-123",
        content: "Found a bug",
      });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("does not match when one condition fails", () => {
      const handlers = [
        createHandler({
          match: {
            channelId: "whatsapp",
            conversationId: "chat-123",
            contentContains: "bug",
          },
        }),
      ];
      const ctx = createContext({
        channelId: "whatsapp",
        conversationId: "chat-123",
        content: "Normal message", // no "bug" keyword
      });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBeNull();
    });
  });

  describe("enabled flag", () => {
    it("skips disabled handlers", () => {
      const handlers = [
        createHandler({ id: "disabled", enabled: false, match: { channelId: "whatsapp" } }),
        createHandler({ id: "enabled", match: { channelId: "whatsapp" } }),
      ];
      const ctx = createContext({ channelId: "whatsapp" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result?.id).toBe("enabled");
    });

    it("includes handlers with enabled=true explicitly", () => {
      const handlers = [createHandler({ enabled: true, match: { channelId: "whatsapp" } })];
      const ctx = createContext({ channelId: "whatsapp" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });

    it("includes handlers with enabled=undefined (default)", () => {
      const handlers = [createHandler({ match: { channelId: "whatsapp" } })];
      const ctx = createContext({ channelId: "whatsapp" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });
  });

  describe("first-match wins", () => {
    it("returns the first matching handler", () => {
      const handlers = [
        createHandler({ id: "first", match: { channelId: "whatsapp" } }),
        createHandler({ id: "second", match: { channelId: "whatsapp" } }),
        createHandler({ id: "third", match: { channelId: "whatsapp" } }),
      ];
      const ctx = createContext({ channelId: "whatsapp" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result?.id).toBe("first");
    });

    it("skips non-matching handlers to find first match", () => {
      const handlers = [
        createHandler({ id: "no-match-1", match: { channelId: "telegram" } }),
        createHandler({ id: "no-match-2", match: { contentContains: "urgent" } }),
        createHandler({ id: "match", match: { channelId: "whatsapp" } }),
        createHandler({ id: "also-match", match: { channelId: "whatsapp" } }),
      ];
      const ctx = createContext({ channelId: "whatsapp", content: "Hello" });

      const result = matchMessageHandler(handlers, ctx);
      expect(result?.id).toBe("match");
    });
  });

  describe("empty handlers", () => {
    it("returns null for empty handlers array", () => {
      const result = matchMessageHandler([], createContext());
      expect(result).toBeNull();
    });
  });

  describe("empty match conditions", () => {
    // NOTE: At the matching logic level, empty match still matches everything.
    // However, Zod config validation now requires at least one condition,
    // so this scenario won't occur in practice with config-driven handlers.
    // This test verifies the matching logic behavior for completeness.
    it("matches any message when match is empty (prevented by config validation)", () => {
      const handlers = [createHandler({ match: {} })];
      const ctx = createContext();

      const result = matchMessageHandler(handlers, ctx);
      expect(result).toBe(handlers[0]);
    });
  });
});
