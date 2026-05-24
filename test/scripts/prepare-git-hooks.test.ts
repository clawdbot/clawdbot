import { describe, expect, it, vi } from "vitest";
import { configurePrepareGitHooks } from "../../scripts/prepare-git-hooks.mjs";

type SpawnResult = {
  error?: NodeJS.ErrnoException;
  status?: number | null;
  stderr?: string;
  stdout?: string;
};

function createSpawn(results: SpawnResult[]) {
  return vi.fn((_bin: string, _args: string[]) => {
    const result = results.shift();
    if (!result) {
      throw new Error("unexpected git invocation");
    }
    return result;
  });
}

describe("configurePrepareGitHooks", () => {
  it("configures hooks through git without using a shell", () => {
    const spawnSync = createSpawn([{ status: 0, stdout: "true\n" }, { status: 0 }]);

    expect(
      configurePrepareGitHooks({
        cwd: "C:\\repo",
        existsSync: () => true,
        spawnSync,
      }),
    ).toEqual({ configured: true, reason: "configured" });

    expect(spawnSync).toHaveBeenCalledWith("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: "C:\\repo",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(spawnSync).toHaveBeenCalledWith("git", ["config", "core.hooksPath", "git-hooks"], {
      cwd: "C:\\repo",
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
  });

  it("stays quiet when git is unavailable", () => {
    const warn = vi.fn();
    const enoent = Object.assign(new Error("missing git"), { code: "ENOENT" });

    expect(
      configurePrepareGitHooks({
        cwd: "C:\\repo",
        existsSync: () => true,
        spawnSync: createSpawn([{ error: enoent }]),
        warn,
      }),
    ).toEqual({ configured: false, reason: "missing-git" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns without failing when git config rejects the hooks path", () => {
    const warn = vi.fn();

    expect(
      configurePrepareGitHooks({
        cwd: "/repo",
        existsSync: () => true,
        spawnSync: createSpawn([
          { status: 0, stdout: "true\n" },
          { status: 1, stderr: "permission denied" },
        ]),
        warn,
      }),
    ).toEqual({ configured: false, reason: "config-failed" });
    expect(warn).toHaveBeenCalledWith("[prepare] could not configure git hooks: permission denied");
  });

  it("skips packaged installs without the source hook directory", () => {
    const spawnSync = createSpawn([]);

    expect(
      configurePrepareGitHooks({
        cwd: "/package",
        existsSync: () => false,
        spawnSync,
      }),
    ).toEqual({ configured: false, reason: "missing-hooks-dir" });
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
