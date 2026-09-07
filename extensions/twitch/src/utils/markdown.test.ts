import { describe, expect, it } from "vitest";
import { stripMarkdownForTwitch } from "./markdown.js";

describe("stripMarkdownForTwitch", () => {
  it("keeps labeled link destinations", () => {
    expect(stripMarkdownForTwitch("Read **the [docs](https://example.com/docs)**")).toBe(
      "Read the docs (https://example.com/docs)",
    );
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
