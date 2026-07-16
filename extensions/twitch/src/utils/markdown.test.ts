import { describe, expect, it } from "vitest";
import { chunkTextForTwitch } from "./markdown.js";

describe("chunkTextForTwitch", () => {
  it("strips markdown and keeps surrogate pairs intact at hard boundaries", () => {
    const prefix = "a".repeat(499);

    expect(chunkTextForTwitch(`**${prefix}😀b**`, 500)).toEqual([prefix, "😀b"]);
  });

  it.each([
    ["foo_bar_baz", "foo_bar_baz"],
    ["https://cdn.example/my_file_name.png", "https://cdn.example/my_file_name.png"],
    ["привет_мир_тест", "привет_мир_тест"],
    ["東京_駅_前", "東京_駅_前"],
    ["e\u0301_mail_.txt", "e\u0301_mail_.txt"],
  ])("preserves intraword underscores in %s", (input, expected) => {
    expect(chunkTextForTwitch(input, 500)).toEqual([expected]);
  });

  it("strips standalone underscore emphasis across lines", () => {
    expect(chunkTextForTwitch("_line one\nline two_", 500)).toEqual(["line one line two"]);
  });

  it("still strips standalone underscore emphasis", () => {
    expect(chunkTextForTwitch("use foo_bar_baz with _italic_ and __bold__ text", 500)).toEqual([
      "use foo_bar_baz with italic and bold text",
    ]);
  });
});
