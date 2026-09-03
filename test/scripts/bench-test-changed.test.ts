// Bench Test Changed tests cover bench test changed script behavior.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  formatRss,
  parseArgs,
  parseMaxRssBytes,
  resolveBenchRssResult,
} from "../../scripts/bench-test-changed.mts";

function runBenchTestChanged(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/bench-test-changed.mts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
}

describe("bench-test-changed script", () => {
  it("formats macOS time RSS bytes as MiB", () => {
    expect(parseMaxRssBytes("  2097152  maximum resident set size\n")).toBe(2_097_152);
    expect(parseMaxRssBytes("  2097152kb  maximum resident set size\n")).toBeNull();
    expect(parseMaxRssBytes("  9007199254740993  maximum resident set size\n")).toBeNull();
    expect(parseMaxRssBytes("2097152\nmaximum resident set size\n")).toBeNull();
    expect(formatRss(2_097_152)).toBe("2.0MB");
    expect(formatRss(-1_048_576)).toBe("-1.0MB");
  });

  it("fails RSS-enabled runs when macOS time omits max RSS", () => {
    expect(
      resolveBenchRssResult({
        label: "routed",
        output: "child completed\n",
        rss: true,
        status: 0,
      }),
    ).toEqual({
      maxRssBytes: null,
      output:
        "child completed\n[bench-test-changed] routed missing maximum resident set size from /usr/bin/time -l output\n",
      status: 1,
    });
  });

  it("does not require RSS evidence when RSS collection is disabled", () => {
    expect(
      resolveBenchRssResult({
        label: "root",
        output: "child completed\n",
        rss: false,
        status: 0,
      }),
    ).toEqual({
      maxRssBytes: null,
      output: "child completed\n",
      status: 0,
    });
  });

  it("rejects malformed max worker values", () => {
    expect(() => parseArgs(["--max-workers", "2abc"])).toThrow(
      "--max-workers must be a positive integer",
    );
    expect(() => parseArgs(["--max-workers", "1.5"])).toThrow(
      "--max-workers must be a positive integer",
    );
  });

  it("rejects missing max worker values", () => {
    expect(() => parseArgs(["--max-workers"])).toThrow("--max-workers requires a value");
    expect(() => parseArgs(["--max-workers", "--no-rss"])).toThrow(
      "--max-workers requires a value",
    );
  });

  it("rejects duplicate max worker values", () => {
    expect(() => parseArgs(["--max-workers", "2", "--max-workers", "3"])).toThrow(
      "--max-workers was provided more than once",
    );
  });

  it("rejects unknown options before collecting changed paths", () => {
    const result = runBenchTestChanged(["--max-worker", "4"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown option: --max-worker");
    expect(result.stderr).not.toContain("at ");
  });
});
