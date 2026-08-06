// Incremental Line Reader tests cover shared streaming E2E log tail behavior.
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIncrementalLineReader } from "../../scripts/e2e/lib/incremental-line-reader.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function withTempLog(run: (logPath: string) => void): void {
  const root = makeTempDir(tempDirs, "openclaw-line-reader-");
  run(path.join(root, "output.log"));
}

describe("scripts/e2e/lib/incremental-line-reader.mjs", () => {
  it("returns complete appended lines and carries partial lines forward", () => {
    withTempLog((logPath) => {
      const reader = createIncrementalLineReader(logPath);

      expect(reader.readLines()).toEqual({ lines: [], reset: false });

      writeFileSync(logPath, "first\nsecond\npartial", "utf8");
      expect(reader.readLines()).toEqual({ lines: ["first", "second"], reset: false });

      appendFileSync(logPath, "\nthird\n", "utf8");
      expect(reader.readLines()).toEqual({ lines: ["partial", "third"], reset: false });
      expect(reader.readLines()).toEqual({ lines: [], reset: false });
    });
  });

  it("resets when an existing log is rewritten without changing size", () => {
    withTempLog((logPath) => {
      writeFileSync(logPath, "first\n", "utf8");
      const reader = createIncrementalLineReader(logPath);

      expect(reader.readLines()).toEqual({ lines: ["first"], reset: false });

      writeFileSync(logPath, "other\n", "utf8");
      expect(reader.readLines()).toEqual({ lines: ["other"], reset: true });
    });
  });

  it("clamps oversized initial reads to complete tail lines", () => {
    withTempLog((logPath) => {
      writeFileSync(logPath, "drop-partial\nkeep\nlast\n", "utf8");
      const reader = createIncrementalLineReader(logPath, { maxReadBytes: 7 });

      expect(reader.readLines()).toEqual({ lines: ["last"], reset: false });
    });
  });
});
