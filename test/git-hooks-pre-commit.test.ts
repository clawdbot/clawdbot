import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot } from "./helpers/temp-repo.js";

const baseGitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const baseRunEnv: NodeJS.ProcessEnv = { ...process.env, ...baseGitEnv };
const tempDirs: string[] = [];

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) => {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...baseRunEnv, ...env } : baseRunEnv,
  }).trim();
};

function writeExecutable(dir: string, name: string, contents: string): void {
  writeFileSync(path.join(dir, name), contents, {
    encoding: "utf8",
    mode: 0o755,
  });
}

function installPreCommitFixture(dir: string): string {
  mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
  mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "git-hooks", "pre-commit"),
    path.join(dir, "git-hooks", "pre-commit"),
  );
  writeFileSync(
    path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
    {
      encoding: "utf8",
      mode: 0o755,
    },
  );
  writeFileSync(
    path.join(dir, "scripts", "pre-commit", "filter-staged-files.mjs"),
    "process.exit(0);\n",
    "utf8",
  );

  const fakeBinDir = path.join(dir, "bin");
  mkdirSync(fakeBinDir, { recursive: true });
  writeExecutable(fakeBinDir, "node", "#!/usr/bin/env bash\nexit 0\n");
  return fakeBinDir;
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("git-hooks/pre-commit (integration)", () => {
  it("does not treat staged filenames as git-add flags (e.g. --all)", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    // Use the real hook script and lightweight helper stubs.
    const fakeBinDir = installPreCommitFixture(dir);
    // Create an untracked file that should NOT be staged by the hook.
    writeFileSync(path.join(dir, "secret.txt"), "do-not-stage\n", "utf8");

    // Stage a maliciously-named file. Older hooks using `xargs git add` could run `git add --all`.
    writeFileSync(path.join(dir, "--all"), "flag\n", "utf8");
    run(dir, "git", ["add", "--", "--all"]);

    // Run the hook directly (same logic as when installed via core.hooksPath).
    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    const staged = run(dir, "git", ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    expect(staged).toEqual(["--all"]);
  });

  it("does not run the changed-scope check for non-doc staged changes", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-no-check-changed-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    const fakeBinDir = installPreCommitFixture(dir);
    writeFileSync(path.join(dir, "package.json"), '{"name":"tmp"}\n', "utf8");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeExecutable(
      fakeBinDir,
      "pnpm",
      "#!/usr/bin/env bash\necho 'pnpm should not run from pre-commit' >&2\nexit 99\n",
    );

    writeFileSync(path.join(dir, "tracked.txt"), "hello\n", "utf8");
    run(dir, "git", ["add", "--", "tracked.txt"]);

    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    expect(run(dir, "git", ["diff", "--cached", "--name-only"])).toBe("tracked.txt");
  });

  it("does not re-add staged paths that are ignored by the current .gitignore", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-ignored-staged-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    const fakeBinDir = installPreCommitFixture(dir);
    mkdirSync(path.join(dir, ".agents", "skills", "discord-clawd"), { recursive: true });
    writeFileSync(path.join(dir, ".gitignore"), ".agents/skills/discord-clawd/\n", "utf8");
    writeFileSync(
      path.join(dir, ".agents", "skills", "discord-clawd", "SKILL.md"),
      "# Discord Clawd\n",
      "utf8",
    );

    run(dir, "git", ["add", "--", ".gitignore"]);
    run(dir, "git", ["add", "-f", "--", ".agents/skills/discord-clawd/SKILL.md"]);

    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    const staged = run(dir, "git", ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    expect(staged).toEqual([".agents/skills/discord-clawd/SKILL.md", ".gitignore"]);
  });

  it("ignores FAST_COMMIT because the hook is already formatting-only", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-fast-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    const fakeBinDir = installPreCommitFixture(dir);
    writeFileSync(path.join(dir, "package.json"), '{"name":"tmp"}\n', "utf8");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    writeExecutable(
      fakeBinDir,
      "pnpm",
      "#!/usr/bin/env bash\necho 'pnpm should not run when FAST_COMMIT is enabled' >&2\nexit 99\n",
    );

    writeFileSync(path.join(dir, "tracked.txt"), "hello\n", "utf8");
    run(dir, "git", ["add", "--", "tracked.txt"]);

    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      FAST_COMMIT: "1",
    });

    expect(run(dir, "git", ["diff", "--cached", "--name-only"])).toBe("tracked.txt");
  });
});
