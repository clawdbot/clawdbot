import { describe, expect, it } from "vitest";
import { stripMarkdownForTwitch } from "./markdown.js";

describe("stripMarkdownForTwitch", () => {
  it.each([
    [
      "keeps labeled link destinations",
      "Read **the [docs](https://example.com/docs)**",
      "Read the docs (https://example.com/docs)",
    ],
  ])("%s", (_name, input, expected) => {
    expect(stripMarkdownForTwitch(input)).toBe(expected);
  });
});

describe("Twitch plain text", () => {
  it.each([
    ["foo_bar_baz", "foo_bar_baz"],
    ["https://cdn.example/my_file_name.png", "https://cdn.example/my_file_name.png"],
    ["привет_мир_тест", "привет_мир_тест"],
    ["東京_駅_前", "東京_駅_前"],
    ["e\u0301_mail_.txt", "e\u0301_mail_.txt"],
  ])("preserves intraword underscores in %s", (input, expected) => {
    expect(stripMarkdownForTwitch(input)).toBe(expected);
  });

  it("strips standalone underscore emphasis across lines", () => {
    expect(stripMarkdownForTwitch("_line one\nline two_")).toBe("line one line two");
  });

  it("still strips standalone underscore emphasis", () => {
    expect(stripMarkdownForTwitch("use foo_bar_baz with _italic_ and __bold__ text")).toBe(
      "use foo_bar_baz with italic and bold text",
    );
  });
});
