import { execFileSync, spawnSync as spawnGit, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configurePrepareGitHooks } from "../../scripts/prepare-git-hooks.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    const spawnSync = createSpawn([{ status: 0, stdout: "true\n" }, { status: 1 }, { status: 0 }]);

    expect(
      configurePrepareGitHooks({
        cwd: "C:\\repo",
        existsSync: () => true,
        spawnSync,
        warn: vi.fn(),
      }),
    ).toEqual({ configured: true, reason: "configured" });

    const options = {
      cwd: "C:\\repo",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    };
    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      options,
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      "git",
      ["config", "--get", "core.hooksPath"],
      options,
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      3,
      "git",
      ["config", "--worktree", "core.hooksPath", "git-hooks"],
      options,
    );
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it.each([0, 1, 2])("stays quiet when Git is unavailable at command %i", (command) => {
    const warn = vi.fn();
    const enoent = Object.assign(new Error("missing git"), { code: "ENOENT" });
    const preceding: SpawnResult[] = [{ status: 0, stdout: "true\n" }, { status: 1 }];

    expect(
      configurePrepareGitHooks({
        cwd: "C:\\repo",
        existsSync: () => true,
        spawnSync: createSpawn([...preceding.slice(0, command), { error: enoent }]),
        warn,
      }),
    ).toEqual({ configured: false, reason: "missing-git" });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["read", "write"])("warns without fallback when Git config %s fails", (operation) => {
    const warn = vi.fn();
    const spawnSync = createSpawn([
      { status: 0, stdout: "true\n" },
      ...(operation === "write" ? [{ status: 1 }] : []),
      { status: 128, stderr: "permission denied" },
    ]);

    expect(
      configurePrepareGitHooks({
        cwd: "/repo",
        existsSync: () => true,
        spawnSync,
        warn,
      }),
    ).toEqual({ configured: false, reason: "config-failed" });
    expect(warn).toHaveBeenCalledWith("[prepare] could not configure git hooks: permission denied");
    expect(spawnSync).toHaveBeenCalledTimes(operation === "write" ? 3 : 2);
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

  type OwnershipCase = {
    name: string;
    linked?: boolean;
    worktreeConfig?: boolean;
    local?: string;
    global?: string;
    overrides?: boolean;
    reason: "configured" | "already-configured" | "config-failed";
    expected: string | null;
  };
  const ownershipCases: OwnershipCase[] = [
    { name: "fresh primary", reason: "configured", expected: "git-hooks" },
    {
      name: "explicit local owner",
      local: "local-hooks",
      reason: "already-configured",
      expected: "local-hooks",
    },
    {
      name: "explicit global owner",
      global: "global-hooks",
      reason: "already-configured",
      expected: "global-hooks",
    },
    { name: "explicit empty value", local: "", reason: "already-configured", expected: "" },
    {
      name: "linked without private config",
      linked: true,
      reason: "config-failed",
      expected: null,
    },
    {
      name: "linked inherited owner",
      linked: true,
      local: "shared-hooks",
      reason: "already-configured",
      expected: "shared-hooks",
    },
    {
      name: "linked private initialization",
      linked: true,
      worktreeConfig: true,
      reason: "configured",
      expected: "git-hooks",
    },
    {
      name: "overrides masking shared config",
      linked: true,
      worktreeConfig: true,
      local: "shared-hooks",
      overrides: true,
      reason: "already-configured",
      expected: "linked-hooks",
    },
  ];

  it.each(ownershipCases)("preserves Git configuration ownership: $name", (scenario) => {
    const root = tempDirs.make("prepare-hook-ownership-");
    const primary = join(root, "primary");
    const globalConfig = join(root, "global.config");
    const template = join(root, "empty-template");
    mkdirSync(template);
    writeFileSync(globalConfig, "");
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_TEMPLATE_DIR: template,
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (cwd: string, args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: "pipe" }).trim();
    git(root, ["init", "-q", "--initial-branch=main", primary]);
    git(primary, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]);
    const checkouts = [primary];
    if (scenario.linked) {
      for (const name of ["linked", "sibling"]) {
        const checkout = join(root, name);
        git(primary, ["worktree", "add", "--detach", "-q", checkout, "HEAD"]);
        checkouts.push(checkout);
      }
    }
    const target = scenario.linked ? join(root, "linked") : primary;
    mkdirSync(join(target, "git-hooks"));
    if (scenario.worktreeConfig) {
      git(primary, ["config", "extensions.worktreeConfig", "true"]);
    }
    if (scenario.local !== undefined) {
      git(primary, ["config", "--local", "core.hooksPath", scenario.local]);
    }
    if (scenario.global !== undefined) {
      git(primary, ["config", "--file", globalConfig, "core.hooksPath", scenario.global]);
    }
    if (scenario.overrides) {
      checkouts.forEach((checkout) =>
        git(checkout, ["config", "--worktree", "core.hooksPath", `${basename(checkout)}-hooks`]),
      );
    }
    const hookPath = (cwd: string) => {
      const result = spawnGit("git", ["-C", cwd, "config", "--get", "core.hooksPath"], {
        env,
        encoding: "utf8",
      });
      expect([0, 1]).toContain(result.status);
      return result.status === 0 ? result.stdout.replace(/\r?\n$/u, "") : null;
    };
    const effectiveBefore = checkouts.map(hookPath);
    const unchangedFiles = [
      globalConfig,
      ...(scenario.linked || scenario.reason !== "configured"
        ? [join(primary, ".git", "config")]
        : []),
      ...checkouts
        .filter(
          (checkout) =>
            !(checkout === target && scenario.worktreeConfig && scenario.reason === "configured"),
        )
        .map((checkout) =>
          resolve(checkout, git(checkout, ["rev-parse", "--git-path", "config.worktree"])),
        ),
    ];
    const contents = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);
    const contentsBefore = unchangedFiles.map(contents);
    const warn = vi.fn();
    const result = configurePrepareGitHooks({
      cwd: target,
      spawnSync: (bin: string, args: string[], options: SpawnSyncOptions) => {
        expect(bin).toBe("git");
        expect(options.cwd).toBe(target);
        return spawnGit(bin, args, { ...options, env });
      },
      warn,
    });
    // Private overrides can mask a shared write, so compare config bytes as well as effective values.
    expect(unchangedFiles.map(contents)).toEqual(contentsBefore);
    expect(result).toEqual({
      configured: scenario.reason === "configured",
      reason: scenario.reason,
    });
    expect(checkouts.map(hookPath)).toEqual(
      checkouts.map((checkout, index) =>
        checkout === target ? scenario.expected : effectiveBefore[index],
      ),
    );
    if (scenario.reason === "config-failed") {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[prepare] could not configure git hooks"),
      );
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  });
});
