import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandRuntime from "../../process/exec.js";
import {
  deleteStagedWorkerWorkspaceResult,
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(root: string, ...args: string[]): Promise<void> {
  const result = await commandRuntime.runCommandWithTimeout(
    ["git", "-c", `core.hooksPath=${os.devNull}`, "-C", root, ...args],
    { timeoutMs: 10_000 },
  );
  expect(result.code, result.stderr || result.stdout).toBe(0);
}

async function initializeRepository(root: string): Promise<void> {
  await fs.mkdir(root);
  await git(root, "init", "--quiet");
  await git(
    root,
    "-c",
    "user.name=Workspace Test",
    "-c",
    "user.email=workspace@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "base",
  );
}

describe("worker workspace result Git ownership", () => {
  it("queues related worktree ref mutations while another repository progresses", async () => {
    const root = tempDirs.make("worker-result-ref-queue-");
    const repository = path.join(root, "repository");
    const worktree = path.join(root, "worktree");
    const unrelated = path.join(root, "unrelated");
    await initializeRepository(repository);
    await git(repository, "worktree", "add", "--quiet", "--detach", worktree);
    await initializeRepository(unrelated);
    const targets = [repository, worktree, unrelated].map((directory, index) => ({
      root: directory,
      stagedResultRef: preparedWorkerWorkspaceResultRef(workerWorkspaceResultRef(`claim-${index}`)),
    }));
    for (const target of targets) {
      await git(target.root, "update-ref", target.stagedResultRef, "HEAD");
    }
    await git(repository, "pack-refs", "--all");
    await git(unrelated, "pack-refs", "--all");

    const firstStarted = createDeferred();
    const secondReachedGit = createDeferred();
    const releaseFirst = createDeferred();
    const mutations: string[] = [];
    const runCommand = commandRuntime.runCommandWithTimeout;
    const spy = vi
      .spyOn(commandRuntime, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        const cwd = argv[argv.indexOf("-C") + 1];
        if (cwd === worktree) {
          secondReachedGit.resolve();
        }
        if (argv.includes("update-ref")) {
          mutations.push(cwd!);
          if (cwd === repository) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
        }
        return await runCommand(argv, options);
      });
    const operations: Promise<void>[] = [];
    try {
      operations.push(deleteStagedWorkerWorkspaceResult(targets[0]!));
      await firstStarted.promise;
      operations.push(deleteStagedWorkerWorkspaceResult(targets[1]!));
      const independent = deleteStagedWorkerWorkspaceResult(targets[2]!);
      operations.push(independent);
      // The first Git mutation remains paused while both other callers reach
      // Git. Only the independent repository may mutate before it is released.
      await Promise.all([secondReachedGit.promise, independent]);
      expect(mutations).toEqual([repository, unrelated]);
      await expect(hasWorkerWorkspaceResultRef(targets[1]!)).resolves.toBe(true);
      await expect(hasWorkerWorkspaceResultRef(targets[2]!)).resolves.toBe(false);
      releaseFirst.resolve();
      await Promise.all(operations);
      expect(mutations).toEqual([repository, unrelated, worktree]);
      for (const target of targets) {
        await expect(hasWorkerWorkspaceResultRef(target)).resolves.toBe(false);
      }
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled(operations);
      spy.mockRestore();
    }
  });
});
