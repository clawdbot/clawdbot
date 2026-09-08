import { describe, expect, it } from "vitest";
import { stripFinalTags } from "./final-tags.js";

describe("stripFinalTags", () => {
  it.each([
    'Example:\n```xml\n<final data-model="demo">payload</final>\n```',
    "Example:\n~~~xml\n<final>payload</final>\n~~~",
    "Write `<final>payload</final>` as XML.",
    "Use ``<final data-note='`'>payload</final>`` literally.",
    "Example:\n\n    <final>payload</final>",
    "Example:\n```xml\n<final>payload</final>",
    "> ```xml\n> <final>payload</final>\n> ```",
  ])("preserves literal final tags in Markdown code: %s", (input) => {
    expect(stripFinalTags(input)).toBe(input);
  });

  it("strips outside markers without removing their answer or code examples", () => {
    const example = "```xml\n<final>payload</final>\n```";
    expect(stripFinalTags(`<final>Outside answer</final>\n${example}\n<final/>Done`)).toBe(
      `Outside answer\n${example}\nDone`,
    );
  });

  it("preserves many ordered code regions while removing interleaved outside markers", () => {
    const example = "`<final>literal</final>`";
    const input = `${example}<final>visible</final> `.repeat(2_000);
    expect(stripFinalTags(input)).toBe(`${example}visible `.repeat(2_000));
  });

  it.each([
    ["<final>Hello</final>", "Hello"],
    ["<final data-model='demo'>Hello</final>", "Hello"],
    ["Unclosed `<final>Hello</final>", "Unclosed `Hello"],
    ["<final-result>Hello</final-result>", "<final-result>Hello</final-result>"],
    ["Plain text", "Plain text"],
    ["", ""],
  ])("retains existing outside-tag behavior: %s", (input, expected) => {
    expect(stripFinalTags(input)).toBe(expected);
  });
});
