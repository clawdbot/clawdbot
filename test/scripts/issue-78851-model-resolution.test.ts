// Issue 78851 profiler CLI tests cover argument handling before work starts.
import { describe, expect, it } from "vitest";
import {
  issue78851ModelResolutionHelpRequested,
  issue78851ModelResolutionUsage,
  parseIssue78851ModelResolutionOptions,
} from "../../scripts/perf/issue-78851-model-resolution-cli.js";

describe("issue 78851 model resolution profiler CLI", () => {
  it("prints help without starting the profiler", () => {
    const usage = issue78851ModelResolutionUsage();

    expect(issue78851ModelResolutionHelpRequested(["--help"])).toBe(true);
    expect(usage).toContain("OpenClaw issue #78851 model-resolution profiler");
    expect(usage).toContain(
      "node --import tsx scripts/perf/issue-78851-model-resolution.ts [options]",
    );
  });

  it("rejects unknown arguments before starting the profiler", () => {
    expect(() => parseIssue78851ModelResolutionOptions(["--wat"])).toThrow(
      "Unknown argument: --wat",
    );
  });

  it("rejects partial numeric arguments before starting the profiler", () => {
    expect(() => parseIssue78851ModelResolutionOptions(["--providers", "48junk"])).toThrow(
      "--providers must be a positive integer",
    );
  });

  it("rejects short flag values before starting the profiler", () => {
    expect(() => parseIssue78851ModelResolutionOptions(["--providers", "-h"])).toThrow(
      "--providers requires a value",
    );
  });

  it("rejects invalid arguments even when help is also requested", () => {
    expect(() => parseIssue78851ModelResolutionOptions(["--wat", "--help"])).toThrow(
      "Unknown argument: --wat",
    );
  });

  it("rejects duplicate value flags before starting the profiler", () => {
    expect(() =>
      parseIssue78851ModelResolutionOptions(["--providers", "48", "--providers", "96"]),
    ).toThrow("--providers was provided more than once");
  });
});
