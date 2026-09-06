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
  runGit,
} from "./git.js";

describe("Git execution environment", () => {
  it("disables MSYS and Cygwin argv globbing for Windows worktree Git", () => {
    expect(
      gitEnvironment(
        {
          MSYS: "winsymlinks:nativestrict",
          CYGWIN: "disable_pcon",
        },
        "win32",
      ),
    ).toMatchObject({
      MSYS: "winsymlinks:nativestrict noglob",
      CYGWIN: "disable_pcon noglob",
    });
  });

  it("keeps noglob as the final Windows option and preserves non-Windows environments", () => {
    expect(gitEnvironment({ MSYS: "noglob winsymlinks:native" }, "win32").MSYS).toBe(
      "noglob winsymlinks:native noglob",
    );
    expect(gitEnvironment({ CYGWIN: "noglob glob:ignorecase" }, "win32").CYGWIN).toBe(
      "noglob glob:ignorecase noglob",
    );
    expect(gitEnvironment({ MSYS: "winsymlinks:native noglob" }, "win32").MSYS).toBe(
      "winsymlinks:native noglob",
    );
    expect(gitEnvironment({ MSYS: "winsymlinks:native" }, "linux")).toMatchObject({
      MSYS: "winsymlinks:native",
    });
  });

  it("restores noglob when a later MSYS option re-enables globbing", () => {
    expect(gitEnvironment({ MSYS: "noglob winsymlinks:native glob" }, "win32").MSYS).toBe(
      "noglob winsymlinks:native glob noglob",
    );
  });

  it("preserves inherited MSYS options when callers pass partial overrides", () => {
    expect(
      gitEnvironment({ GIT_INDEX_FILE: "snapshot.index" }, "win32", {
        MSYS: "winsymlinks:nativestrict",
        CYGWIN: "disable_pcon",
      }),
    ).toMatchObject({
      GIT_INDEX_FILE: "snapshot.index",
      MSYS: "winsymlinks:nativestrict noglob",
      CYGWIN: "disable_pcon noglob",
    });
  });

  it("honors Windows overrides and removal before adding noglob", () => {
    expect(
      gitEnvironment({ msys: "winsymlinks:native", CYGWIN: undefined }, "win32", {
        MSYS: "winsymlinks:nativestrict",
        CYGWIN: "disable_pcon",
      }),
    ).toMatchObject({
      MSYS: "winsymlinks:native noglob",
      CYGWIN: "noglob",
    });
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
});
