import { describe, expect, it } from "vitest";
import { collectTextContentBlocks } from "./content-blocks.js";

describe("collectTextContentBlocks", () => {
  it("collects text content blocks in order", () => {
    const blocks = [
      { type: "text", text: "first" },
      { type: "image", data: "abc" },
      { type: "text", text: "second" },
    ];

    expect(collectTextContentBlocks(blocks)).toEqual(["first", "second"]);
  });

  it("ignores invalid entries and non-arrays", () => {
    expect(collectTextContentBlocks(null)).toStrictEqual([]);
    expect(collectTextContentBlocks([{ type: "text", text: 1 }, undefined, "x"])).toStrictEqual([]);
  });
});
