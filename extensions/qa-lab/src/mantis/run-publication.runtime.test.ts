// Qa Lab tests cover Mantis generation publication and rollback.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMantisBeforeAfter } from "./run.runtime.js";
import { successfulCommandResult, writeLegacyLaneSummary } from "./run.test-support.js";

async function writePublishedGenerationSentinels(outputDir: string) {
  const paths = {
    baseline: path.join(outputDir, "baseline", "last-good.txt"),
    candidate: path.join(outputDir, "candidate", "last-good.txt"),
    comparison: path.join(outputDir, "comparison.json"),
    manifest: path.join(outputDir, "mantis-evidence.json"),
    report: path.join(outputDir, "mantis-report.md"),
  };
  await fs.mkdir(path.dirname(paths.baseline), { recursive: true });
  await fs.mkdir(path.dirname(paths.candidate), { recursive: true });
  await Promise.all(
    Object.entries(paths).map(async ([component, filePath]) => {
      await fs.writeFile(filePath, `old ${component}`, "utf8");
    }),
  );
  return paths;
}

async function expectPublishedGenerationSentinels(
  paths: Awaited<ReturnType<typeof writePublishedGenerationSentinels>>,
) {
  for (const [component, filePath] of Object.entries(paths)) {
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(`old ${component}`);
  }
}

async function expectNoMantisTransientEvidence(outputDir: string) {
  const outputEntries = await fs.readdir(outputDir);
  const siblingEntries = await fs.readdir(path.dirname(outputDir));
  expect([
    ...outputEntries.filter(
      (entry) => entry.startsWith(".mantis-staged-") || entry.startsWith(".mantis-previous-"),
    ),
    ...siblingEntries.filter(
      (entry) =>
        entry.startsWith(".mantis-staged-") || entry === `${path.basename(outputDir)}.worktrees`,
    ),
  ]).toEqual([]);
}

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
    if (command === "git" && execution.stage === "worktree-cleanup") {
      await fs.rm(String(args[4]), { force: true, recursive: true });
      return successfulCommandResult();
    }
    throw new Error(`unexpected ${execution.stage} command`);
  });
}

describe("Mantis generation publication", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-publication-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("rolls back the previous generation when publication is aborted between moves", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "publish-abort");
    const sentinels = await writePublishedGenerationSentinels(outputDir);
    const controller = new AbortController();
    const runner = createSuccessfulMantisRunner();
    const originalRename = fs.rename.bind(fs);
    let previousGenerationMoved = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      await originalRename(source, target);
      if (
        !previousGenerationMoved &&
        path.resolve(String(source)) === outputDir &&
        path.basename(String(target)) === "previous"
      ) {
        previousGenerationMoved = true;
        controller.abort(new Error("publication interrupted"));
      }
    });

    try {
      await expect(
        runMantisBeforeAfter({
          baseline: "baseline-ref",
          candidate: "candidate-ref",
          commandRunner: runner,
          outputDir: ".artifacts/qa-e2e/mantis/publish-abort",
          repoRoot,
          signal: controller.signal,
          skipBuild: true,
          skipInstall: true,
        }),
      ).rejects.toThrow("Mantis artifact publication aborted");
    } finally {
      rename.mockRestore();
    }

    expect(previousGenerationMoved).toBe(true);
    await expectPublishedGenerationSentinels(sentinels);
    await expectNoMantisTransientEvidence(outputDir);
  });

  it("keeps the previous generation when aborted after all staged artifacts are written", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "late-abort");
    const sentinels = await writePublishedGenerationSentinels(outputDir);
    const controller = new AbortController();
    const runner = createSuccessfulMantisRunner();
    const originalWriteFile = fs.writeFile.bind(fs);
    let stagedManifestWritten = false;
    const writeFile = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await Reflect.apply(originalWriteFile, fs, args);
      const filePath = args[0];
      if (
        !stagedManifestWritten &&
        typeof filePath === "string" &&
        path.basename(filePath) === "mantis-evidence.json" &&
        path.basename(path.dirname(filePath)) === "generation"
      ) {
        stagedManifestWritten = true;
        controller.abort(new Error("staging interrupted"));
      }
    });

    try {
      await expect(
        runMantisBeforeAfter({
          baseline: "baseline-ref",
          candidate: "candidate-ref",
          commandRunner: runner,
          outputDir: ".artifacts/qa-e2e/mantis/late-abort",
          repoRoot,
          signal: controller.signal,
          skipBuild: true,
          skipInstall: true,
        }),
      ).rejects.toThrow("Mantis artifact publication aborted");
    } finally {
      writeFile.mockRestore();
    }

    expect(stagedManifestWritten).toBe(true);
    await expectPublishedGenerationSentinels(sentinels);
    await expectNoMantisTransientEvidence(outputDir);
  });

  it("does not remove a replacement at the staged generation path", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "staged-replaced");
    const sentinels = await writePublishedGenerationSentinels(outputDir);
    const controller = new AbortController();
    const runner = createSuccessfulMantisRunner();
    const originalRename = fs.rename.bind(fs);
    const originalWriteFile = fs.writeFile.bind(fs);
    let replacementSentinelPath = "";
    const writeFile = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await Reflect.apply(originalWriteFile, fs, args);
      const filePath = args[0];
      if (
        !replacementSentinelPath &&
        typeof filePath === "string" &&
        path.basename(filePath) === "mantis-evidence.json" &&
        path.basename(path.dirname(filePath)) === "generation"
      ) {
        const stagedRunDir = path.dirname(filePath);
        await originalRename(stagedRunDir, `${stagedRunDir}-displaced`);
        await fs.mkdir(stagedRunDir);
        replacementSentinelPath = path.join(stagedRunDir, "replacement.txt");
        await originalWriteFile(replacementSentinelPath, "replacement", "utf8");
        controller.abort(new Error("staged path replaced"));
      }
    });

    try {
      await expect(
        runMantisBeforeAfter({
          baseline: "baseline-ref",
          candidate: "candidate-ref",
          commandRunner: runner,
          outputDir: ".artifacts/qa-e2e/mantis/staged-replaced",
          repoRoot,
          signal: controller.signal,
          skipBuild: true,
          skipInstall: true,
        }),
      ).rejects.toThrow("Mantis artifact publication aborted");
    } finally {
      writeFile.mockRestore();
    }

    await expect(fs.readFile(replacementSentinelPath, "utf8")).resolves.toBe("replacement");
    await expectPublishedGenerationSentinels(sentinels);
  });

  it("does not remove a replacement at the previous generation path", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "previous-replaced");
    const sentinels = await writePublishedGenerationSentinels(outputDir);
    const runner = createSuccessfulMantisRunner();
    const originalRename = fs.rename.bind(fs);
    const originalWriteFile = fs.writeFile.bind(fs);
    let displacedPreviousDir = "";
    let replacementSentinelPath = "";
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      await originalRename(source, target);
      if (
        !replacementSentinelPath &&
        path.resolve(String(source)) === outputDir &&
        path.basename(String(target)) === "previous"
      ) {
        displacedPreviousDir = `${String(target)}-displaced`;
        await originalRename(target, displacedPreviousDir);
        await fs.mkdir(target);
        replacementSentinelPath = path.join(String(target), "replacement.txt");
        await originalWriteFile(replacementSentinelPath, "replacement", "utf8");
      }
    });

    try {
      await expect(
        runMantisBeforeAfter({
          baseline: "baseline-ref",
          candidate: "candidate-ref",
          commandRunner: runner,
          outputDir: ".artifacts/qa-e2e/mantis/previous-replaced",
          repoRoot,
          skipBuild: true,
          skipInstall: true,
        }),
      ).rejects.toThrow("Mantis run failed and could not safely write");
    } finally {
      rename.mockRestore();
    }

    await expect(fs.readFile(replacementSentinelPath, "utf8")).resolves.toBe("replacement");
    for (const [component, originalPath] of Object.entries(sentinels)) {
      const displacedPath = path.join(displacedPreviousDir, path.relative(outputDir, originalPath));
      await expect(fs.readFile(displacedPath, "utf8")).resolves.toBe(`old ${component}`);
    }
  });

  it("removes a stale failure artifact when a rerun publishes successfully", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "successful-rerun");
    await writePublishedGenerationSentinels(outputDir);
    const errorPath = path.join(outputDir, "error.txt");
    await fs.writeFile(errorPath, "old failure", "utf8");

    await expect(
      runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        commandRunner: createSuccessfulMantisRunner(),
        outputDir: ".artifacts/qa-e2e/mantis/successful-rerun",
        repoRoot,
        skipBuild: true,
        skipInstall: true,
      }),
    ).resolves.toMatchObject({ status: "pass" });

    await expect(fs.stat(errorPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoMantisTransientEvidence(outputDir);
  });
});
