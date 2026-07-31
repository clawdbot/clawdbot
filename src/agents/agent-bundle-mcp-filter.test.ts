import { describe, expect, it } from "vitest";
import {
  findAmbiguousExactMcpToolFilterPatterns,
  isMcpToolAllowedByFilter,
  matchesMcpToolFilterPattern,
} from "./agent-bundle-mcp-filter.js";

describe("matchesMcpToolFilterPattern", () => {
  it.each([
    ["", "tool", false],
    ["search_docs", "search_docs", true],
    ["search_docs", "read_docs", false],
    ["*_docs", "search_docs", true],
    ["resources_*", "resources_read", true],
    ["a**b***c", "axbyc", true],
    ["a*b*c", "acb", false],
  ])("matches %j against %j", (pattern, value, expected) => {
    expect(matchesMcpToolFilterPattern(pattern, value)).toBe(expected);
  });

  it("rejects adversarial separated wildcards without regex backtracking", () => {
    const pattern = `${"*a".repeat(128)}*b`;
    const value = `${"a".repeat(10_000)}c`;
    expect(matchesMcpToolFilterPattern(pattern, value)).toBe(false);
  });

  it("fails closed when an exact include matches raw and projected names of different tools", () => {
    const candidateGroups = [
      ["query", "demo__query"],
      ["demo__query", "demo__demo__query"],
    ];
    const ambiguousIncludePatterns = findAmbiguousExactMcpToolFilterPatterns({
      patterns: ["demo__query", "query", "demo__*"],
      candidateGroups,
    });

    expect([...ambiguousIncludePatterns]).toEqual(["demo__query"]);
    expect(
      candidateGroups.map((candidateNames) =>
        isMcpToolAllowedByFilter({
          include: ["demo__query"],
          candidateNames,
          ambiguousIncludePatterns,
        }),
      ),
    ).toEqual([false, false]);
    expect(
      isMcpToolAllowedByFilter({
        include: ["query"],
        candidateNames: candidateGroups[0]!,
        ambiguousIncludePatterns,
      }),
    ).toBe(true);
  });
});
