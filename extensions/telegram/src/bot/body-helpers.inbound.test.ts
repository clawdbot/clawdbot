import type { Message, MessageEntity } from "grammy/types";
import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
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

  it("preserves native poll links with Markdown-sensitive labels and destinations", () => {
    const label = "docs]more";
    const url = "https://example.com/report)final";
    const result = getTelegramTextParts(
      asTelegramMessage({
        poll: {
          id: "poll-links",
          question: "Review the report?",
          options: [{ text: "Yes", voter_count: 1 }],
          total_voter_count: 1,
          is_closed: false,
          is_anonymous: true,
          type: "regular",
          allows_multiple_answers: false,
          description: `Read ${label}`,
          description_entities: [{ type: "text_link", offset: 5, length: label.length, url }],
        },
      }),
    );

    const parsed = markdownToIR(result.text);
    expect(parsed.text).toContain(`Read ${label}`);
    expect(parsed.links.map((link) => link.href)).toEqual([url]);
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

  it("preserves links from joined messages and captions through the real Markdown parser", () => {
    const messageLabel = "😀 report]";
    const captionLabel = "[caption";
    const messageUrl = "https://example.com/message)final";
    const captionUrl = "https://example.com/caption(a)b)";
    const result = joinTelegramTextParts(
      [
        asTelegramMessage({
          text: `Read ${messageLabel}`,
          entities: [
            { type: "text_link", offset: 5, length: messageLabel.length, url: messageUrl },
          ],
        }),
        asTelegramMessage({
          caption: `Open ${captionLabel}`,
          caption_entities: [
            { type: "text_link", offset: 5, length: captionLabel.length, url: captionUrl },
          ],
        }),
      ],
      "\n",
    );

    const parsed = markdownToIR(renderTelegramTextEntities(result.text, result.entities));

    expect(parsed.text).toBe(result.text);
    expect(parsed.links.map((link) => link.href)).toEqual([messageUrl, captionUrl]);
  });

  it.each([
    "npm test",
    "a`b",
    "`npm",
    "npm`",
    "`npm`",
    "``npm```",
    "`",
    " npm",
    "npm ",
    " npm ",
    " ",
    "   ",
    " \t ",
    " \u00a0 ",
  ])("preserves literal inline code %j from joined text and captions", (code) => {
    const prefix = "😀 Code: ";
    const text = `${prefix}${code} end`;
    const entities: MessageEntity[] = [
      { type: "code", offset: prefix.length, length: code.length },
    ];
    const result = joinTelegramTextParts(
      [
        asTelegramMessage({ text, entities }),
        asTelegramMessage({ caption: text, caption_entities: entities }),
      ],
      "\n",
    );

    const parsed = markdownToIR(renderTelegramTextEntities(result.text, result.entities));

    expect(parsed.text).toBe(result.text);
    expect(
      parsed.styles
        .filter((span) => span.style === "code")
        .map((span) => parsed.text.slice(span.start, span.end)),
    ).toEqual([code, code]);
  });
});

describe("renderTelegramTextEntities inline code normalization", () => {
  it.each([
    [" \n ", "   "],
    [" \r\n ", "   "],
    ["\nvalue\n", " value "],
    ["\rvalue\r", " value "],
    ["\r\nvalue\r\n", " value "],
  ])("preserves normalized spaces in %j", (code, normalized) => {
    const prefix = "Code: ";
    const text = `${prefix}${code} end`;
    const parsed = markdownToIR(
      renderTelegramTextEntities(text, [
        { type: "code", offset: prefix.length, length: code.length },
      ]),
    );

    expect(parsed.text).toBe(`${prefix}${normalized} end`);
    expect(parsed.styles).toEqual([
      { start: prefix.length, end: prefix.length + normalized.length, style: "code" },
    ]);
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
