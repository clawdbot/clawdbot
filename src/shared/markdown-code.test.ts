import { describe, expect, it } from "vitest";
import { formatFencedCodeBlock, formatInlineCodeSpan } from "./markdown-code.js";

describe("formatInlineCodeSpan", () => {
  it("wraps plain text in single backticks without padding", () => {
    expect(formatInlineCodeSpan("echo hi")).toBe("`echo hi`");
  });

  it("grows the delimiter past embedded backtick runs", () => {
    expect(formatInlineCodeSpan("a `b` c")).toBe("``a `b` c``");
    expect(formatInlineCodeSpan("x ``y`` z")).toBe("```x ``y`` z```");
  });

  it("pads when content starts or ends with a backtick", () => {
    expect(formatInlineCodeSpan("`edge")).toBe("`` `edge ``");
    expect(formatInlineCodeSpan("edge`")).toBe("`` edge` ``");
  });

  it("pads multi-line content", () => {
    expect(formatInlineCodeSpan("a\nb")).toBe("` a\nb `");
  });
});

describe("formatFencedCodeBlock", () => {
  it("uses a three-backtick fence for plain text", () => {
    expect(formatFencedCodeBlock("hello")).toBe("```\nhello\n```");
  });

  it("appends the language to the opening fence", () => {
    expect(formatFencedCodeBlock("ls", "sh")).toBe("```sh\nls\n```");
  });

  it("grows the fence past embedded triple backticks", () => {
    expect(formatFencedCodeBlock("```js\ncode\n```")).toBe("````\n```js\ncode\n```\n````");
  });

  it("keeps a three-backtick fence for short inner runs", () => {
    expect(formatFencedCodeBlock("a ``b`` c")).toBe("```\na ``b`` c\n```");
  });
});
