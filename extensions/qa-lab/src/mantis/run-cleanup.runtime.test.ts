// Qa Lab tests cover bounded Mantis worktree cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMantisWorktreeDirectory, removeMantisWorktree } from "./run-cleanup.runtime.js";
import { runMantisBeforeAfter } from "./run.runtime.js";
import {
  failedCommandResult,
  legacyWorktreeListOutput,
  successfulCommandResult,
  timedOutCommandResult,
  worktreeListOutput,
  writeLegacyLaneSummary,
} from "./run.test-support.js";

describe("mantis worktree cleanup runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-cleanup-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("shares one decreasing cleanup budget across remove and both worktree list forms", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-budget");
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const cleanupTimeouts: number[] = [];
    let clockMs = 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        cleanupTimeouts.push(execution.timeoutMs);
        clockMs += 10;
        if (args[1] === "remove" || args.includes("-z")) {
          return failedCommandResult();
        }
        return successfulCommandResult(legacyWorktreeListOutput(baselineWorktreeDir));
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    try {
      await expect(
        runMantisBeforeAfter({
          baseline: "baseline-ref",
          candidate: "candidate-ref",
          commandRunner: runner,
          commandTimeouts: { "worktree-cleanup": 50 },
          outputDir: ".artifacts/qa-e2e/mantis/cleanup-budget",
          repoRoot,
          skipBuild: true,
          skipInstall: true,
        }),
      ).rejects.toThrow(`baseline worktree cleanup left registered path ${baselineWorktreeDir}`);
      expect(cleanupTimeouts).toEqual([50, 40, 30]);
    } finally {
      now.mockRestore();
    }
  });

  it("bounds stalled filesystem fallback work with the same total cleanup deadline", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-fs-deadline");
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const originalRealpath = fs.realpath.bind(fs);
    let normalizedWorktree = false;
    const realpath = vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
      const resolvedTarget = path.resolve(String(target));
      if (resolvedTarget === baselineWorktreeDir) {
        normalizedWorktree = true;
      } else if (normalizedWorktree && resolvedTarget === repoRoot) {
        return await new Promise<never>(() => {});
      }
      return await originalRealpath(target);
    });
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        return args[1] === "remove" ? failedCommandResult() : successfulCommandResult("");
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    try {
      await expect(
        runMantisBeforeAfter({
          baseline: "baseline-ref",
          candidate: "candidate-ref",
          commandRunner: runner,
          commandTimeouts: { "worktree-cleanup": 25 },
          outputDir: ".artifacts/qa-e2e/mantis/cleanup-fs-deadline",
          repoRoot,
          skipBuild: true,
          skipInstall: true,
        }),
      ).rejects.toThrow("baseline worktree cleanup exceeded its total 25ms deadline");
    } finally {
      realpath.mockRestore();
    }
  });

  it("waits for an uncancellable quarantine move to settle before reporting its deadline", async () => {
    const worktreeParent = path.join(repoRoot, "worktrees");
    const worktreeDir = path.join(worktreeParent, "baseline");
    await fs.mkdir(worktreeParent, { recursive: true });
    const ownership = await createMantisWorktreeDirectory({ repoRoot, worktreeDir });
    let releaseMove: (() => void) | undefined;
    const moveRelease = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    let markMoveStarted: (() => void) | undefined;
    const moveStarted = new Promise<void>((resolve) => {
      markMoveStarted = resolve;
    });
    const rootFactory = (async () => ({
      move: async (fromRelative: string, toRelative: string) => {
        markMoveStarted?.();
        await moveRelease;
        await fs.rename(path.join(repoRoot, fromRelative), path.join(repoRoot, toRelative));
      },
    })) as NonNullable<Parameters<typeof removeMantisWorktree>[0]["rootFactory"]>;
    const runner = vi.fn(async (_command: string, args: readonly string[]) =>
      args[1] === "remove" ? failedCommandResult() : successfulCommandResult(""),
    );
    let settled = false;
    const removal = removeMantisWorktree({
      commandTimeouts: {
        "worktree-add": 300_000,
        install: 1_800_000,
        build: 1_800_000,
        qa: 450_000,
        "worktree-cleanup": 500,
      },
      lane: "baseline",
      ownership,
      repoRoot,
      rootFactory,
      runner,
      worktreeDir,
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );
    void removal.finally(() => {
      settled = true;
    });

    try {
      await moveStarted;
      await new Promise((resolve) => {
        setTimeout(resolve, 550);
      });
      expect(settled).toBe(false);
      releaseMove?.();
      const result = await removal;
      expect(result.status).toBe("rejected");
      const entries = await fs.readdir(worktreeParent);
      const quarantine = entries.find((entry) => entry.startsWith(".mantis-cleanup-"));
      expect(quarantine).toBeDefined();
      if (result.status === "rejected") {
        expect((result.error as Error).message).toContain(
          `finishing quarantining the worktree at worktrees/${quarantine}`,
        );
      }
    } finally {
      releaseMove?.();
    }
  });

  it("uses legacy porcelain before removing an unregistered owned lane directory", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-unregistered");
    const listCalls: string[][] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          return failedCommandResult();
        }
        listCalls.push([...args]);
        return args.includes("-z") ? failedCommandResult(129) : successfulCommandResult("");
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/cleanup-unregistered",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    });

    expect(result.status).toBe("pass");
    expect(listCalls).toEqual([
      ["worktree", "list", "--porcelain", "-z"],
      ["worktree", "list", "--porcelain"],
      ["worktree", "list", "--porcelain", "-z"],
      ["worktree", "list", "--porcelain"],
    ]);
    await expect(fs.stat(path.join(outputDir, "worktrees", "baseline"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(outputDir, "worktrees", "candidate"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readdir(path.join(outputDir, "worktrees"))).resolves.toEqual([]);
  });

  it("fails closed when cleanup registration output is truncated", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-truncated");
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const stages: string[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      stages.push(`${execution.stage}:${args[1]}`);
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          return failedCommandResult();
        }
        return {
          ...successfulCommandResult(""),
          stdoutTruncatedBytes: 1,
        } satisfies StubCommandResult;
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/cleanup-truncated",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toBeInstanceOf(AggregateError);
      const aggregate = result.error as AggregateError;
      expect(aggregate.message).toContain(
        `baseline worktree cleanup could not verify complete registration state for ${baselineWorktreeDir}`,
      );
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBeInstanceOf(Error);
      expect((aggregate.errors[0] as Error).message).toContain(
        "baseline worktree-cleanup failed with exit code 1",
      );
      expect((aggregate.errors[1] as Error).message).toContain("truncated registration output");
    }
    await expect(fs.stat(baselineWorktreeDir)).resolves.toBeDefined();
    expect(stages).toEqual([
      "worktree-add:add",
      `qa:${baselineWorktreeDir}`,
      "worktree-cleanup:remove",
      "worktree-cleanup:list",
    ]);
  });

  it("leaves a registered exact worktree path for operator cleanup with legacy Git", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-registered");
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const stages: string[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      stages.push(`${execution.stage}:${args[1]}`);
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          return failedCommandResult();
        }
        return args.includes("-z")
          ? failedCommandResult(129)
          : successfulCommandResult(legacyWorktreeListOutput(baselineWorktreeDir));
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    await expect(
      runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        commandRunner: runner,
        outputDir: ".artifacts/qa-e2e/mantis/cleanup-registered",
        repoRoot,
        skipBuild: true,
        skipInstall: true,
      }),
    ).rejects.toThrow(`baseline worktree cleanup left registered path ${baselineWorktreeDir}`);

    await expect(fs.stat(baselineWorktreeDir)).resolves.toBeDefined();
    expect(stages).toEqual([
      "worktree-add:add",
      `qa:${baselineWorktreeDir}`,
      "worktree-cleanup:remove",
      "worktree-cleanup:list",
      "worktree-cleanup:list",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "treats a registered symlink alias as the exact POSIX worktree path",
    async () => {
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-alias");
      const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
      const aliasDir = path.join(repoRoot, "baseline-alias");
      const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
        if (command === "git" && execution.stage === "worktree-add") {
          await fs.mkdir(String(args[4]), { recursive: true });
          await fs.symlink(String(args[4]), aliasDir);
          return successfulCommandResult();
        }
        if (command === "pnpm" && execution.stage === "qa") {
          await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
          return successfulCommandResult();
        }
        if (command === "git" && execution.stage === "worktree-cleanup") {
          if (args[1] === "remove") {
            return failedCommandResult();
          }
          return successfulCommandResult(worktreeListOutput(aliasDir));
        }
        throw new Error(`unexpected ${execution.stage} command`);
      });

      await expect(
        runMantisBeforeAfter({
          baseline: "baseline-ref",
          candidate: "candidate-ref",
          commandRunner: runner,
          outputDir: ".artifacts/qa-e2e/mantis/cleanup-alias",
          repoRoot,
          skipBuild: true,
          skipInstall: true,
        }),
      ).rejects.toThrow(`baseline worktree cleanup left registered path ${baselineWorktreeDir}`);

      await expect(fs.stat(baselineWorktreeDir)).resolves.toBeDefined();
    },
  );

  it("keeps workload timeout before registered-path cleanup failure in objects and diagnostics", async () => {
    const outputDir = path.join(
      repoRoot,
      ".artifacts",
      "qa-e2e",
      "mantis",
      "timeout-cleanup-registered",
    );
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        return timedOutCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          return failedCommandResult();
        }
        return successfulCommandResult(worktreeListOutput(baselineWorktreeDir));
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      commandTimeouts: { qa: 321 },
      outputDir: ".artifacts/qa-e2e/mantis/timeout-cleanup-registered",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toBeInstanceOf(AggregateError);
      const aggregate = result.error as AggregateError;
      expect((aggregate.errors[0] as Error).message).toContain("baseline qa timed out after 321ms");
      expect((aggregate.errors[1] as Error).message).toContain(
        `baseline worktree cleanup left registered path ${baselineWorktreeDir}`,
      );
    }
    const errorText = await fs.readFile(path.join(outputDir, "error.txt"), "utf8");
    const outerIndex = errorText.indexOf("Mantis lane failed and worktree cleanup failed");
    const timeoutIndex = errorText.indexOf("baseline qa timed out after 321ms");
    const cleanupIndex = errorText.indexOf(
      `baseline worktree cleanup left registered path ${baselineWorktreeDir}`,
    );
    expect(outerIndex).toBeGreaterThanOrEqual(0);
    expect(timeoutIndex).toBeGreaterThan(outerIndex);
    expect(cleanupIndex).toBeGreaterThan(timeoutIndex);
  });

  it("preserves remove failure first when registration listing fails", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-list-fails");
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        return failedCommandResult(args[1] === "remove" ? 1 : 2);
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/cleanup-list-fails",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toBeInstanceOf(AggregateError);
      const aggregate = result.error as AggregateError;
      expect((aggregate.errors[0] as Error).message).toContain(
        "baseline worktree-cleanup failed with exit code 1",
      );
      expect((aggregate.errors[1] as Error).message).toContain(
        "baseline worktree-cleanup failed with exit code 2",
      );
    }
    await expect(fs.stat(baselineWorktreeDir)).resolves.toBeDefined();
  });
});
