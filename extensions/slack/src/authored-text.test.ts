import { describe, expect, it } from "vitest";
import { resolveSlackAuthoredTextPlacement } from "./authored-text.js";

describe("resolveSlackAuthoredTextPlacement", () => {
  it.each([
    {
      name: "matches consecutive fragments after unrelated text",
      text: "First second",
      fragments: ["Before", "First", "second", "After"],
      expected: "blocks",
    },
    {
      name: "normalizes whitespace and skips empty fragments",
      text: "  First\n second\tthird \u00a0🚀  ",
      fragments: ["\t", " First ", "", " second\tthird ", " \u00a0🚀", "After"],
      expected: "blocks",
    },
    {
      name: "does not match a suffix inside the first fragment",
      text: "First second",
      fragments: ["Before First", "second"],
      expected: "outside-blocks",
    },
    {
      name: "does not match a prefix inside the final fragment",
      text: "First second",
      fragments: ["First", "second After"],
      expected: "outside-blocks",
    },
    {
      name: "requires a separator between fragments",
      text: "Firstsecond",
      fragments: ["First", "second"],
      expected: "outside-blocks",
    },
    {
      name: "does not skip intervening visible text",
      text: "First second",
      fragments: ["First", "Between", "second"],
      expected: "outside-blocks",
    },
    {
      name: "restarts after a partially matching sequence",
      text: "First second",
      fragments: ["First", "First", "second"],
      expected: "blocks",
    },
  ])("$name", ({ text, fragments, expected }) => {
    expect(resolveSlackAuthoredTextPlacement({ text, renderedTextFragments: fragments })).toBe(
      expected,
    );
    expect(
      resolveSlackAuthoredTextPlacement({
        text,
        interactive: {
          blocks: fragments.flatMap((fragment) => [
            { type: "text" as const, text: fragment },
            { type: "buttons" as const, buttons: [{ label: "Continue", value: "continue" }] },
          ]),
        },
      }),
    ).toBe(expected);
  });
});
