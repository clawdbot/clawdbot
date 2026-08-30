// Syntax highlight tests cover the lazy highlight.js integration and theme
// callback rendering used by interactive output.
import { describe, expect, it } from "vitest";
import { highlight, supportsLanguage } from "./syntax-highlight.js";

describe("syntax highlighting", () => {
  it("loads highlight.js through the package export and renders themed output", () => {
    expect(supportsLanguage("javascript")).toBe(true);

    const highlighted = highlight("const answer = 42;", {
      language: "javascript",
      theme: {
        keyword: (text) => `[${text}]`,
      },
    });

    expect(highlighted).toContain("[const]");
  });
});
