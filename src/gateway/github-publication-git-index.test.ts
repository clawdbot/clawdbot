import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../process/exec.js";
import {
  GitHubPublicationRefCasRejectedError,
  assertGitHubPublicationRefCasCompleted,
  updateGitHubPublicationBranchAndIndex,
} from "./github-publication-git-index.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(
  cwd: string,
  args: string[],
  input?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const result = await runCommandBuffered(["git", ...args], {
    cwd,
    env,
    ...(input === undefined ? {} : { input }),
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.toString("utf8") || `git ${args[0]} failed`);
  }
  return result.stdout.toString("utf8").trim();
}

async function createFixture() {
  const cwd = tempDirs.make("openclaw-publication-index-");
  await git(cwd, ["init", "--initial-branch=main"]);
  await git(cwd, ["config", "user.name", "OpenClaw Test"]);
  await git(cwd, ["config", "user.email", "openclaw@example.test"]);
  await fs.writeFile(path.join(cwd, "artifact.txt"), "base\n");
  await git(cwd, ["add", "artifact.txt"]);
  await git(cwd, ["commit", "-m", "base"]);
  const previousHead = await git(cwd, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(cwd, "artifact.txt"), "accepted\n");
  await git(cwd, ["add", "artifact.txt"]);
  const sourceIndexTree = await git(cwd, ["write-tree"]);
  const headCommit = await git(
    cwd,
    ["commit-tree", sourceIndexTree, "-p", previousHead],
    "published\n",
  );
  return { cwd, previousHead, sourceIndexTree, workspaceTree: sourceIndexTree, headCommit };
}

describe("GitHub publication index update", () => {
  it("moves the branch and index together without changing accepted worktree content", async () => {
    const fixture = await createFixture();
    await updateGitHubPublicationBranchAndIndex({
      ...fixture,
      env: process.env,
      assertCurrent: () => undefined,
      run: async (argv, options) =>
        await git(fixture.cwd, argv.slice(1), options?.input, options?.env),
      updateRef: async () => {
        await git(fixture.cwd, [
          "update-ref",
          "refs/heads/main",
          fixture.headCommit,
          fixture.previousHead,
        ]);
      },
    });

    expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(fixture.headCommit);
    expect(await git(fixture.cwd, ["write-tree"])).toBe(fixture.workspaceTree);
    expect(await git(fixture.cwd, ["status", "--porcelain"])).toBe("");
    expect(await fs.readFile(path.join(fixture.cwd, "artifact.txt"), "utf8")).toBe("accepted\n");
  });

  it("rejects concurrent staged changes without moving HEAD or rewriting the index", async () => {
    const fixture = await createFixture();
    await fs.writeFile(path.join(fixture.cwd, "concurrent.txt"), "keep staged\n");
    await git(fixture.cwd, ["add", "concurrent.txt"]);

    await expect(
      updateGitHubPublicationBranchAndIndex({
        ...fixture,
        env: process.env,
        assertCurrent: () => undefined,
        run: async (argv, options) =>
          await git(fixture.cwd, argv.slice(1), options?.input, options?.env),
        updateRef: async () => {
          throw new Error("update-ref must not run");
        },
      }),
    ).rejects.toThrow("workspace index changed");

    expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(fixture.previousHead);
    expect(await git(fixture.cwd, ["diff", "--cached", "--name-only"])).toContain("concurrent.txt");
  });

  it("retains a complete recovery lock when the ref CAS outcome is ambiguous", async () => {
    const fixture = await createFixture();
    const indexPath = path.join(fixture.cwd, ".git", "index");
    const indexBefore = await fs.readFile(indexPath);

    await expect(
      updateGitHubPublicationBranchAndIndex({
        ...fixture,
        env: process.env,
        assertCurrent: () => undefined,
        run: async (argv, options) =>
          await git(fixture.cwd, argv.slice(1), options?.input, options?.env),
        updateRef: async () => {
          throw new Error("ref changed");
        },
      }),
    ).rejects.toThrow("ref changed");

    expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(fixture.previousHead);
    expect(await fs.readFile(indexPath)).toEqual(indexBefore);
    const recoveryLock = await fs.stat(path.join(fixture.cwd, ".git", "index.lock"));
    expect(recoveryLock.size).toBeGreaterThan(0);
  });

  it("removes its owned lock after a definite ref CAS rejection", async () => {
    const fixture = await createFixture();

    await expect(
      updateGitHubPublicationBranchAndIndex({
        ...fixture,
        env: process.env,
        assertCurrent: () => undefined,
        run: async (argv, options) =>
          await git(fixture.cwd, argv.slice(1), options?.input, options?.env),
        updateRef: async () => {
          const result = await runCommandBuffered(
            ["git", "update-ref", "refs/heads/main", fixture.headCommit, "f".repeat(40)],
            { cwd: fixture.cwd },
          );
          assertGitHubPublicationRefCasCompleted(result);
        },
      }),
    ).rejects.toBeInstanceOf(GitHubPublicationRefCasRejectedError);

    await expect(fs.stat(path.join(fixture.cwd, ".git", "index.lock"))).rejects.toThrow();
    expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(fixture.previousHead);
  });
});
