// Qa Lab tests cover immutable Mantis generation publication.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { acquireFileLock } from "openclaw/plugin-sdk/file-lock";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishMantisRunOutput } from "./run-artifacts.runtime.js";
import { runMantisBeforeAfter } from "./run.runtime.js";
import {
  findSingleMantisGenerationErrorPath,
  requireArgAfter,
  successfulCommandResult,
  writeLegacyLaneSummary,
} from "./run.test-support.js";

const COMPATIBILITY_FILES = ["comparison.json", "mantis-report.md", "mantis-evidence.json"];

function createSuccessfulMantisRunner(marker?: string) {
  return vi.fn(async (command: string, args: readonly string[], execution) => {
    if (command === "git" && execution.stage === "worktree-add") {
      await fs.mkdir(String(args[4]), { recursive: true });
      return successfulCommandResult();
    }
    if (command === "pnpm" && execution.stage === "qa") {
      await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
      if (marker) {
        const laneOutputDir = path.join(
          requireArgAfter(args, "--repo-root"),
          requireArgAfter(args, "--output-dir"),
        );
        await fs.writeFile(path.join(laneOutputDir, `${marker}.txt`), marker, "utf8");
      }
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

async function writeGenerationFixture(outputDir: string, name: string, marker: string) {
  const generationDir = path.join(outputDir, ".mantis-generations", name);
  for (const lane of ["baseline", "candidate"]) {
    await fs.mkdir(path.join(generationDir, lane), { recursive: true });
    await fs.writeFile(path.join(generationDir, lane, `${marker}.txt`), marker, "utf8");
  }
  for (const file of COMPATIBILITY_FILES) {
    await fs.writeFile(path.join(generationDir, file), `${marker} ${file}`, "utf8");
  }
  return generationDir;
}

async function writeCompatibilityFixture(outputDir: string, marker: string) {
  for (const lane of ["baseline", "candidate"]) {
    await fs.mkdir(path.join(outputDir, lane), { recursive: true });
    await fs.writeFile(path.join(outputDir, lane, `${marker}.txt`), marker, "utf8");
  }
  for (const file of COMPATIBILITY_FILES) {
    await fs.writeFile(path.join(outputDir, file), `${marker} ${file}`, "utf8");
  }
}

async function expectCompatibilityFixture(outputDir: string, marker: string) {
  for (const lane of ["baseline", "candidate"]) {
    await expect(fs.readFile(path.join(outputDir, lane, `${marker}.txt`), "utf8")).resolves.toBe(
      marker,
    );
  }
  for (const file of COMPATIBILITY_FILES) {
    await expect(fs.readFile(path.join(outputDir, file), "utf8")).resolves.toBe(
      `${marker} ${file}`,
    );
  }
}

async function expectCompatibilityMatchesGeneration(outputDir: string, generationDir: string) {
  for (const file of COMPATIBILITY_FILES) {
    await expect(fs.readFile(path.join(outputDir, file), "utf8")).resolves.toBe(
      await fs.readFile(path.join(generationDir, file), "utf8"),
    );
  }
  for (const lane of ["baseline", "candidate"]) {
    const directEntries = (await fs.readdir(path.join(outputDir, lane))).toSorted();
    const generationEntries = (await fs.readdir(path.join(generationDir, lane))).toSorted();
    expect(directEntries).toEqual(generationEntries);
    for (const entry of directEntries) {
      await expect(fs.readFile(path.join(outputDir, lane, entry), "utf8")).resolves.toBe(
        await fs.readFile(path.join(generationDir, lane, entry), "utf8"),
      );
    }
  }
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
    const currentGeneration = await readCurrentGeneration(outputDir);
    expect(result.outputDir).toBe(outputDir);
    expect(result.comparisonPath).toBe(path.join(outputDir, "comparison.json"));
    expect(result.manifestPath).toBe(path.join(outputDir, "mantis-evidence.json"));
    expect(result.reportPath).toBe(path.join(outputDir, "mantis-report.md"));
    await expectCompatibilityMatchesGeneration(outputDir, currentGeneration);
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
    await writeCompatibilityFixture(outputDir, "old");
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
    await expectCompatibilityFixture(outputDir, "old");
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
    await run;
    const publishedGeneration = await readCurrentGeneration(outputDir);
    observed.push(publishedGeneration);

    expect(observed).toContain(oldGeneration);
    expect(observed).toContain(publishedGeneration);
  });

  it("rolls the direct compatibility paths back when the pointer commit fails", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "rollback");
    const oldGeneration = await writeGenerationFixture(outputDir, "generation-old", "old");
    const newGeneration = await writeGenerationFixture(outputDir, "generation-new", "new");
    await writeCompatibilityFixture(outputDir, "old");
    await fs.writeFile(
      path.join(outputDir, "mantis-current.json"),
      `${JSON.stringify({ generation: ".mantis-generations/generation-old", schemaVersion: 1 })}\n`,
      "utf8",
    );
    const realOutputRoot = await root(outputDir);
    const pointerError = new Error("pointer commit failed");

    await expect(
      publishMantisRunOutput({
        generationDir: newGeneration,
        outputDir,
        outputRoot: {
          copyIn: realOutputRoot.copyIn.bind(realOutputRoot),
          exists: realOutputRoot.exists.bind(realOutputRoot),
          list: realOutputRoot.list.bind(realOutputRoot),
          mkdir: realOutputRoot.mkdir.bind(realOutputRoot),
          move: realOutputRoot.move.bind(realOutputRoot),
          remove: realOutputRoot.remove.bind(realOutputRoot),
          stat: realOutputRoot.stat.bind(realOutputRoot),
          writeJson: vi.fn(async () => {
            throw pointerError;
          }),
        },
      }),
    ).rejects.toBe(pointerError);

    await expect(readCurrentGeneration(outputDir)).resolves.toBe(oldGeneration);
    await expectCompatibilityFixture(outputDir, "old");
    expect(
      (await fs.readdir(outputDir)).filter((entry) => entry.startsWith(".mantis-compat-")),
    ).toEqual([]);
  });

  it("stops promptly when cancellation wins during publication lock contention", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cancel-lock");
    const oldGeneration = await writeGenerationFixture(outputDir, "generation-old", "old");
    const newGeneration = await writeGenerationFixture(outputDir, "generation-new", "new");
    await writeCompatibilityFixture(outputDir, "old");
    const currentPath = path.join(outputDir, "mantis-current.json");
    await fs.writeFile(
      currentPath,
      `${JSON.stringify({ generation: ".mantis-generations/generation-old", schemaVersion: 1 })}\n`,
      "utf8",
    );
    const held = await acquireFileLock(currentPath, {
      retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
      stale: 60_000,
    });
    const controller = new AbortController();
    const abortReason = new Error("publication cancelled");
    const outputRoot = await root(outputDir);
    const publication = publishMantisRunOutput({
      generationDir: newGeneration,
      outputDir,
      outputRoot,
      signal: controller.signal,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    controller.abort(abortReason);

    try {
      await expect(publication).rejects.toBe(abortReason);
    } finally {
      await held.release();
    }
    await expect(readCurrentGeneration(outputDir)).resolves.toBe(oldGeneration);
    await expectCompatibilityFixture(outputDir, "old");
  });

  it("serializes concurrent publications and leaves the direct view on the pointer generation", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "concurrent");
    await Promise.all([
      runMantisBeforeAfter({
        baseline: "baseline-a",
        candidate: "candidate-a",
        commandRunner: createSuccessfulMantisRunner("run-a"),
        outputDir: ".artifacts/qa-e2e/mantis/concurrent",
        repoRoot,
        skipBuild: true,
        skipInstall: true,
      }),
      runMantisBeforeAfter({
        baseline: "baseline-b",
        candidate: "candidate-b",
        commandRunner: createSuccessfulMantisRunner("run-b"),
        outputDir: ".artifacts/qa-e2e/mantis/concurrent",
        repoRoot,
        skipBuild: true,
        skipInstall: true,
      }),
    ]);

    await expectCompatibilityMatchesGeneration(outputDir, await readCurrentGeneration(outputDir));
    expect(
      (await fs.readdir(outputDir)).filter((entry) => entry.startsWith(".mantis-compat-")),
    ).toEqual([]);
  });
});
