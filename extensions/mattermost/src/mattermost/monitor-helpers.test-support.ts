// Mattermost test support covers monitor helpers plugin behavior.
import { describe, expect, it } from "vitest";
import { normalizeMention, shouldDropEmptyMattermostBody } from "./monitor-helpers.js";

describe("normalizeMention", () => {
  it("returns trimmed text when no mention provided", () => {
    expect(normalizeMention("  hello world  ", undefined)).toBe("hello world");
  });

  it("strips bot mention from text", () => {
    expect(normalizeMention("@echobot hello", "echobot")).toBe("hello");
  });

  it("strips mention case-insensitively", () => {
    expect(normalizeMention("@EchoBot hello", "echobot")).toBe("hello");
  });

  it("preserves newlines in multi-line messages", () => {
    const input = "@echobot\nline1\nline2\nline3";
    const result = normalizeMention(input, "echobot");
    expect(result).toBe("line1\nline2\nline3");
  });

  it("preserves Markdown headings", () => {
    const input = "@echobot\n# Heading\n\nSome text";
    const result = normalizeMention(input, "echobot");
    expect(result).toContain("# Heading");
    expect(result).toContain("\n");
  });

  it("preserves Markdown blockquotes", () => {
    const input = "@echobot\n> quoted line\n> second line";
    const result = normalizeMention(input, "echobot");
    expect(result).toContain("> quoted line");
    expect(result).toContain("> second line");
  });

  it("preserves Markdown lists", () => {
    const input = "@echobot\n- item A\n- item B\n  - sub B1";
    const result = normalizeMention(input, "echobot");
    expect(result).toContain("- item A");
    expect(result).toContain("- item B");
  });

  it("preserves task lists", () => {
    const input = "@echobot\n- [ ] todo\n- [x] done";
    const result = normalizeMention(input, "echobot");
    expect(result).toContain("- [ ] todo");
    expect(result).toContain("- [x] done");
  });

  it("handles mention in middle of text", () => {
    const input = "hey @echobot check this\nout";
    const result = normalizeMention(input, "echobot");
    expect(result).toBe("hey check this\nout");
  });

  it("preserves leading indentation for nested lists", () => {
    const input = "@echobot\n- item\n  - nested\n    - deep";
    const result = normalizeMention(input, "echobot");
    expect(result).toContain("  - nested");
    expect(result).toContain("    - deep");
  });

  it("preserves first-line indentation for nested list items", () => {
    const input = "@echobot\n  - nested\n    - deep";
    const result = normalizeMention(input, "echobot");
    expect(result).toBe("  - nested\n    - deep");
  });

  it("preserves indented code blocks", () => {
    const input = "@echobot\ntext\n    code line 1\n    code line 2";
    const result = normalizeMention(input, "echobot");
    expect(result).toContain("    code line 1");
    expect(result).toContain("    code line 2");
  });

  it("preserves first-line indentation for indented code blocks", () => {
    const input = "@echobot\n    code line 1\n    code line 2";
    const result = normalizeMention(input, "echobot");
    expect(result).toBe("    code line 1\n    code line 2");
  });
});

describe("shouldDropEmptyMattermostBody", () => {
  it("drops a non-mention message that normalizes to an empty body", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "",
        rawText: "   ",
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });

  it("keeps a message that still has body text", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "hello",
        rawText: "hello",
        botUsername: "openclaw",
      }),
    ).toBe(false);
  });

  it("keeps a bare mention in a group", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "",
        rawText: "@openclaw",
        botUsername: "openclaw",
      }),
    ).toBe(false);
  });

  it("keeps a bare mention in a direct message", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "",
        rawText: "@OpenClaw",
        botUsername: "openclaw",
      }),
    ).toBe(false);
  });

  it("drops an empty body when the bot username is unknown", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "",
        rawText: "@someoneelse",
        botUsername: undefined,
      }),
    ).toBe(true);
  });

  it("drops a blank post even when a generic mention pattern matched it", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "",
        rawText: "",
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });

  it("drops a bot mention with only a Unicode control residual", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "\u0085",
        rawText: "@openclaw\u0085",
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });

  it("drops a bot mention with only a combining-mark residual", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "\ufe0f",
        rawText: "@openclaw\ufe0f",
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });

  it.each([
    "@openclaw @openclaw",
    "@openclaw\n@openclaw",
    "@openclaw\n",
    "\n@openclaw",
    "@openclaw\r\n",
    "@openclaw\u2028",
    "@openclaw\u2029",
    "\v@openclaw\f",
    "@openclaw\u00a0",
    "\u2003@openclaw",
  ])("drops an invalid empty-body candidate: %j", (rawText) => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "",
        rawText,
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });
});
