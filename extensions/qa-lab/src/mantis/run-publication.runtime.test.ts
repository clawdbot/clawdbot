// Qa Lab tests cover immutable Mantis generation publication.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMantisBeforeAfter } from "./run.runtime.js";
import {
  findSingleMantisGenerationErrorPath,
  successfulCommandResult,
  writeLegacyLaneSummary,
} from "./run.test-support.js";

function createSuccessfulMantisRunner() {
  return vi.fn(async (command: string, args: readonly string[], execution) => {
    if (command === "git" && execution.stage === "worktree-add") {
      await fs.mkdir(String(args[4]), { recursive: true });
      return successfulCommandResult();
    }
    if (command === "pnpm" && execution.stage === "qa") {
      await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
      return successfulCommandResult();
    }
    if (command === "git" && execution.stage === "worktree-cleanup" && args[1] === "remove") {
      await fs.rm(execution.cwd, { force: true, recursive: true });
      return successfulCommandResult();
    }
    if (command === "git" && execution.stage === "worktree-cleanup" && args[1] === "list") {
      return successfulCommandResult();
    }
    throw new Error(`unexpected ${execution.stage} command`);
  });
}

async function readCurrentGeneration(outputDir: string): Promise<string> {
  const parsed = JSON.parse(
    await fs.readFile(path.join(outputDir, "mantis-current.json"), "utf8"),
  ) as { generation: string; schemaVersion: number };
  expect(parsed.schemaVersion).toBe(1);
  return path.join(outputDir, ...parsed.generation.split(path.posix.sep));
}

describe("Mantis generation publication", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-publication-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("publishes one immutable generation without replacing caller-owned output entries", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "preserve");
    await fs.mkdir(outputDir, { recursive: true });
    const sentinelPath = path.join(outputDir, "unrelated-preserve-me.txt");
    await fs.writeFile(sentinelPath, "caller data", "utf8");
    await fs.writeFile(path.join(outputDir, "error.txt"), "old failure", "utf8");

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: createSuccessfulMantisRunner(),
      outputDir: ".artifacts/qa-e2e/mantis/preserve",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    });

    await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("caller data");
    await expect(fs.readFile(path.join(outputDir, "error.txt"), "utf8")).resolves.toBe(
      "old failure",
    );
    await expect(readCurrentGeneration(outputDir)).resolves.toBe(result.outputDir);
    await expect(fs.readFile(result.comparisonPath, "utf8")).resolves.toContain('"pass": true');
    await expect(fs.stat(path.join(result.outputDir, "baseline"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(fs.stat(path.join(result.outputDir, "candidate"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("keeps the previous pointer and generation when abort wins before the commit point", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "abort");
    const oldGeneration = path.join(outputDir, ".mantis-generations", "generation-old");
    await fs.mkdir(oldGeneration, { recursive: true });
    await fs.writeFile(path.join(oldGeneration, "last-good.txt"), "old generation", "utf8");
    await fs.writeFile(
      path.join(outputDir, "mantis-current.json"),
      `${JSON.stringify({ generation: ".mantis-generations/generation-old", schemaVersion: 1 })}\n`,
      "utf8",
    );
    const controller = new AbortController();
    const originalWriteFile = fs.writeFile.bind(fs);
    const writeFile = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await Reflect.apply(originalWriteFile, fs, args);
      const filePath = args[0];
      if (
        typeof filePath === "string" &&
        path.basename(filePath) === "mantis-evidence.json" &&
        filePath.includes(`${path.sep}.mantis-generations${path.sep}`)
      ) {
        controller.abort(new Error("publication interrupted"));
      }
    });

    try {
      await expect(
        runMantisBeforeAfter({
          baseline: "baseline-ref",
          candidate: "candidate-ref",
          commandRunner: createSuccessfulMantisRunner(),
          outputDir: ".artifacts/qa-e2e/mantis/abort",
          repoRoot,
          signal: controller.signal,
          skipBuild: true,
          skipInstall: true,
        }),
      ).rejects.toThrow("Mantis artifact publication aborted");
    } finally {
      writeFile.mockRestore();
    }

    await expect(readCurrentGeneration(outputDir)).resolves.toBe(oldGeneration);
    await expect(fs.readFile(path.join(oldGeneration, "last-good.txt"), "utf8")).resolves.toBe(
      "old generation",
    );
    const errorPath = await findSingleMantisGenerationErrorPath(outputDir);
    await expect(fs.readFile(errorPath, "utf8")).resolves.toContain(
      "Mantis artifact publication aborted",
    );
  });

  it("never makes the stable pointer absent while publishing a replacement", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "observable");
    const oldGeneration = path.join(outputDir, ".mantis-generations", "generation-old");
    await fs.mkdir(oldGeneration, { recursive: true });
    await fs.writeFile(
      path.join(outputDir, "mantis-current.json"),
      `${JSON.stringify({ generation: ".mantis-generations/generation-old", schemaVersion: 1 })}\n`,
      "utf8",
    );

    let settled = false;
    const run = runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: createSuccessfulMantisRunner(),
      outputDir: ".artifacts/qa-e2e/mantis/observable",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    }).finally(() => {
      settled = true;
    });
    const observed: string[] = [];
    for (;;) {
      observed.push(await readCurrentGeneration(outputDir));
      if (settled) {
        break;
      }
      await waitForImmediate();
    }
    const result = await run;
    observed.push(await readCurrentGeneration(outputDir));

    expect(observed).toContain(oldGeneration);
    expect(observed).toContain(result.outputDir);
  });
});
