import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../process/exec.js";
import {
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

function publicationIndexParams(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    ...fixture,
    requestId: "11111111-1111-4111-8111-111111111111",
    branch: "main",
    env: process.env,
    assertCurrent: () => undefined,
    run: async (
      argv: string[],
      options?: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv },
    ) => await git(fixture.cwd, argv.slice(1), options?.input, options?.env),
  };
}

describe("GitHub publication index update", () => {
  it("moves the branch and index together without changing accepted worktree content", async () => {
    const fixture = await createFixture();
    await updateGitHubPublicationBranchAndIndex({
      ...publicationIndexParams(fixture),
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
        ...publicationIndexParams(fixture),
        updateRef: async () => {
          throw new Error("update-ref must not run");
        },
      }),
    ).rejects.toThrow("workspace index changed");

    expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(fixture.previousHead);
    expect(await git(fixture.cwd, ["diff", "--cached", "--name-only"])).toContain("concurrent.txt");
  });

  it("retries a complete recovery lock when an ambiguous ref CAS did not move", async () => {
    const fixture = await createFixture();
    const indexPath = path.join(fixture.cwd, ".git", "index");
    const indexBefore = await fs.readFile(indexPath);

    await expect(
      updateGitHubPublicationBranchAndIndex({
        ...publicationIndexParams(fixture),
        updateRef: async () => {
          throw new Error("ref changed");
        },
      }),
    ).rejects.toThrow("workspace recovery is pending");

    expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(fixture.previousHead);
    expect(await fs.readFile(indexPath)).toEqual(indexBefore);
    const recoveryLock = await fs.stat(path.join(fixture.cwd, ".git", "index.lock"));
    expect(recoveryLock.size).toBeGreaterThan(0);

    await updateGitHubPublicationBranchAndIndex({
      ...publicationIndexParams(fixture),
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
    expect(await git(fixture.cwd, ["status", "--porcelain"])).toBe("");
  });

  it("installs a retained recovery index when an ambiguous ref CAS moved", async () => {
    const fixture = await createFixture();

    await expect(
      updateGitHubPublicationBranchAndIndex({
        ...publicationIndexParams(fixture),
        updateRef: async () => {
          await git(fixture.cwd, [
            "update-ref",
            "refs/heads/main",
            fixture.headCommit,
            fixture.previousHead,
          ]);
          throw new Error("response lost");
        },
      }),
    ).rejects.toThrow("workspace recovery is pending");

    expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(fixture.headCommit);
    await updateGitHubPublicationBranchAndIndex({
      ...publicationIndexParams(fixture),
      previousHead: fixture.headCommit,
    });
    expect(await git(fixture.cwd, ["write-tree"])).toBe(fixture.workspaceTree);
    expect(await git(fixture.cwd, ["status", "--porcelain"])).toBe("");
    await expect(fs.stat(path.join(fixture.cwd, ".git", "index.lock"))).rejects.toThrow();
  });

  it("does not claim another Git operation's byte-identical index lock", async () => {
    const fixture = await createFixture();
    const foreignIndex = path.join(fixture.cwd, "foreign-index");
    await git(fixture.cwd, ["read-tree", fixture.headCommit], undefined, {
      ...process.env,
      GIT_INDEX_FILE: foreignIndex,
    });
    await fs.rename(foreignIndex, path.join(fixture.cwd, ".git", "index.lock"));

    await expect(
      updateGitHubPublicationBranchAndIndex({
        ...publicationIndexParams(fixture),
        updateRef: async () => {
          throw new Error("update-ref must not run");
        },
      }),
    ).rejects.toThrow("locked by another operation");

    expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(fixture.previousHead);
    expect((await fs.stat(path.join(fixture.cwd, ".git", "index.lock"))).size).toBeGreaterThan(0);
  });

  it("removes its owned lock after a definite ref CAS rejection", async () => {
    const fixture = await createFixture();

    await expect(
      updateGitHubPublicationBranchAndIndex({
        ...publicationIndexParams(fixture),
        updateRef: async () => {
          const result = await runCommandBuffered(
            ["git", "update-ref", "refs/heads/main", fixture.headCommit, "f".repeat(40)],
            { cwd: fixture.cwd },
          );
          assertGitHubPublicationRefCasCompleted(result);
        },
      }),
    ).rejects.toThrow("workspace branch changed before commit");

    await expect(fs.stat(path.join(fixture.cwd, ".git", "index.lock"))).rejects.toThrow();
    expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(fixture.previousHead);
  });
});
