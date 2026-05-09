import { describe, expect, it } from "vitest";
import { parseQmdQueryJson } from "./qmd-query-parser.js";

describe("parseQmdQueryJson", () => {
  it("parses clean qmd JSON output", () => {
    const results = parseQmdQueryJson('[{"docid":"abc","score":1,"snippet":"@@ -1,1\\none"}]', "");
    expect(results).toEqual([
      {
        docid: "abc",
        score: 1,
        snippet: "@@ -1,1\none",
      },
    ]);
  });

  it("extracts embedded result arrays from noisy stdout", () => {
    const results = parseQmdQueryJson(
      `initializing
{"payload":"ok"}
[{"docid":"abc","score":0.5}]
complete`,
      "",
    );
    expect(results).toEqual([{ docid: "abc", score: 0.5 }]);
  });

  it("preserves explicit qmd line metadata when present", () => {
    const results = parseQmdQueryJson(
      '[{"docid":"abc","score":0.5,"start_line":4,"end_line":6,"snippet":"@@ -10,1\\nignored"}]',
      "",
    );
    expect(results).toEqual([
      {
        docid: "abc",
        score: 0.5,
        snippet: "@@ -10,1\nignored",
        startLine: 4,
        endLine: 6,
      },
    ]);
  });

  it("treats plain-text no-results from stderr as an empty result set", () => {
    const results = parseQmdQueryJson("", "No results found\n");
    expect(results).toStrictEqual([]);
  });

  it("treats prefixed no-results marker output as an empty result set", () => {
    expect(parseQmdQueryJson("warning: no results found", "")).toStrictEqual([]);
    expect(parseQmdQueryJson("", "[qmd] warning: no results found\n")).toStrictEqual([]);
  });

  it("does not treat arbitrary non-marker text as no-results output", () => {
    expect(() =>
      parseQmdQueryJson("warning: search completed; no results found for this query", ""),
    ).toThrow(/qmd query returned invalid JSON/i);
  });

  it("throws when stdout cannot be interpreted as qmd JSON", () => {
    expect(() => parseQmdQueryJson("this is not json", "")).toThrow(
      /qmd query returned invalid JSON/i,
    );
  });
});
