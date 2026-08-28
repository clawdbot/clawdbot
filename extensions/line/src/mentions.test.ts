// Line tests cover native mention facts from webhook text messages.
import type { webhook } from "@line/bot-sdk";
import { describe, expect, it } from "vitest";
import {
  hasAnyLineMention,
  isLineBotMentioned,
  resolveLineMentionStrippedText,
} from "./mentions.js";

type MessageContent = webhook.MessageEvent["message"];

const textMessage = (text: string, mentionees: webhook.Mentionee[] = []): MessageContent =>
  ({
    id: "m-1",
    type: "text",
    text,
    quoteToken: "quote-token",
    ...(mentionees.length > 0 ? { mention: { mentionees } } : {}),
  }) satisfies webhook.TextMessageContent;

const selfMention = (index: number, length: number): webhook.Mentionee => ({
  type: "user",
  index,
  length,
  userId: "Ubot",
  isSelf: true,
});

const memberMention = (index: number, length: number): webhook.Mentionee => ({
  type: "user",
  index,
  length,
  userId: "Umember",
  isSelf: false,
});

describe("resolveLineMentionStrippedText", () => {
  it("removes the bot mention so a group slash command still parses as a command", () => {
    const message = textMessage("@openclaw3 /status", [selfMention(0, 10)]);

    expect(resolveLineMentionStrippedText(message)).toBe("/status");
  });

  it("uses LINE's UTF-16 offsets, so an astral character before the mention does not shift it", () => {
    // LINE counts webhook text in UTF-16 code units, so "🍎" occupies two of
    // them and the mention starts at index 3 — the same unit `slice` uses.
    const message = textMessage("🍎 @openclaw3 /status", [selfMention(3, 10)]);

    expect(resolveLineMentionStrippedText(message)).toBe("🍎  /status");
  });

  it("keeps another member's mention, which is not addressed to the bot", () => {
    const message = textMessage("@Alice @openclaw3 /status", [
      memberMention(0, 6),
      selfMention(7, 10),
    ]);

    expect(resolveLineMentionStrippedText(message)).toBe("@Alice  /status");
  });

  it("removes an @all mention, which addresses the bot like a direct mention", () => {
    const message = textMessage("@All /status", [{ type: "all", index: 0, length: 4 }]);

    expect(resolveLineMentionStrippedText(message)).toBe("/status");
  });

  it("keeps a command's multi-line tail intact", () => {
    const message = textMessage("@openclaw3 /think hard\nsecond line", [selfMention(0, 10)]);

    expect(resolveLineMentionStrippedText(message)).toBe("/think hard\nsecond line");
  });

  it("returns the text unchanged when nothing mentioned the bot", () => {
    expect(resolveLineMentionStrippedText(textMessage("/status"))).toBe("/status");
    expect(resolveLineMentionStrippedText(textMessage("@Alice hi", [memberMention(0, 6)]))).toBe(
      "@Alice hi",
    );
  });

  it("has no text to project for a non-text message", () => {
    const sticker = {
      id: "m-2",
      type: "sticker",
      packageId: "1",
      stickerId: "2",
      stickerResourceType: "STATIC",
      quoteToken: "quote-token",
    } satisfies webhook.StickerMessageContent;

    expect(resolveLineMentionStrippedText(sticker)).toBe("");
  });
});

describe("line mention facts", () => {
  it("treats a self mention and an @all mention as addressing the bot", () => {
    expect(isLineBotMentioned(textMessage("@openclaw3 hi", [selfMention(0, 10)]))).toBe(true);
    expect(isLineBotMentioned(textMessage("@All hi", [{ type: "all", index: 0, length: 4 }]))).toBe(
      true,
    );
    expect(isLineBotMentioned(textMessage("@Alice hi", [memberMention(0, 6)]))).toBe(false);
    expect(isLineBotMentioned(textMessage("hi"))).toBe(false);
  });

  it("reports any mention separately from one that addresses the bot", () => {
    expect(hasAnyLineMention(textMessage("@Alice hi", [memberMention(0, 6)]))).toBe(true);
    expect(hasAnyLineMention(textMessage("hi"))).toBe(false);
  });
});
