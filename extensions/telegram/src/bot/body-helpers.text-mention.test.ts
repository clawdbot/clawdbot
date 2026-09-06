import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { hasBotMention } from "./body-helpers.js";

function asTelegramMessage(message: unknown): Message {
  return message as Message;
}

const BOT_ID = 42;

describe("hasBotMention text_mention resolution", () => {
  it("matches a text_mention entity that resolves to this bot id", () => {
    // Tapping the bot's display name yields a text_mention (entity text is the
    // display name, not @username), which the `mention` branch never matches.
    expect(
      hasBotMention(
        asTelegramMessage({
          text: "Gaian what is the group id?",
          entities: [
            {
              type: "text_mention",
              offset: 0,
              length: 5,
              user: { id: BOT_ID, is_bot: true, first_name: "Gaian" },
            },
          ],
          chat: { id: 1, type: "supergroup" },
        }),
        "gaian",
        BOT_ID,
      ),
    ).toBe(true);
  });

  it("does not match a text_mention entity for a different user id", () => {
    expect(
      hasBotMention(
        asTelegramMessage({
          text: "Alice what is the group id?",
          entities: [
            {
              type: "text_mention",
              offset: 0,
              length: 5,
              user: { id: 999, is_bot: false, first_name: "Alice" },
            },
          ],
          chat: { id: 1, type: "supergroup" },
        }),
        "gaian",
        BOT_ID,
      ),
    ).toBe(false);
  });

  it("ignores text_mention resolution when no bot id is provided", () => {
    // Back-compat: callers that do not pass a bot id keep the previous behaviour.
    expect(
      hasBotMention(
        asTelegramMessage({
          text: "Gaian what is the group id?",
          entities: [
            {
              type: "text_mention",
              offset: 0,
              length: 5,
              user: { id: BOT_ID, is_bot: true, first_name: "Gaian" },
            },
          ],
          chat: { id: 1, type: "supergroup" },
        }),
        "gaian",
      ),
    ).toBe(false);
  });

  it("still matches an @username mention entity when a bot id is also provided", () => {
    // Passing a bot id must not regress the existing @username mention path.
    expect(
      hasBotMention(
        asTelegramMessage({
          text: "@gaian hello",
          entities: [{ type: "mention", offset: 0, length: 6 }],
          chat: { id: 1, type: "supergroup" },
        }),
        "gaian",
        BOT_ID,
      ),
    ).toBe(true);
  });

  it("matches a text_mention that targets the bot in a caption", () => {
    // getTelegramTextParts falls back to caption + caption_entities, so a
    // display-name tag on a media message must be recognized too.
    expect(
      hasBotMention(
        asTelegramMessage({
          caption: "Gaian look at this",
          caption_entities: [
            {
              type: "text_mention",
              offset: 0,
              length: 5,
              user: { id: BOT_ID, is_bot: true, first_name: "Gaian" },
            },
          ],
          chat: { id: 1, type: "supergroup" },
        }),
        "gaian",
        BOT_ID,
      ),
    ).toBe(true);
  });

  it("does not match (and does not throw) a text_mention entity with no user", () => {
    // Defensive: a malformed text_mention without a user object must be ignored.
    expect(
      hasBotMention(
        asTelegramMessage({
          text: "Gaian hello",
          entities: [{ type: "text_mention", offset: 0, length: 5 }],
          chat: { id: 1, type: "supergroup" },
        }),
        "gaian",
        BOT_ID,
      ),
    ).toBe(false);
  });
});
