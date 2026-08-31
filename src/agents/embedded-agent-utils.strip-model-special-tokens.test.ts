/**
 * Regression coverage for model special-token stripping.
 * Ensures provider wrapper tokens do not leak into visible assistant text.
 */
import { describe, expect, it } from "vitest";
import { stripModelSpecialTokens } from "../shared/text/model-special-tokens.js";

/**
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
describe("stripModelSpecialTokens", () => {
  it("strips tokens and inserts space between adjacent words", () => {
    expect(stripModelSpecialTokens("<|user|>Question<|assistant|>Answer")).toBe("Question Answer");
  });

  it("strips full-width pipe variants (DeepSeek U+FF5C)", () => {
    expect(stripModelSpecialTokens("<｜begin▁of▁sentence｜>Hello there")).toBe("Hello there");
  });

  it.each([
    ["closing punctuation", "Hello<|assistant|>.", "Hello."],
    ["opening punctuation", "(<|assistant|>Hello", "(Hello"],
    ["strong emphasis", "**bold<|assistant|>**", "**bold**"],
    ["underscore emphasis", "__bold<|assistant|>__", "__bold__"],
    ["Cyrillic words", "Привет<|assistant|>мир", "Привет мир"],
    ["CJK words", "你好<|assistant|>世界", "你好 世界"],
    ["astral letters", "𐐀<|assistant|>𐐁", "𐐀 𐐁"],
    ["Unicode digits", "١<|assistant|>٢", "١ ٢"],
    ["left combining mark", "cafe\u0301<|assistant|>word", "cafe\u0301 word"],
    ["right combining mark", "cafe<|assistant|>\u0301word", "cafe\u0301word"],
    ["adjacent tokens", "first<|user|><|assistant|>second", "first second"],
    ["mixed token runs", "first<|user|><｜assistant｜>second", "first second"],
    ["token run before punctuation", "Hello<|user|><|assistant|>!", "Hello!"],
    ["existing whitespace", "first <|assistant|>\nsecond", "first \nsecond"],
  ])("preserves %s when removing tokens", (_name, input, expected) => {
    expect(stripModelSpecialTokens(input)).toBe(expected);
  });

  it("does not strip normal angle brackets or HTML", () => {
    expect(stripModelSpecialTokens("a < b && c > d")).toBe("a < b && c > d");
    expect(stripModelSpecialTokens("<div>hello</div>")).toBe("<div>hello</div>");
  });

  it("passes through text without tokens unchanged", () => {
    const text = "Just a normal response.";
    expect(stripModelSpecialTokens(text)).toBe(text);
  });
});
