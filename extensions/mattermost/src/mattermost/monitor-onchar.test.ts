import { describe, expect, it } from "vitest";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";

describe("mattermost monitor onchar", () => {
  it("uses defaults when prefixes are missing or empty after trimming", () => {
    expect(resolveOncharPrefixes(undefined)).toEqual([">", "!"]);
    expect(resolveOncharPrefixes([" ", ""])).toEqual([">", "!"]);
  });

  it("trims configured prefixes and preserves order", () => {
    expect(resolveOncharPrefixes(["  ?? ", " !", " /bot "])).toEqual(["??", "!", "/bot"]);
  });

  it("strips the first matching prefix after leading whitespace", () => {
    expect(stripOncharPrefix("   ! hello world", ["!", ">"])).toEqual({
      triggered: true,
      stripped: "hello world",
    });

    expect(stripOncharPrefix("??multi prefix", ["??", "?"])).toEqual({
      triggered: true,
      stripped: "multi prefix",
    });
  });

  it("returns the original text when no prefix matches", () => {
    expect(stripOncharPrefix("hello world", ["!", ">"])).toEqual({
      triggered: false,
      stripped: "hello world",
    });
  });
});
