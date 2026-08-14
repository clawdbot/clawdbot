import type { Message, MessageEntity } from "grammy/types";
import { describe, expect, it } from "vitest";
import { getTelegramTextParts, joinTelegramTextParts } from "./body-helpers.js";
import { renderTelegramTextEntities } from "./inbound-text-entities.js";

function asTelegramMessage(message: unknown): Message {
  return message as Message;
}

describe("getTelegramTextParts", () => {
  it("projects native Telegram polls into bounded, accurate inbound text", () => {
    const result = getTelegramTextParts(
      asTelegramMessage({
        poll: {
          id: "poll-1",
          question: "Ship the release?",
          options: [
            { persistent_id: "yes", text: "Yes", voter_count: 2 },
            { persistent_id: "no", text: "No", voter_count: 1 },
          ],
          total_voter_count: 3,
          is_closed: false,
          is_anonymous: false,
          type: "quiz",
          allows_multiple_answers: false,
          correct_option_ids: [0],
          description: "Read docs",
          description_entities: [
            { type: "text_link", offset: 5, length: 4, url: "https://docs.example" },
          ],
          explanation: "All checks passed.",
          explanation_entities: [{ type: "bold", offset: 0, length: 3 }],
        },
      }),
    );

    expect(result).toEqual({
      text: [
        "[Poll] Ship the release?",
        "Read [docs](https://docs.example)",
        "1. Yes — 2 votes (correct)",
        "2. No — 1 vote",
        "Total voters: 3",
        "Type: quiz",
        "Visibility: public",
        "Selection: single answer",
        "Status: open",
        "Explanation: **All** checks passed.",
      ].join("\n"),
      entities: [],
    });
  });
});

describe("joinTelegramTextParts", () => {
  it("rebases text and caption entities using Telegram UTF-16 offsets", () => {
    const result = joinTelegramTextParts(
      [
        asTelegramMessage({
          text: "😀 bold",
          entities: [{ type: "bold", offset: 3, length: 4 }],
        }),
        asTelegramMessage({
          caption: "read docs",
          caption_entities: [
            { type: "text_link", offset: 5, length: 4, url: "https://docs.example" },
          ],
        }),
      ],
      "\n",
    );

    expect(result.text).toBe("😀 bold\nread docs");
    expect(result.entities).toEqual([
      { type: "bold", offset: 3, length: 4 },
      { type: "text_link", offset: 13, length: 4, url: "https://docs.example" },
    ]);
    expect(renderTelegramTextEntities(result.text, result.entities)).toBe(
      "😀 **bold**\nread [docs](https://docs.example)",
    );
  });

  it("skips empty segments without shifting later entity offsets", () => {
    const result = joinTelegramTextParts(
      [
        asTelegramMessage({ text: "" }),
        asTelegramMessage({
          text: "bold",
          entities: [{ type: "bold", offset: 0, length: 4 }],
        }),
      ],
      "\n",
    );

    expect(result).toEqual({
      text: "bold",
      entities: [{ type: "bold", offset: 0, length: 4 }],
    });
  });
});

describe("renderTelegramTextEntities quoted blocks", () => {
  it.each(["blockquote", "expandable_blockquote"] as const)(
    "preserves multiline %s entities and nested formatting",
    (type) => {
      const text = "Before\n😀 quoted\nsecond link\nAfter";
      const quote = "😀 quoted\nsecond link";
      const quoteOffset = text.indexOf(quote);

      const entities: MessageEntity[] = [
        { type, offset: quoteOffset, length: quote.length },
        { type: "bold", offset: quoteOffset + "😀 ".length, length: "quoted".length },
      ];

      expect(renderTelegramTextEntities(text, entities)).toBe(
        "Before\n> 😀 **quoted**\n> second link\n\nAfter",
      );
    },
  );

  it("reopens enclosing formatting across a quote block", () => {
    const text = "bold before\nquoted\nbold after";
    const quoteOffset = text.indexOf("quoted");
    const entities: MessageEntity[] = [
      { type: "bold", offset: 0, length: text.length },
      { type: "blockquote", offset: quoteOffset, length: "quoted".length },
    ];

    expect(renderTelegramTextEntities(text, entities)).toBe(
      "**bold before**\n> **quoted**\n\n**bold after**",
    );
  });
});
