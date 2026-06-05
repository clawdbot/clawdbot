// Summarize Cpuprofile tests cover summarize cpuprofile script behavior.
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/perf/summarize-cpuprofile.mjs";

describe("scripts/perf/summarize-cpuprofile.mjs", () => {
  it("parses split and inline positive limit flags", () => {
    expect(parseArgs(["--limit", "5", "a.cpuprofile"])).toEqual({
      files: ["a.cpuprofile"],
      limit: 5,
    });
    expect(parseArgs(["--limit=7", "a.cpuprofile", "b.cpuprofile"])).toEqual({
      files: ["a.cpuprofile", "b.cpuprofile"],
      limit: 7,
    });
  });

  it("rejects malformed limit flags instead of falling back", () => {
    for (const args of [
      ["--limit", "3frames", "a.cpuprofile"],
      ["--limit", "0", "a.cpuprofile"],
      ["--limit=1e3", "a.cpuprofile"],
      ["--limit"],
    ]) {
      expect(() => parseArgs(args)).toThrow("--limit must be a positive integer");
    }
  });
});
