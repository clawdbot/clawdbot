import { describe, expect, it } from "vitest";
import { isMcpToolAllowed, normalizeMcpToolFilter } from "./mcp-tool-filter.js";

describe("isMcpToolAllowed", () => {
  it.each([
    ["", "tool", false],
    ["search_docs", "search_docs", true],
    ["search_docs", "read_docs", false],
    ["*_docs", "search_docs", true],
    ["resources_*", "resources_read", true],
    ["a**b***c", "axbyc", true],
    ["a*b*c", "acb", false],
  ])("matches %j against %j", (pattern, value, expected) => {
    expect(isMcpToolAllowed({ include: [pattern] }, value)).toBe(expected);
  });

  it("rejects adversarial separated wildcards without regex backtracking", () => {
    const pattern = `${"*a".repeat(128)}*b`;
    const value = `${"a".repeat(10_000)}c`;
    expect(isMcpToolAllowed({ include: [pattern] }, value)).toBe(false);
  });

  it.each([
    [undefined, undefined],
    ["malformed", undefined],
    [{ include: "search_*", exclude: 42 }, undefined],
    [{ include: [] }, undefined],
    [{ include: [false, "search_*", null] }, { include: ["search_*"] }],
    [{ include: [false, null] }, undefined],
    [{ exclude: [false, "search_*", null] }, { exclude: ["search_*"] }],
    [
      { include: [" *_docs "], exclude: ["admin_*"] },
      { include: [" *_docs "], exclude: ["admin_*"] },
    ],
  ])("normalizes filter %j", (raw, expected) => {
    expect(normalizeMcpToolFilter(raw)).toEqual(expected);
  });

  it("requires an include match and lets exclude win", () => {
    const filter = { include: ["*_docs"], exclude: ["search_*"] };
    expect(isMcpToolAllowed(filter, "read_docs")).toBe(true);
    expect(isMcpToolAllowed(filter, "search_docs")).toBe(false);
    expect(isMcpToolAllowed(filter, "read_file")).toBe(false);
  });
});
