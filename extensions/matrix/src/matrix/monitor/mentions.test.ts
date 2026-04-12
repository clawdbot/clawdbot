import { describe, expect, it, vi } from "vitest";

// Mock the runtime before importing resolveMentions
vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    channel: {
      mentions: {
        matchesMentionPatterns: (text: string, patterns: RegExp[]) =>
          patterns.some((p) => p.test(text)),
      },
    },
  }),
}));

import { resolveMentions } from "./mentions.js";

describe("resolveMentions", () => {
  const userId = "@bot:matrix.org";
  const mentionRegexes = [/@bot/i];

  describe("m.mentions field", () => {
    it("detects mention via m.mentions.user_ids when the visible text also mentions the bot", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "hello @bot",
          "m.mentions": { user_ids: ["@bot:matrix.org"] },
        },
        userId,
        text: "hello @bot",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(true);
      expect(result.hasExplicitMention).toBe(true);
    });

    it("does not trust m.mentions.user_ids without a visible text or formatted mention", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "please reply",
          "m.mentions": { user_ids: ["@bot:matrix.org"] },
        },
        userId,
        text: "please reply",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(false);
      expect(result.hasExplicitMention).toBe(false);
    });

    it("detects room mention via visible @room text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "@room hello everyone",
          "m.mentions": { room: true },
        },
        userId,
        text: "@room hello everyone",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("does not trust forged m.mentions.room without visible @room text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "hello everyone",
          "m.mentions": { room: true },
        },
        userId,
        text: "hello everyone",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(false);
      expect(result.hasExplicitMention).toBe(false);
    });
  });

  describe("formatted_body matrix.to links", () => {
    it("detects mention in formatted_body with plain user ID", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">Bot</a>: hello',
        },
        userId,
        text: "Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention in formatted_body with URL-encoded user ID", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/%40bot%3Amatrix.org">Bot</a>: hello',
        },
        userId,
        text: "Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention with single quotes in href", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Bot: hello",
          formatted_body: "<a href='https://matrix.to/#/@bot:matrix.org'>Bot</a>: hello",
        },
        userId,
        text: "Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("does not detect mention for different user ID", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Other: hello",
          formatted_body: '<a href="https://matrix.to/#/@other:matrix.org">Other</a>: hello',
        },
        userId,
        text: "Other: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(false);
    });

    it("does not false-positive on partial user ID match", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Bot2: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot2:matrix.org">Bot2</a>: hello',
        },
        userId: "@bot:matrix.org",
        text: "Bot2: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(false);
    });

    it("does not trust hidden matrix.to links behind unrelated visible text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "click here: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">click here</a>: hello',
        },
        userId,
        text: "click here: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(false);
    });

    it("detects mention when the visible label still names the bot", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "@bot: hello",
          formatted_body:
            '<a href="https://matrix.to/#/@bot:matrix.org"><span>@bot</span></a>: hello',
        },
        userId,
        text: "@bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention when the visible label matches the bot's displayName", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Wonderful Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">Wonderful Bot</a>: hello',
        },
        userId,
        displayName: "Wonderful Bot",
        text: "Wonderful Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention when the visible label encodes the bot's displayName", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "R&D Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">R&amp;D Bot</a>: hello',
        },
        userId,
        displayName: "R&D Bot",
        text: "R&D Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention when the visible label is @displayName with Unicode text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "@欢欢 please reply",
          formatted_body:
            '<a href="https://matrix.to/#/@huanhuan:localhost">@欢欢</a> please reply',
          "m.mentions": { user_ids: ["@huanhuan:localhost"] },
        },
        userId: "@huanhuan:localhost",
        displayName: "欢欢",
        text: "@欢欢 please reply",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
      expect(result.hasExplicitMention).toBe(true);
    });

    it("ignores out-of-range hexadecimal HTML entities in visible labels", () => {
      expect(() =>
        resolveMentions({
          content: {
            msgtype: "m.text",
            body: "hello",
            formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">&#x110000;</a>: hello',
          },
          userId,
          text: "hello",
          mentionRegexes: [],
        }),
      ).not.toThrow();
    });

    it("ignores oversized decimal HTML entities in visible labels", () => {
      expect(() =>
        resolveMentions({
          content: {
            msgtype: "m.text",
            body: "hello",
            formatted_body:
              '<a href="https://matrix.to/#/@bot:matrix.org">&#9999999999999999999999999999999999999999;</a>: hello',
          },
          userId,
          text: "hello",
          mentionRegexes: [],
        }),
      ).not.toThrow();
    });

    it("does not detect mention when displayName is spoofed", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Spoofed Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">Spoofed Bot</a>: hello',
        },
        userId,
        displayName: "Alice",
        text: "Spoofed Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(false);
    });
  });

  describe("regex patterns", () => {
    it("detects mention via regex pattern in body text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "hey @bot can you help?",
        },
        userId,
        text: "hey @bot can you help?",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(true);
    });
  });

  describe("no mention", () => {
    it("returns false when no mention is present", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "hello world",
        },
        userId,
        text: "hello world",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(false);
      expect(result.hasExplicitMention).toBe(false);
    });
  });
});
