// Code region tests cover Markdown code span and fence detection.
import { describe, expect, it } from "vitest";
import { findCodeRegions, isInsideCode } from "./code-regions.js";

describe("shared/text/code-regions", () => {
  function expectCodeRegionSlices(text: string, expectedSlices: readonly string[]) {
    const regions = findCodeRegions(text);
    expect(regions).toHaveLength(expectedSlices.length);
    expect(regions.map((region) => text.slice(region.start, region.end))).toEqual(expectedSlices);
  }

  function expectInsideCodeCase(params: {
    positionSelector: (text: string, regionEnd: number) => number;
    expected: boolean;
  }) {
    const text = "plain `code` done";
    const regions = findCodeRegions(text);
    const regionEnd = regions[0]?.end ?? -1;
    expect(isInsideCode(params.positionSelector(text, regionEnd), regions)).toBe(params.expected);
  }

  it.each([
    {
      name: "finds fenced and inline code regions without double-counting inline code inside fences",
      text: ["before `inline` after", "```ts", "const a = `inside fence`;", "```", "tail"].join(
        "\n",
      ),
      expectedSlices: ["`inline`", "```ts\nconst a = `inside fence`;\n```"],
    },
    {
      name: "accepts alternate fence markers and unterminated trailing fences",
      text: "~~~js\nconsole.log(1)\n~~~\nplain\n```\nunterminated",
      expectedSlices: ["~~~js\nconsole.log(1)\n~~~", "```\nunterminated"],
    },
    {
      name: "keeps adjacent inline code outside fenced regions",
      text: ["```ts", "const a = 1;", "```", "after `inline` tail"].join("\n"),
      expectedSlices: ["```ts\nconst a = 1;\n```", "`inline`"],
    },
  ] as const)("$name", ({ text, expectedSlices }) => {
    expectCodeRegionSlices(text, expectedSlices);
  });

  it.each([
    {
      name: "inside code",
      positionSelector: (text: string) => text.indexOf("code"),
      expected: true,
    },
    {
      name: "outside code",
      positionSelector: (text: string) => text.indexOf("plain"),
      expected: false,
    },
    {
      name: "at region end",
      positionSelector: (_text: string, regionEnd: number) => regionEnd,
      expected: false,
    },
  ] as const)("reports whether positions are inside discovered regions: $name", (testCase) => {
    expectInsideCodeCase(testCase);
  });
});
