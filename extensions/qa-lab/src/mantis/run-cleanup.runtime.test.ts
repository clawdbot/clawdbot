// Qa Lab tests cover bounded, Git-owned Mantis worktree cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeLegacyMantisWorktrees, removeMantisWorktree } from "./run-cleanup.runtime.js";
import { captureMantisDirectoryOwnership, hasSameFileIdentity } from "./run-directory.runtime.js";
import {
  failedCommandResult,
  successfulCommandResult,
  worktreeListOutput,
} from "./run.test-support.js";

const commandTimeouts = {
  build: 1_000,
  install: 1_000,
  qa: 1_000,
  "worktree-add": 1_000,
  "worktree-cleanup": 1_000,
};

describe("Mantis worktree cleanup", () => {
  let repoRoot: string;
  let worktreeRoot: string;
  let worktreeDir: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-cleanup-"));
    worktreeRoot = path.join(repoRoot, ".artifacts", "run.worktrees");
    worktreeDir = path.join(worktreeRoot, "baseline-generation-test");
    await fs.mkdir(worktreeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("lets Git remove the registered worktree and verifies registration afterward", async () => {
    const ownership = await captureMantisDirectoryOwnership({
      directoryPath: worktreeDir,
      repoRoot,
    });
    const runner = vi.fn(async (_command: string, args: readonly string[], execution) => {
      if (args[1] === "remove") {
        await fs.rm(execution.cwd, { force: true, recursive: true });
      }
      return successfulCommandResult();
    });

    await expect(
      removeMantisWorktree({
        commandTimeouts,
        lane: "baseline",
        ownership,
        repoRoot,
        runner,
        worktreeDir,
      }),
    ).resolves.toBeUndefined();

    await expect(fs.stat(worktreeDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runner.mock.calls[0]?.[1]).toEqual(["worktree", "remove", "--force", "--", "."]);
    expect(runner.mock.calls[0]?.[2]).toMatchObject({
      cwd: worktreeDir,
      expectedCwdIdentity: {
        dev: ownership.targetDevice,
        ino: ownership.targetInode,
      },
    });
    expect(runner.mock.calls[1]?.[1]).toEqual(["worktree", "list", "--porcelain", "-z"]);
  });

  it("preserves a replacement introduced after the ownership check", async () => {
    const ownership = await captureMantisDirectoryOwnership({
      directoryPath: worktreeDir,
      repoRoot,
    });
    const displacedPath = `${worktreeDir}-displaced`;
    const sentinelPath = path.join(worktreeDir, "preserve-me.txt");
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[1] === "remove") {
        await fs.rename(worktreeDir, displacedPath);
        await fs.mkdir(worktreeDir);
        await fs.writeFile(sentinelPath, "replacement", "utf8");
        return failedCommandResult();
      }
      return successfulCommandResult();
    });

    await expect(
      removeMantisWorktree({
        commandTimeouts,
        lane: "baseline",
        ownership,
        repoRoot,
        runner,
        worktreeDir,
      }),
    ).rejects.toThrow("Mantis preserved the path because Git no longer owns it");

    await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("replacement");
    await expect(fs.stat(displacedPath)).resolves.toBeDefined();
  });

  it("does not remove an unregistered partial path without an ownership receipt", async () => {
    const sentinelPath = path.join(worktreeDir, "partial.txt");
    await fs.writeFile(sentinelPath, "partial", "utf8");
    const runner = vi.fn(async () => successfulCommandResult());

    await expect(
      removeMantisWorktree({
        commandTimeouts,
        lane: "baseline",
        repoRoot,
        runner,
        worktreeDir,
      }),
    ).rejects.toThrow("Mantis preserved the path because Git no longer owns it");

    await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("partial");
  });

  it("does not adopt an existing registered path without an ownership receipt", async () => {
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[1] === "list") {
        return successfulCommandResult(worktreeListOutput(worktreeDir));
      }
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    });

    await expect(
      removeMantisWorktree({
        commandTimeouts,
        lane: "baseline",
        repoRoot,
        runner,
        worktreeDir,
      }),
    ).rejects.toThrow("baseline worktree cleanup left registered path");
    await expect(fs.lstat(worktreeDir)).resolves.toBeDefined();
  });

  it("keeps one total deadline across Git removal and registration verification", async () => {
    const ownership = await captureMantisDirectoryOwnership({
      directoryPath: worktreeDir,
      repoRoot,
    });
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[1] === "remove") {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        await fs.rm(worktreeDir, { force: true, recursive: true });
      }
      return successfulCommandResult();
    });

    await expect(
      removeMantisWorktree({
        commandTimeouts: { ...commandTimeouts, "worktree-cleanup": 5 },
        lane: "baseline",
        ownership,
        repoRoot,
        runner,
        worktreeDir,
      }),
    ).rejects.toThrow("exceeded its total 5ms deadline");
  });

  it("keeps one total deadline across legacy discovery and removal", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "legacy-deadline");
    const legacyWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    await fs.mkdir(legacyWorktreeDir, { recursive: true });
    let nowMs = 0;
    let listCalls = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const runner = vi.fn(async (_command: string, args: readonly string[], execution) => {
      if (args[1] === "list") {
        listCalls += 1;
        if (listCalls === 1) {
          nowMs += 60;
          return successfulCommandResult(worktreeListOutput(legacyWorktreeDir));
        }
        return successfulCommandResult();
      }
      if (args[1] === "remove") {
        nowMs += 60;
        await fs.rm(execution.cwd, { force: true, recursive: true });
        return successfulCommandResult();
      }
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    });

    try {
      await expect(
        removeLegacyMantisWorktrees({
          commandTimeouts: { ...commandTimeouts, "worktree-cleanup": 100 },
          outputDir,
          repoRoot,
          runner,
        }),
      ).rejects.toThrow("exceeded its total 100ms deadline");
    } finally {
      now.mockRestore();
    }
  });

  it("attributes a shared legacy deadline expiry to the active candidate lane", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "legacy-candidate-deadline");
    const legacyRoot = path.join(outputDir, "worktrees");
    const baselineDir = path.join(legacyRoot, "baseline");
    const candidateDir = path.join(legacyRoot, "candidate");
    await Promise.all([
      fs.mkdir(baselineDir, { recursive: true }),
      fs.mkdir(candidateDir, { recursive: true }),
    ]);
    const registeredPaths = new Set([baselineDir, candidateDir]);
    let nowMs = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const runner = vi.fn(async (_command: string, args: readonly string[], execution) => {
      if (args[1] === "list") {
        return successfulCommandResult(
          [...registeredPaths].map((entry) => worktreeListOutput(entry)).join(""),
        );
      }
      if (args[1] === "remove") {
        nowMs += 60;
        registeredPaths.delete(execution.cwd);
        await fs.rm(execution.cwd, { force: true, recursive: true });
        return successfulCommandResult();
      }
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    });

    try {
      await expect(
        removeLegacyMantisWorktrees({
          commandTimeouts: { ...commandTimeouts, "worktree-cleanup": 100 },
          outputDir,
          repoRoot,
          runner,
        }),
      ).rejects.toThrow("candidate worktree cleanup exceeded its total 100ms deadline");
    } finally {
      now.mockRestore();
    }
  });

  it("keeps high file identities exact", () => {
    const first = { dev: 1n, ino: 9_007_199_254_740_992n };
    const second = { dev: 1n, ino: 9_007_199_254_740_993n };

    expect(Number(first.ino)).toBe(Number(second.ino));
    expect(hasSameFileIdentity(first, second)).toBe(false);
  });
});
