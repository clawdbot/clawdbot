import { describe, expect, test } from "vitest";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsFromMessageForDisplay,
} from "./directive-tags.js";

describe("stripInlineDirectiveTagsForDisplay", () => {
  test("removes reply and audio directives", () => {
    const input = "hello [[reply_to_current]] world [[reply_to:abc-123]] [[audio_as_voice]]";
    const result = stripInlineDirectiveTagsForDisplay(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("hello  world  ");
  });

  test("supports whitespace variants", () => {
    const input = "[[ reply_to : 123 ]]ok[[ audio_as_voice ]]";
    const result = stripInlineDirectiveTagsForDisplay(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("ok");
  });

  test("does not mutate plain text", () => {
    const input = "  keep leading and trailing whitespace  ";
    const result = stripInlineDirectiveTagsForDisplay(input);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
  });
});

describe("stripInlineDirectiveTagsForDelivery", () => {
  test("removes directives and surrounding whitespace for outbound text", () => {
    const input = "hello [[reply_to_current]] world [[audio_as_voice]]";
    const result = stripInlineDirectiveTagsForDelivery(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("hello world");
  });

  test("preserves intentional multi-space formatting away from directives", () => {
    const input = "a  b [[reply_to:123]] c   d";
    const result = stripInlineDirectiveTagsForDelivery(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("a  b c   d");
  });

  test("does not trim plain text when no directive tags are present", () => {
    const input = "  keep leading and trailing whitespace  ";
    const result = stripInlineDirectiveTagsForDelivery(input);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
  });
});

describe("parseInlineDirectives", () => {
  test("preserves leading spaces after stripping a reply tag", () => {
    const input = "[[reply_to_current]]    keep this indent\n        and this one";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe("    keep this indent\n        and this one");
  });

  test("preserves fenced code block indentation after stripping a reply tag", () => {
    const input = [
      "[[reply_to_current]]",
      "```python",
      "    if True:",
      "        print('ok')",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(
      ["```python", "    if True:", "        print('ok')", "```"].join("\n"),
    );
  });

  test("preserves word boundaries when a reply tag is adjacent to text", () => {
    const input = "see[[reply_to_current]]now";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe("see now");
  });

  test("drops all leading blank lines introduced by a stripped reply tag", () => {
    const input = "[[reply_to_current]]\n\ntext";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe("text");
  });

  // --- code-fence aware normalizeDirectiveWhitespace ---

  test("preserves indented code block (4-space) inside a fenced block after stripping a directive", () => {
    const input = [
      "[[reply_to_current]]",
      "```js",
      "function foo() {",
      "    return 42;",
      "        const nested = true;",
      "}",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(
      [
        "```js",
        "function foo() {",
        "    return 42;",
        "        const nested = true;",
        "}",
        "```",
      ].join("\n"),
    );
  });

  test("preserves tab-indented lines inside a fenced code block", () => {
    const input = [
      "[[reply_to_current]]",
      "```go",
      "func main() {",
      '\tfmt.Println("hello")',
      "\t\tif true {",
      "\t\t}",
      "}",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(
      [
        "```go",
        "func main() {",
        '\tfmt.Println("hello")',
        "\t\tif true {",
        "\t\t}",
        "}",
        "```",
      ].join("\n"),
    );
  });

  test("preserves indent-code-block lines (4-space prefix) outside a fenced block", () => {
    const input = "[[reply_to_current]]\nHere is some code:\n\n    const x = 1;\n    const y = 2;";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe("Here is some code:\n\n    const x = 1;\n    const y = 2;");
  });

  test("collapses multiple spaces on normal prose lines but not inside code blocks", () => {
    const input = [
      "[[reply_to_current]]",
      "prose  with  extra  spaces",
      "```",
      "  preserved   spacing  inside",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(
      ["prose with extra spaces", "```", "  preserved   spacing  inside", "```"].join("\n"),
    );
  });

  test("handles tilde fenced blocks (~~~) the same as backtick blocks", () => {
    const input = [
      "[[reply_to_current]]",
      "~~~python",
      "    x  =  1",
      "        y  =  2",
      "~~~",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(["~~~python", "    x  =  1", "        y  =  2", "~~~"].join("\n"));
  });

  test("normalizes plain text without directives using code-fence awareness", () => {
    const input = "plain  text  with  extra  spaces\n\n```\n    code  preserved\n```";
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(false);
    expect(result.text).toBe("plain text with extra spaces\n\n```\n    code  preserved\n```");
  });

  test("audio_as_voice directive does not corrupt adjacent fenced code block indentation", () => {
    const input = ["[[audio_as_voice]]", "```bash", "  echo 'hello'", "    indented", "```"].join(
      "\n",
    );
    const result = parseInlineDirectives(input);
    expect(result.audioAsVoice).toBe(true);
    expect(result.text).toBe(["```bash", "  echo 'hello'", "    indented", "```"].join("\n"));
  });

  test("preserves literal sentinel-like text while restoring masked code blocks", () => {
    const sentinelLikeText = "\uE0000\uE000";
    const input = [
      "[[reply_to_current]]",
      `literal ${sentinelLikeText} text`,
      "```ts",
      "    const value = 1;",
      "```",
    ].join("\n");
    const result = parseInlineDirectives(input);
    expect(result.hasReplyTag).toBe(true);
    expect(result.text).toBe(
      [`literal ${sentinelLikeText} text`, "```ts", "    const value = 1;", "```"].join("\n"),
    );
  });
});

describe("stripInlineDirectiveTagsFromMessageForDisplay", () => {
  test("strips inline directives from text content blocks", () => {
    const input = {
      role: "assistant",
      content: [{ type: "text", text: "hello [[reply_to_current]] world [[audio_as_voice]]" }],
    };
    const result = stripInlineDirectiveTagsFromMessageForDisplay(input);
    if (!result) {
      throw new Error("expected stripped message");
    }
    expect(result.content).toEqual([{ type: "text", text: "hello  world " }]);
  });

  test("preserves empty-string text when directives are entire content", () => {
    const input = {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current]]" }],
    };
    const result = stripInlineDirectiveTagsFromMessageForDisplay(input);
    if (!result) {
      throw new Error("expected stripped message");
    }
    expect(result.content).toEqual([{ type: "text", text: "" }]);
  });

  test("returns original message when content is not an array", () => {
    const input = {
      role: "assistant",
      content: "plain text",
    };
    const result = stripInlineDirectiveTagsFromMessageForDisplay(input);
    expect(result).toEqual(input);
  });
});
