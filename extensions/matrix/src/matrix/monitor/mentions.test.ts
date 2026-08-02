// Matrix tests cover mentions plugin behavior.
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

    it.each([
      {
        label: "full Matrix user ID",
        mentionedUserId: "@bot:matrix.org",
        body: "hello @bot:matrix.org",
      },
      {
        label: "localpart shorthand",
        mentionedUserId: "@bot:matrix.org",
        body: "hello @bot",
      },
      {
        label: "colon-delimited shorthand",
        mentionedUserId: "@bot:matrix.org",
        body: "@bot: hello",
      },
      {
        label: "parenthesized shorthand",
        mentionedUserId: "@bot:matrix.org",
        body: "hello (@bot)",
      },
      {
        label: "sentence-ending full Matrix user ID",
        mentionedUserId: "@bot:matrix.org",
        body: "hello @bot:matrix.org.",
      },
      {
        label: "special localpart characters",
        mentionedUserId: "@foo/bar+baz=ok:matrix.org",
        body: "hello @foo/bar+baz=ok",
      },
      {
        label: "bracketed IPv6 homeserver and port",
        mentionedUserId: "@bot:[2001:db8::1]:8448",
        body: "hello @bot:[2001:db8::1]:8448.",
      },
    ])(
      "detects native plain-text $label without configured mention patterns",
      ({ mentionedUserId, body }) => {
        const params = {
          content: {
            msgtype: "m.text",
            body,
            "m.mentions": { user_ids: [mentionedUserId] },
          },
          userId: mentionedUserId,
          text: body,
          mentionRegexes: [],
        };
        const expected = { wasMentioned: true, hasExplicitMention: true };

        expect(resolveMentions(params)).toEqual(expected);
        expect(resolveMentions(params)).toEqual(expected);
      },
    );

    it.each([
      { label: "same localpart on another homeserver", body: "hello @bot:evil.example" },
      { label: "case-different homeserver", body: "hello @bot:MATRIX.ORG" },
      { label: "extended DNS homeserver", body: "hello @bot:matrix.org.evil" },
      { label: "unexpected homeserver port", body: "hello @bot:matrix.org:8448" },
      { label: "alternate IPv6 homeserver", body: "hello @bot:[::1]" },
      { label: "extended dotted localpart", body: "hello @bot.extra" },
      { label: "extended plus localpart", body: "hello @bot+evil" },
      { label: "extended hyphenated localpart", body: "hello @bot-evil" },
      { label: "extended slash localpart", body: "hello @bot/evil" },
      { label: "embedded email token", body: "hello contact@bot" },
      { label: "adjacent mention prefix", body: "hello @@bot" },
      { label: "zero-width foreign homeserver", body: "hello @bot\u200b:evil.example" },
      { label: "zero-width domain extension", body: "hello @bot:matrix.org\u200b.evil" },
      { label: "bidirectional foreign homeserver", body: "hello @bot\u202e:evil.example" },
      { label: "BOM foreign homeserver", body: "hello @bot\ufeff:evil.example" },
      { label: "invisible combining grapheme joiner", body: "hello @bot\u034f:evil.example" },
      { label: "invisible variation selector", body: "hello @bot\ufe0f:evil.example" },
      { label: "invisible Hangul filler", body: "hello @bot\u3164:evil.example" },
    ])("rejects forged native mention metadata for $label", ({ body }) => {
      expect(
        resolveMentions({
          content: {
            msgtype: "m.text",
            body,
            "m.mentions": { user_ids: [userId] },
          },
          userId,
          text: body,
          mentionRegexes: [],
        }),
      ).toEqual({ wasMentioned: false, hasExplicitMention: false });
    });

    it("requires metadata to name the exact account even when that account is visibly mentioned", () => {
      const body = "hello @bot:matrix.org";

      expect(
        resolveMentions({
          content: {
            msgtype: "m.text",
            body,
            "m.mentions": { user_ids: ["@bot:evil.example"] },
          },
          userId,
          text: body,
          mentionRegexes: [],
        }),
      ).toEqual({ wasMentioned: false, hasExplicitMention: false });
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

    it("detects mention when the visible label is bracketed @displayName text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "@[Display Name] please reply",
          formatted_body:
            '<a href="https://matrix.to/#/@bot:matrix.org">@[Display Name]</a> please reply',
          "m.mentions": { user_ids: ["@bot:matrix.org"] },
        },
        userId,
        displayName: "Display Name",
        text: "@[Display Name] please reply",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
      expect(result.hasExplicitMention).toBe(true);
    });

    it("ignores out-of-range hexadecimal HTML entities in visible labels", () => {
      expect(
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
      ).toEqual({ hasExplicitMention: false, wasMentioned: false });
    });

    it("ignores oversized decimal HTML entities in visible labels", () => {
      expect(
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
      ).toEqual({ hasExplicitMention: false, wasMentioned: false });
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
