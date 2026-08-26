// Directive tag tests cover parsing and filtering inline directive tags.
import { describe, expect, it, test } from "vitest";
import {
  parseInlineDirectives,
  sanitizeReplyDirectiveId,
  stripInlineDirectiveTagsForDelivery,
  stripInlineDirectiveTagsForDisplay,
} from "./directive-tags.js";

function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate must be followed by a low surrogate. charCodeAt past end
      // returns NaN; NaN comparisons are always false, so guard bounds explicitly.
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

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

  test("preserves an ambiguous unterminated explicit reply prefix", () => {
    const input = "[[reply_to:message-7 Visible reply";
    expect(stripInlineDirectiveTagsForDelivery(input)).toEqual({ text: input, changed: false });
  });

  test("preserves a malformed reply prefix after visible text", () => {
    const input = "Visible reply\n[[reply_to_current] literally";
    expect(stripInlineDirectiveTagsForDelivery(input)).toEqual({ text: input, changed: false });
  });
});

describe("parseInlineDirectives markdown code", () => {
  it("leaves directive examples inside inline and fenced code untouched", () => {
    const input = [
      "Use `[[reply_to_current]]` literally.",
      "```text",
      "[[audio_as_voice]]",
      "[[reply_to:example-id]]",
      "```",
    ].join("\n");

    expect(parseInlineDirectives(input)).toEqual({
      text: input,
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    });
    expect(stripInlineDirectiveTagsForDisplay(input)).toEqual({ text: input, changed: false });
    expect(stripInlineDirectiveTagsForDelivery(input)).toEqual({ text: input, changed: false });
  });

  it.each([
    ["four-space", "    [[reply_to_current]]\n    [[audio_as_voice]]"],
    ["tab", "\t[[reply_to_current]]\n\t[[audio_as_voice]]"],
  ])("leaves directives inside standalone %s-indented code untouched", (_name, input) => {
    expect(parseInlineDirectives(input)).toEqual({
      text: input,
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    });
    expect(stripInlineDirectiveTagsForDisplay(input)).toEqual({ text: input, changed: false });
    expect(stripInlineDirectiveTagsForDelivery(input)).toEqual({ text: input, changed: false });
  });
});

describe("parseInlineDirectives", () => {
  test("sanitizes explicit reply directive ids", () => {
    const result = parseInlineDirectives("hello [[reply_to: abc\u0000\r\u0085def ]]");

    expect(result.hasReplyTag).toBe(true);
    expect(result.replyToExplicitId).toBe("abcdef");
    expect(result.replyToId).toBe("abcdef");
    expect(result.text).toBe("hello");
  });

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

  test.each([
    [
      "a false closing marker",
      ["```python", "value = 'a  b'", "``` not a close", "x = 'c  d'", "```"],
    ],
    ["an unclosed fence", ["```python", "value = 'a  b'", "x = 'c  d'"]],
    ["an indented closing fence", ["```python", "value = 'a  b'", "   ```"]],
  ])("preserves canonical code fences with %s after removing directives", (_name, lines) => {
    const code = lines.join("\n");
    const result = parseInlineDirectives(`[[reply_to_current]]\n[[audio_as_voice]]\n${code}`);

    expect(result.hasReplyTag).toBe(true);
    expect(result.audioAsVoice).toBe(true);
    expect(result.text).toBe(code);
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

describe("sanitizeReplyDirectiveId", () => {
  test("strips bracket and control characters from explicit reply ids", () => {
    expect(sanitizeReplyDirectiveId(" [abc]\u0000\r\u0085def ")).toBe("abcdef");
  });

  test("truncates long ids without splitting surrogate pairs", () => {
    const prefix = "a".repeat(255);
    const result = sanitizeReplyDirectiveId(`${prefix}😊tail`);

    expect(result).toBe(`${prefix}😊`);
    expect(hasUnpairedSurrogate(result ?? "")).toBe(false);
  });

  test("hasUnpairedSurrogate catches a lone trailing high surrogate", () => {
    // Proves the helper itself reports the failure mode the production fix prevents.
    // Pre-fix helper: charCodeAt(out-of-bounds) returned NaN, NaN < 0xdc00 was false,
    // so a trailing high surrogate was missed and the assertion above was vacuous.
    expect(hasUnpairedSurrogate("a\ud83d")).toBe(true);
    expect(hasUnpairedSurrogate(`${"a".repeat(255)}\ud83d`)).toBe(true);
  });

  test("hasUnpairedSurrogate accepts a properly paired emoji", () => {
    expect(hasUnpairedSurrogate("a😊b")).toBe(false);
  });
});
