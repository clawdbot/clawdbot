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

  it("does not strip normal angle brackets or HTML", () => {
    expect(stripModelSpecialTokens("a < b && c > d")).toBe("a < b && c > d");
    expect(stripModelSpecialTokens("<div>hello</div>")).toBe("<div>hello</div>");
  });

  it("passes through text without tokens unchanged", () => {
    const text = "Just a normal response.";
    expect(stripModelSpecialTokens(text)).toBe(text);
  });

  it.each([
    {
      name: "before closing punctuation",
      input: "Hello<|assistant|>.",
      expected: "Hello.",
    },
    {
      name: "after opening punctuation",
      input: "(<|assistant|>Hello",
      expected: "(Hello",
    },
    {
      name: "before a Markdown closing delimiter",
      input: "**bold<|assistant|>**",
      expected: "**bold**",
    },
  ])("does not insert a separator $name", ({ input, expected }) => {
    expect(stripModelSpecialTokens(input)).toBe(expected);
  });

  // Separator insertion stays Unicode-aware: adjacent non-Latin word content
  // still gets a separator so the two words are not concatenated.
  it("inserts a separator between adjacent non-Latin words", () => {
    expect(stripModelSpecialTokens("Привет<|assistant|>Мир")).toBe("Привет Мир");
  });

  // Supplementary-plane letters are UTF-16 surrogate pairs; the boundary
  // classifier must read the whole code point, not a lone surrogate half, or
  // adjacent astral letters get merged instead of separated.
  it("inserts a separator between adjacent supplementary-plane letters", () => {
    // U+10400 (Deseret) is a surrogate pair on either side of the token.
    expect(stripModelSpecialTokens("𐐀<|assistant|>𐐀")).toBe("𐐀 𐐀");
  });

  it("inserts a separator when a supplementary-plane letter meets an ASCII word", () => {
    expect(stripModelSpecialTokens("𐐀<|assistant|>word")).toBe("𐐀 word");
    expect(stripModelSpecialTokens("word<|assistant|>𐐀")).toBe("word 𐐀");
  });

  // A word ending in a decomposed combining mark (e + U+0301 = é) must still
  // count as word content at the left boundary so the mark is not split off.
  it("inserts a separator after a word ending in a combining mark", () => {
    // Decomposed café; the combining acute is \p{M}, word content on the left.
    expect(stripModelSpecialTokens("café<|assistant|>world")).toBe("café world");
  });

  // Contiguous removable tokens must be coalesced into one removal run; if each
  // token is judged against its immediate neighbor, the inner boundaries see
  // only the adjacent token delimiters and the surrounding words merge.
  it("inserts a separator across a contiguous removable-token run", () => {
    expect(stripModelSpecialTokens("Question<|assistant|><|end|>Answer")).toBe("Question Answer");
  });

  it("coalesces three contiguous removable tokens between words", () => {
    expect(stripModelSpecialTokens("a<|x|><|y|><|z|>b")).toBe("a b");
  });

  it("does not insert a separator when one side of a run is punctuation", () => {
    expect(stripModelSpecialTokens("Hello<|a|><|b|>.")).toBe("Hello.");
  });

  // A combining mark immediately after a removed token attaches to the base
  // before the token, not to the word after it, so no separator is inserted.
  // Inserting one would split a decomposed grapheme (cafe + U+0301 = café).
  it("does not split a combining sequence that follows a removed token", () => {
    // "cafe" + U+0301 (combining acute) rejoins across the removed token; the
    // output stays decomposed (cafe + U+0301 + word), not split by a space.
    expect(stripModelSpecialTokens("cafe<|assistant|>\u0301word")).toBe("cafe\u0301word");
  });
});
