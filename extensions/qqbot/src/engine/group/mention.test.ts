import { describe, expect, it } from "vitest";
import {
  detectWasMentioned,
  hasAnyMention,
  resolveImplicitMention,
  stripMentionText,
} from "./mention.js";

describe("engine/group/mention", () => {
  describe("detectWasMentioned", () => {
    it("returns true when mentions contains is_you", () => {
      expect(detectWasMentioned({ mentions: [{ is_you: true }] })).toBe(true);
    });

    it("returns true for GROUP_AT_MESSAGE_CREATE even without mentions", () => {
      expect(detectWasMentioned({ eventType: "GROUP_AT_MESSAGE_CREATE" })).toBe(true);
    });

    it("matches by mentionPatterns regex", () => {
      expect(
        detectWasMentioned({ content: "@xiaoke help me", mentionPatterns: ["^@xiaoke"] }),
      ).toBe(true);
    });

    it("returns false when no signal matches", () => {
      expect(
        detectWasMentioned({
          eventType: "GROUP_MESSAGE_CREATE",
          mentions: [{ member_openid: "USER1" }],
          content: "hello",
          mentionPatterns: ["^@bot"],
        }),
      ).toBe(false);
    });

    it("ignores invalid regex patterns gracefully", () => {
      // "[" is an invalid regex; should not throw.
      expect(detectWasMentioned({ content: "hi", mentionPatterns: ["[", "@bot"] })).toBe(false);
    });

    it("matches case-insensitively", () => {
      expect(detectWasMentioned({ content: "Hello @Bot", mentionPatterns: ["@bot"] })).toBe(true);
    });

    it("skips empty patterns", () => {
      expect(detectWasMentioned({ content: "hi", mentionPatterns: ["", "  "] })).toBe(false);
    });

    it("returns false when everything is empty", () => {
      expect(detectWasMentioned({})).toBe(false);
    });
  });

  describe("hasAnyMention", () => {
    it("detects mentions array", () => {
      expect(hasAnyMention({ mentions: [{ member_openid: "X" }] })).toBe(true);
    });

    it("detects mention tags in text", () => {
      expect(hasAnyMention({ content: "hi <@ABC123>" })).toBe(true);
      expect(hasAnyMention({ content: "hi <@!ABC123>" })).toBe(true);
    });

    it("returns false when nothing mentioned", () => {
      expect(hasAnyMention({ content: "just a normal message" })).toBe(false);
      expect(hasAnyMention({})).toBe(false);
    });
  });

  describe("stripMentionText", () => {
    it("removes self-mention tag", () => {
      expect(stripMentionText("<@BOTID> hello", [{ member_openid: "BOTID", is_you: true }])).toBe(
        "hello",
      );
    });

    it("replaces other-user tag with @nickname", () => {
      expect(stripMentionText("hi <@USER1>", [{ member_openid: "USER1", nickname: "Alice" }])).toBe(
        "hi @Alice",
      );
    });

    it("falls back to username when nickname missing", () => {
      expect(stripMentionText("hi <@USER1>", [{ member_openid: "USER1", username: "alice" }])).toBe(
        "hi @alice",
      );
    });

    it("leaves unknown mentions untouched", () => {
      // No display name, so the tag cannot be prettified — keep raw.
      expect(stripMentionText("hi <@USER1>", [{ member_openid: "USER1" }])).toBe("hi <@USER1>");
    });

    it("handles <@!openid> variant", () => {
      expect(stripMentionText("hi <@!USER1>", [{ member_openid: "USER1", nickname: "A" }])).toBe(
        "hi @A",
      );
    });

    it("returns the original text when no mentions array is provided", () => {
      expect(stripMentionText("hi <@X>", [])).toBe("hi <@X>");
      expect(stripMentionText("hi <@X>")).toBe("hi <@X>");
    });

    it("escapes regex meta-characters in openid", () => {
      // Defensive: even if QQ ever sends openids with unusual characters,
      // the function should not explode nor produce a bogus regex.
      expect(stripMentionText("see <@A.B+C>", [{ member_openid: "A.B+C", nickname: "X" }])).toBe(
        "see @X",
      );
    });
  });

  describe("resolveImplicitMention", () => {
    it("returns false when refMsgIdx is missing", () => {
      expect(resolveImplicitMention({ getRefEntry: () => null })).toBe(false);
    });

    it("returns true when the referenced entry is a bot message", () => {
      expect(
        resolveImplicitMention({
          refMsgIdx: "R1",
          getRefEntry: (id) => (id === "R1" ? { isBot: true } : null),
        }),
      ).toBe(true);
    });

    it("returns false when ref entry exists but is not a bot", () => {
      expect(
        resolveImplicitMention({
          refMsgIdx: "R1",
          getRefEntry: () => ({ isBot: false }),
        }),
      ).toBe(false);
    });

    it("returns false when ref entry is missing", () => {
      expect(resolveImplicitMention({ refMsgIdx: "R1", getRefEntry: () => null })).toBe(false);
    });
  });
});
