import { describe, expect, it } from "vitest";
import { buildMentionEntities, formatMentionText, parseMentions } from "./mentions.js";

function requireFirstEntity(result: ReturnType<typeof parseMentions>) {
  const entity = result.entities[0];
  if (!entity) {
    throw new Error("expected parseMentions to return at least one entity");
  }
  return entity;
}

function requireOnlyEntity(result: ReturnType<typeof parseMentions>) {
  expect(result.entities).toHaveLength(1);
  return requireFirstEntity(result);
}

const mentionFreeTextCases = [
  {
    name: "parseMentions",
    assert: () => {
      const result = parseMentions("Hello world!");

      expect(result.text).toBe("Hello world!");
      expect(result.entities).toHaveLength(0);
    },
  },
  {
    name: "formatMentionText",
    assert: () => {
      const mentions = [{ id: "28:xxx", name: "John" }];

      expect(formatMentionText("Hello world", mentions)).toBe("Hello world");
    },
  },
];

describe("mention-free text contract", () => {
  it.each(mentionFreeTextCases)("$name handles text without mentions", ({ assert }) => {
    assert();
  });
});

describe("parseMentions", () => {
  it("parses single mention", () => {
    const result = parseMentions("Hello @[John Doe](28:a1b2c3-d4e5f6)!");

    expect(result.text).toBe("Hello <at>John Doe</at>!");
    expect(requireOnlyEntity(result)).toEqual({
      type: "mention",
      text: "<at>John Doe</at>",
      mentioned: {
        id: "28:a1b2c3-d4e5f6",
        name: "John Doe",
      },
    });
  });

  it("parses multiple mentions", () => {
    const result = parseMentions("Hey @[Alice](28:aaa) and @[Bob](28:bbb), can you review this?");

    expect(result.text).toBe("Hey <at>Alice</at> and <at>Bob</at>, can you review this?");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({
      type: "mention",
      text: "<at>Alice</at>",
      mentioned: {
        id: "28:aaa",
        name: "Alice",
      },
    });
    expect(result.entities[1]).toEqual({
      type: "mention",
      text: "<at>Bob</at>",
      mentioned: {
        id: "28:bbb",
        name: "Bob",
      },
    });
  });

  it("handles empty text", () => {
    const result = parseMentions("");

    expect(result.text).toBe("");
    expect(result.entities).toHaveLength(0);
  });

  it("handles mention with spaces in name", () => {
    const result = parseMentions("@[John Peter Smith](28:a1b2c3)");

    expect(result.text).toBe("<at>John Peter Smith</at>");
    expect(requireFirstEntity(result).mentioned.name).toBe("John Peter Smith");
  });

  it("trims whitespace from id and name", () => {
    const result = parseMentions("@[ John Doe ]( 28:a1b2c3 )");

    expect(requireOnlyEntity(result)).toEqual({
      type: "mention",
      text: "<at>John Doe</at>",
      mentioned: {
        id: "28:a1b2c3",
        name: "John Doe",
      },
    });
  });

  it("handles Japanese characters in mention at start of message", () => {
    const input = "@[タナカ タロウ](a1b2c3d4-e5f6-7890-abcd-ef1234567890) スキル化完了しました！";
    const result = parseMentions(input);

    expect(result.text).toBe("<at>タナカ タロウ</at> スキル化完了しました！");
    expect(requireOnlyEntity(result)).toEqual({
      type: "mention",
      text: "<at>タナカ タロウ</at>",
      mentioned: {
        id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        name: "タナカ タロウ",
      },
    });

    // Verify entity text exactly matches what's in the formatted text
    const entityText = requireFirstEntity(result).text;
    expect(result.text).toContain(entityText);
    expect(result.text.indexOf(entityText)).toBe(0);
  });

  it("skips mention-like patterns with non-Teams IDs (e.g. in code blocks)", () => {
    // This reproduces the actual failing payload: the message contains a real mention
    // plus `@[表示名](ユーザーID)` as documentation text inside backticks.
    const input =
      "@[タナカ タロウ](a1b2c3d4-e5f6-7890-abcd-ef1234567890) スキル化完了しました！📋\n\n" +
      "**作成したスキル:** `teams-mention`\n" +
      "- 機能: Teamsでのメンション形式 `@[表示名](ユーザーID)`\n\n" +
      "**追加対応:**\n" +
      "- ユーザーのID `a1b2c3d4-e5f6-7890-abcd-ef1234567890` を登録済み";
    const result = parseMentions(input);

    // Only the real mention should be parsed; the documentation example should be left as-is
    const firstEntity = requireOnlyEntity(result);
    expect(firstEntity.mentioned.id).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(firstEntity.mentioned.name).toBe("タナカ タロウ");

    // The documentation pattern must remain untouched in the text
    expect(result.text).toContain("`@[表示名](ユーザーID)`");
  });

  it("accepts Bot Framework IDs (28:xxx)", () => {
    const result = parseMentions("@[Bot](28:abc-123)");
    expect(requireOnlyEntity(result).mentioned.id).toBe("28:abc-123");
  });

  it("accepts Bot Framework IDs with non-hex payloads (29:xxx)", () => {
    const result = parseMentions("@[Bot](29:08q2j2o3jc09au90eucae)");
    expect(requireOnlyEntity(result).mentioned.id).toBe("29:08q2j2o3jc09au90eucae");
  });

  it("accepts org-scoped IDs with extra segments (8:orgid:...)", () => {
    const result = parseMentions("@[User](8:orgid:2d8c2d2c-1111-2222-3333-444444444444)");
    expect(requireOnlyEntity(result).mentioned.id).toBe(
      "8:orgid:2d8c2d2c-1111-2222-3333-444444444444",
    );
  });

  it("accepts AAD object IDs (UUIDs)", () => {
    const result = parseMentions("@[User](a1b2c3d4-e5f6-7890-abcd-ef1234567890)");
    expect(requireOnlyEntity(result).mentioned.id).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("rejects non-ID strings as mention targets", () => {
    const result = parseMentions("See @[docs](https://example.com) for details");
    expect(result.entities).toHaveLength(0);
    // Original text preserved
    expect(result.text).toBe("See @[docs](https://example.com) for details");
  });
});

describe("buildMentionEntities", () => {
  it("builds entities from mention info", () => {
    const mentions = [
      { id: "28:aaa", name: "Alice" },
      { id: "28:bbb", name: "Bob" },
    ];

    const entities = buildMentionEntities(mentions);

    expect(entities).toHaveLength(2);
    expect(entities[0]).toEqual({
      type: "mention",
      text: "<at>Alice</at>",
      mentioned: {
        id: "28:aaa",
        name: "Alice",
      },
    });
    expect(entities[1]).toEqual({
      type: "mention",
      text: "<at>Bob</at>",
      mentioned: {
        id: "28:bbb",
        name: "Bob",
      },
    });
  });

  it("handles empty list", () => {
    const entities = buildMentionEntities([]);
    expect(entities).toHaveLength(0);
  });
});

describe("formatMentionText", () => {
  it("formats text with single mention", () => {
    const text = "Hello @John!";
    const mentions = [{ id: "28:xxx", name: "John" }];

    const result = formatMentionText(text, mentions);

    expect(result).toBe("Hello <at>John</at>!");
  });

  it("formats text with multiple mentions", () => {
    const text = "Hey @Alice and @Bob";
    const mentions = [
      { id: "28:aaa", name: "Alice" },
      { id: "28:bbb", name: "Bob" },
    ];

    const result = formatMentionText(text, mentions);

    expect(result).toBe("Hey <at>Alice</at> and <at>Bob</at>");
  });

  it("handles case-insensitive matching", () => {
    const text = "Hey @alice and @ALICE";
    const mentions = [{ id: "28:aaa", name: "Alice" }];

    const result = formatMentionText(text, mentions);

    expect(result).toBe("Hey <at>Alice</at> and <at>Alice</at>");
  });

  it("escapes regex metacharacters in names", () => {
    const text = "Hey @John(Test) and @Alice.Smith";
    const mentions = [
      { id: "28:xxx", name: "John(Test)" },
      { id: "28:yyy", name: "Alice.Smith" },
    ];

    const result = formatMentionText(text, mentions);

    expect(result).toBe("Hey <at>John(Test)</at> and <at>Alice.Smith</at>");
  });
});
