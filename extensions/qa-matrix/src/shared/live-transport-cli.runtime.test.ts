import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLiveTransportQaOutputTee } from "./live-transport-cli.runtime.js";

const tmpDirs: string[] = [];

describe("live transport CLI runtime", () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("tees stdout and stderr into an output artifact", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-output-"));
    tmpDirs.push(outputDir);
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    const tee = await startLiveTransportQaOutputTee({
      fileName: "matrix-qa-output.log",
      outputDir,
    });
    try {
      process.stdout.write("stdout marker\n");
      process.stderr.write("stderr marker\n");
      await tee.stop();
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    expect(process.stdout.write).toBe(originalStdoutWrite);
    expect(process.stderr.write).toBe(originalStderrWrite);
    await expect(readFile(tee.outputPath, "utf8")).resolves.toContain("stdout marker\n");
    await expect(readFile(tee.outputPath, "utf8")).resolves.toContain("stderr marker\n");
  });

  it("surfaces output artifact stream errors after restoring process writes", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-output-"));
    tmpDirs.push(outputDir);
    await rm(path.join(outputDir, "matrix-qa-output.log"), { recursive: true, force: true });
    await mkdir(path.join(outputDir, "matrix-qa-output.log"), { recursive: true });
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const mutedStdoutWrite = (() => true) as typeof process.stdout.write;
    const mutedStderrWrite = (() => true) as typeof process.stderr.write;
    process.stdout.write = mutedStdoutWrite;
    process.stderr.write = mutedStderrWrite;

    try {
      const tee = await startLiveTransportQaOutputTee({
        fileName: "matrix-qa-output.log",
        outputDir,
      });
      process.stdout.write("stdout marker\n");
      await expect(tee.stop()).rejects.toMatchObject({ code: "EISDIR" });

      expect(process.stdout.write).toBe(mutedStdoutWrite);
      expect(process.stderr.write).toBe(mutedStderrWrite);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  });
});
