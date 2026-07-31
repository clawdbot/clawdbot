// Feishu tests cover post plugin behavior.
import { describe, expect, it } from "vitest";
import { parsePostContent } from "./post.js";

describe("parsePostContent", () => {
  it("renders title and styled text as markdown", () => {
    const content = JSON.stringify({
      title: "Daily *Plan*",
      content: [
        [
          { tag: "text", text: "Bold", style: { bold: true } },
          { tag: "text", text: " " },
          { tag: "text", text: "Italic", style: { italic: true } },
          { tag: "text", text: " " },
          { tag: "text", text: "Underline", style: { underline: true } },
          { tag: "text", text: " " },
          { tag: "text", text: "Strike", style: { strikethrough: true } },
          { tag: "text", text: " " },
          { tag: "text", text: "Code", style: { code: true, bold: true } },
        ],
      ],
    });

    const result = parsePostContent(content);

    expect(result.textContent).toBe(
      "Daily \\*Plan\\*\n\n**Bold** *Italic* <u>Underline</u> ~~Strike~~ `Code`",
    );
    expect(result.imageKeys).toStrictEqual([]);
    expect(result.mentionedOpenIds).toStrictEqual([]);
  });

  it("renders links and mentions", () => {
    const content = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "a", text: "Docs [v2]", href: "https://example.com/guide(a)" },
          { tag: "text", text: " " },
          { tag: "at", user_name: "alice_bob" },
          { tag: "text", text: " " },
          { tag: "at", open_id: "ou_123" },
          { tag: "text", text: " " },
          { tag: "a", href: "https://example.com/no-text" },
        ],
      ],
    });

    const result = parsePostContent(content);

    expect(result.textContent).toBe(
      "[Docs \\[v2\\]](https://example.com/guide(a)) @alice\\_bob @ou\\_123 [https://example.com/no\\-text](https://example.com/no-text)",
    );
    expect(result.mentionedOpenIds).toEqual(["ou_123"]);
  });

  it("inserts image placeholders and collects image keys", () => {
    const content = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "text", text: "Before " },
          { tag: "img", image_key: "img_1" },
          { tag: "text", text: " after" },
        ],
        [{ tag: "img", image_key: "img_2" }],
      ],
    });

    const result = parsePostContent(content);

    expect(result.textContent).toBe("Before ![image] after\n![image]");
    expect(result.imageKeys).toEqual(["img_1", "img_2"]);
    expect(result.mentionedOpenIds).toStrictEqual([]);
    expect(
      parsePostContent(content, { renderMediaPlaceholders: false, emptyTextFallback: "" })
        .textContent,
    ).toBe("Before  after");
  });

  it("supports locale wrappers", () => {
    const wrappedByPost = JSON.stringify({
      post: {
        zh_cn: {
          title: "标题",
          content: [[{ tag: "text", text: "内容A" }]],
        },
      },
    });
    const wrappedByLocale = JSON.stringify({
      zh_cn: {
        title: "标题",
        content: [[{ tag: "text", text: "内容B" }]],
      },
    });

    expect(parsePostContent(wrappedByPost)).toEqual({
      textContent: "标题\n\n内容A",
      imageKeys: [],
      mediaKeys: [],
      mentionedOpenIds: [],
    });
    expect(parsePostContent(wrappedByLocale)).toEqual({
      textContent: "标题\n\n内容B",
      imageKeys: [],
      mediaKeys: [],
      mentionedOpenIds: [],
    });
  });

  it("prefers content_v2 native markdown when present (AC-M1-H1)", () => {
    const content = JSON.stringify({
      title: "周报",
      content: [
        [
          { tag: "text", text: "降级文本" },
          { tag: "img", image_key: "img_abc123" },
        ],
      ],
      content_v2: [
        [
          {
            tag: "md",
            text: "本周进展：\n\n![架构图](img_abc123)\n\n详见 [文档](https://example.com)",
          },
        ],
      ],
    });

    const result = parsePostContent(content);

    expect(result.textContent).toContain("![架构图](img_abc123)");
    expect(result.textContent).toContain("[文档](https://example.com)");
    expect(result.textContent).not.toContain("降级文本");
    expect(result.imageKeys).toStrictEqual(["img_abc123"]);
  });

  it("keeps code-block image syntax literal and unextracted (AC-M1-H3)", () => {
    const content = JSON.stringify({
      title: "",
      content: [[{ tag: "text", text: "x" }]],
      content_v2: [
        [
          {
            tag: "md",
            text: "真图：\n\n![real](img_real)\n\n```md\n![fake](img_in_code)\n```\n\n行内 `![inline](img_inline)` 也保留",
          },
        ],
      ],
    });

    const result = parsePostContent(content);

    expect(result.imageKeys).toStrictEqual(["img_real"]);
    expect(result.textContent).toContain("![fake](img_in_code)");
    expect(result.textContent).toContain("`![inline](img_inline)`");
  });

  it("falls back to content structurally when content_v2 missing/empty/invalid (AC-M1-E1, AC-M1-R2)", () => {
    const base = {
      title: "标题",
      content: [
        [
          { tag: "text", text: "正文" },
          { tag: "img", image_key: "img_x" },
        ],
      ],
    };
    const expected = parsePostContent(JSON.stringify(base));

    for (const bad of [undefined, [], "not-an-array", {}, 42]) {
      const withV2 = JSON.stringify({ ...base, content_v2: bad });
      const result = parsePostContent(withV2);
      expect(result.textContent).toBe(expected.textContent);
      expect(result.imageKeys).toStrictEqual(expected.imageKeys);
    }
  });

  it("falls back to content when content_v2 is non-empty but renders no usable text/media", () => {
    const content = JSON.stringify({
      title: "",
      content: [[{ tag: "text", text: "real body" }]],
      // non-empty array, but the only element renders to nothing usable
      content_v2: [[{ tag: "md", text: "   " }]],
    });

    const result = parsePostContent(content);

    expect(result.textContent).toBe("real body");
  });

  it("keeps dedupe-relevant media keys stable across content / content_v2 (AC-M1-E2)", () => {
    const contentOnly = JSON.stringify({
      title: "",
      content: [[{ tag: "img", image_key: "img_same" }]],
    });
    const withV2 = JSON.stringify({
      title: "",
      content: [[{ tag: "img", image_key: "img_same" }]],
      content_v2: [[{ tag: "md", text: "![a](img_same)" }]],
    });

    expect(parsePostContent(withV2).imageKeys).toStrictEqual(
      parsePostContent(contentOnly).imageKeys,
    );
  });

  it("extracts content_v2 native markdown mentions (AC-M1-E3)", () => {
    const content = JSON.stringify({
      title: "",
      content: [[{ tag: "text", text: "x" }]],
      content_v2: [
        [
          {
            tag: "md",
            text: '<at user_id="ou_bot">OpenClaw</at> /help',
          },
        ],
      ],
    });

    const result = parsePostContent(content);

    expect(result.mentionedOpenIds).toStrictEqual(["ou_bot"]);
    expect(result.textContent).toContain("/help");
  });
});
