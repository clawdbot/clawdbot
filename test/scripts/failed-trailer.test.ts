import { describe, expect, it } from "vitest";
import { runWithFailedTrailer, writeFailedTrailer } from "../../scripts/lib/failed-trailer.mts";

describe("writeFailedTrailer", () => {
  it("prints a trailer for numeric nonzero exit codes", () => {
    const lines: unknown[] = [];
    writeFailedTrailer("test", 1, (line) => lines.push(line));
    expect(lines).toEqual(["[test] FAILED (exit 1)"]);
  });

  it("prints a trailer for string nonzero exit codes", () => {
    const lines: unknown[] = [];
    writeFailedTrailer("vitest", "1", (line) => lines.push(line));
    expect(lines).toEqual(["[vitest] FAILED (exit 1)"]);
  });

  it("skips trailers for zero and unset codes", () => {
    const lines: unknown[] = [];
    writeFailedTrailer("test", 0, (line) => lines.push(line));
    writeFailedTrailer("test", "0", (line) => lines.push(line));
    writeFailedTrailer("test", undefined, (line) => lines.push(line));
    expect(lines).toEqual([]);
  });
});

describe("runWithFailedTrailer", () => {
  it("reports a string process.exitCode set by the inner run", async () => {
    const prior = process.exitCode;
    const lines: unknown[] = [];
    try {
      process.exitCode = "2";
      await runWithFailedTrailer("lint", () => {}, (line) => lines.push(line));
      expect(lines).toEqual(["[lint] FAILED (exit 2)"]);
    } finally {
      process.exitCode = prior;
    }
  });
});
