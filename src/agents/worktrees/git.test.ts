import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SpawnResult } from "../../process/exec.js";
import {
  commandError,
  findGitCheckoutRoot,
  gitEnvironment,
  hasSelfContainedGitMetadata,
  insideGitCheckout,
  listGitWorktrees,
  runGit,
} from "./git.js";

describe("Git execution environment", () => {
  it("preserves literal commit revisions only for Windows worktree Git", () => {
    expect(
      gitEnvironment(
        {
          MSYS: "winsymlinks:nativestrict",
          CYGWIN: "disable_pcon",
        },
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "win32",
      ),
    ).toMatchObject({
      MSYS: "winsymlinks:nativestrict noglob",
      CYGWIN: "disable_pcon noglob",
    });
    expect(gitEnvironment({ MSYS: "winsymlinks:nativestrict" }, ["status"], "win32").MSYS).toBe(
      "winsymlinks:nativestrict",
    );
  });

  it.each([
    ["noglob winsymlinks:native", "noglob winsymlinks:native noglob"],
    ["noglob glob:ignorecase", "noglob glob:ignorecase noglob"],
    ["winsymlinks:native noglob", "winsymlinks:native noglob"],
  ])("keeps noglob final for %s", (value, expected) => {
    expect(gitEnvironment({ MSYS: value }, ["rev-parse", "HEAD^{commit}"], "win32").MSYS).toBe(
      expected,
    );
  });

  it("merges inherited Windows runtime options before preserving revisions", () => {
    expect(
      gitEnvironment(
        { GIT_INDEX_FILE: "snapshot.index", msys: "winsymlinks:native", CYGWIN: undefined },
        ["rev-parse", "HEAD^{commit}"],
        "win32",
        { MSYS: "winsymlinks:nativestrict", CYGWIN: "disable_pcon" },
      ),
    ).toMatchObject({
      GIT_INDEX_FILE: "snapshot.index",
      MSYS: "winsymlinks:native noglob",
      CYGWIN: "noglob",
    });
    expect(
      gitEnvironment({ MSYS: "winsymlinks:native" }, ["rev-parse", "HEAD^{commit}"], "linux").MSYS,
    ).toBe("winsymlinks:native");
  });
});

describe("Git checkout discovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("reports a real Git failure with execution metadata through the worktree wrapper", async () => {
    const root = tempDirs.make("openclaw-git-error-");
    const result = await runGit(path.join(root, "missing"), ["status"]);

    expectTypeOf(result).toMatchTypeOf<SpawnResult>();
    expect(result.timeoutMs).toBe(120_000);
    expect(result.code).toBe(128);
    expect(result).toMatchObject({ termination: "exit", signal: null });
    const message = commandError("git status", result).message;
    expect(message).toContain("git status failed (exit code 128)");
    expect(message).toContain("fatal:");
    expect(message).not.toMatch(/timeout|timed out/i);
  });

  it("returns the nearest checkout root for nested paths", async () => {
    const root = tempDirs.make("openclaw-git-root-");
    const nested = path.join(root, "packages", "nested");
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(nested, { recursive: true });

    expect(findGitCheckoutRoot(nested)).toBe(root);
    expect(insideGitCheckout(nested)).toBe(true);
  });

  it("returns null outside a checkout", async () => {
    const root = tempDirs.make("openclaw-no-git-root-");

    expect(findGitCheckoutRoot(root)).toBeNull();
    expect(insideGitCheckout(root)).toBe(false);
  });

  it("distinguishes contained metadata from linked checkout pointers", async () => {
    const root = tempDirs.make("openclaw-git-metadata-");
    await fs.mkdir(path.join(root, ".git"));
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(true);

    await fs.rm(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git"), "gitdir: /outside/worktrees/card\n", "utf8");
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(false);
  });

  it.skipIf(process.platform !== "win32")(
    "parses linked worktree paths and lock reasons from Windows Git output",
    async () => {
      const root = tempDirs.make("openclaw-git-worktree-list-");
      const repo = path.join(root, "repo");
      const linked = path.join(root, "linked");
      expect((await runGit(root, ["init", "-b", "main", repo])).code).toBe(0);
      expect((await runGit(repo, ["config", "user.name", "OpenClaw Test"])).code).toBe(0);
      expect(
        (await runGit(repo, ["config", "user.email", "openclaw-test@example.invalid"])).code,
      ).toBe(0);
      await fs.writeFile(path.join(repo, "README.md"), "base\n");
      expect((await runGit(repo, ["add", "README.md"])).code).toBe(0);
      expect((await runGit(repo, ["commit", "-m", "initial"])).code).toBe(0);
      expect((await runGit(repo, ["worktree", "add", "-b", "linked", linked, "HEAD"])).code).toBe(
        0,
      );
      expect(
        (await runGit(repo, ["worktree", "lock", "--reason", "held by test", linked])).code,
      ).toBe(0);

      expect(await listGitWorktrees(repo)).toContainEqual({
        path: await fs.realpath(linked),
        lockedReason: "held by test",
      });
    },
  );
});
