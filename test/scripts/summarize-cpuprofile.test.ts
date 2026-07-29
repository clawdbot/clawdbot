// Summarize Cpuprofile tests cover summarize cpuprofile script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, shouldPrintHelp } from "../../scripts/perf/summarize-cpuprofile.mjs";

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
    expect(parseArgs(["--limit", "5", "--", "--dash.cpuprofile"])).toEqual({
      files: ["--dash.cpuprofile"],
      limit: 5,
    });
  });

  it("prints help without treating it as a profile path", () => {
    expect(shouldPrintHelp(["--help"])).toBe(true);
    expect(shouldPrintHelp(["--limit", "-h", "a.cpuprofile"])).toBe(false);
    expect(shouldPrintHelp(["--limit", "--", "--help"])).toBe(false);
    expect(shouldPrintHelp(["--limit=1e3", "--help"])).toBe(false);
    expect(shouldPrintHelp(["--", "--help"])).toBe(false);

    const result = spawnSync(
      process.execPath,
      ["scripts/perf/summarize-cpuprofile.mjs", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: scripts/perf/summarize-cpuprofile.mjs");
    expect(result.stderr).toBe("");
  });

  it("rejects malformed limit flags instead of falling back", () => {
    for (const args of [
      ["--limit", "3frames", "a.cpuprofile"],
      ["--limit", "-h", "a.cpuprofile"],
      ["--limit", "--", "--help"],
      ["--limit", "0", "a.cpuprofile"],
      ["--limit=1e3", "a.cpuprofile"],
      ["--limit"],
    ]) {
      expect(() => parseArgs(args)).toThrow("--limit must be a positive integer");
    }

    const result = spawnSync(
      process.execPath,
      ["scripts/perf/summarize-cpuprofile.mjs", "--limit", "-h", "a.cpuprofile"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--limit must be a positive integer");
  });

  it("rejects unknown options instead of treating them as profile paths", () => {
    expect(() => parseArgs(["--wat"])).toThrow("Unknown option: --wat");

    const result = spawnSync(process.execPath, ["scripts/perf/summarize-cpuprofile.mjs", "--wat"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown option: --wat");
  });

  it("rejects empty CPU profiles instead of printing zero-sample summaries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cpuprofile-"));
    const profilePath = path.join(tempDir, "empty.cpuprofile");
    fs.writeFileSync(
      profilePath,
      `${JSON.stringify({ endTime: 1, nodes: [], samples: [], startTime: 1 })}\n`,
      "utf8",
    );
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/perf/summarize-cpuprofile.mjs", profilePath],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CPU profile has no nodes");
      expect(result.stdout).not.toContain("samples: 0");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("summarizes profiles with real samples", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cpuprofile-"));
    const profilePath = path.join(tempDir, "sample.cpuprofile");
    fs.writeFileSync(
      profilePath,
      `${JSON.stringify({
        endTime: 1200,
        nodes: [
          {
            callFrame: {
              columnNumber: 0,
              functionName: "run",
              lineNumber: 4,
              scriptId: "1",
              url: "file:///repo/dist/entry.js",
            },
            id: 1,
          },
        ],
        samples: [1],
        startTime: 0,
        timeDeltas: [1200],
      })}\n`,
      "utf8",
    );
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/perf/summarize-cpuprofile.mjs", profilePath],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("duration_ms: 1.2 samples: 1");
      expect(result.stdout).toContain("1.2ms\trun");
      expect(result.stdout).toContain("dist/entry.js");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
