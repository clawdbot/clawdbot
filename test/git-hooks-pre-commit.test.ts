// Git hook tests validate pre-commit hook behavior and scripts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

type FailedCommand = {
  status: number;
  stderr: string;
  stdout: string;
};

const runFailure = (
  cwd: string,
  cmd: string,
  args: string[] = [],
  env?: NodeJS.ProcessEnv,
): FailedCommand => {
  try {
    run(cwd, cmd, args, env);
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      const failure = error as Error & { status?: number; stderr?: string; stdout?: string };
      return {
        status: failure.status ?? 1,
        stderr: failure.stderr ?? "",
        stdout: failure.stdout ?? "",
      };
    }
    throw error;
  }

  throw new Error("expected command to fail");
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

function installFormattingRecorder(dir: string): string {
  const logPath = path.join(dir, "hook-tool.log");
  writeFileSync(
    path.join(dir, "scripts", "pre-commit", "filter-staged-files.mjs"),
    `const files = process.argv.slice(3).filter((arg) => arg !== "--");
for (const file of files) {
  if (file.endsWith(".ts")) {
    process.stdout.write(file);
    process.stdout.write("\0");
  }
}
`,
    "utf8",
  );
  writeFileSync(
    path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
`,
    {
      encoding: "utf8",
      mode: 0o755,
    },
  );
  return logPath;
}

function installRunNodeToolFixture(dir: string): void {
  mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "scripts", "pre-commit", "run-node-tool.sh"),
    path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
  );
}

function splitNonEmptyLines(output: string): string[] {
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

function readFormatterLog(logPath: string): string[] {
  if (!existsSync(logPath)) {
    return [];
  }
  return splitNonEmptyLines(readFileSync(logPath, "utf8"));
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

    const staged = splitNonEmptyLines(run(dir, "git", ["diff", "--cached", "--name-only"]));
    expect(staged).toEqual(["--all"]);
  });

  it("skips formatting staged files while a merge commit is in progress", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-merge-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);
    installPreCommitFixture(dir);
    const logPath = installFormattingRecorder(dir);

    writeFileSync(path.join(dir, "changed.ts"), "export const value = 1;\n", "utf8");
    run(dir, "git", ["add", "--", "changed.ts"]);
    run(dir, "git", [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);
    run(dir, "git", ["checkout", "-q", "-b", "side"]);
    writeFileSync(path.join(dir, "changed.ts"), "export const value = 2;\n", "utf8");
    run(dir, "git", ["add", "--", "changed.ts"]);
    run(dir, "git", [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "-m",
      "side change",
    ]);
    run(dir, "git", ["checkout", "-q", "main"]);
    run(dir, "git", [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.invalid",
      "merge",
      "--no-commit",
      "--no-ff",
      "side",
    ]);

    expect(existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);
    expect(run(dir, "git", ["diff", "--cached", "--name-only"])).toBe("changed.ts");

    run(dir, "bash", ["git-hooks/pre-commit"]);

    expect(readFormatterLog(logPath)).toEqual([]);
  });

  it.each([
    ["cherry-pick", "CHERRY_PICK_HEAD", "file"],
    ["revert", "REVERT_HEAD", "file"],
    ["rebase head", "REBASE_HEAD", "file"],
    ["merge rebase state", "rebase-merge", "dir"],
    ["apply rebase state", "rebase-apply", "dir"],
  ])("skips formatting staged files while %s metadata is present", (_label, gitPath, kind) => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-sequencer-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);
    installPreCommitFixture(dir);
    const logPath = installFormattingRecorder(dir);

    writeFileSync(path.join(dir, "changed.ts"), "export const value = 1;\n", "utf8");
    run(dir, "git", ["add", "--", "changed.ts"]);

    const metadataPath = path.join(dir, ".git", gitPath);
    if (kind === "dir") {
      mkdirSync(metadataPath, { recursive: true });
    } else {
      writeFileSync(metadataPath, "sequencer state\n", "utf8");
    }

    run(dir, "bash", ["git-hooks/pre-commit"]);

    expect(readFormatterLog(logPath)).toEqual([]);
  });

  it("still formats staged files during a normal commit", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-normal-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);
    const fakeBinDir = installPreCommitFixture(dir);
    run(dir, "rm", ["-f", path.join(fakeBinDir, "node")]);
    const logPath = installFormattingRecorder(dir);

    writeFileSync(path.join(dir, "changed.ts"), "export const value = 1;\n", "utf8");
    run(dir, "git", ["add", "--", "changed.ts"]);

    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    expect(readFormatterLog(logPath)).toEqual([
      "oxfmt --write --no-error-on-unmatched-pattern changed.ts",
    ]);
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

    const staged = splitNonEmptyLines(run(dir, "git", ["diff", "--cached", "--name-only"]));
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

describe("scripts/pre-commit/run-node-tool.sh", () => {
  it("runs the installed local tool without invoking pnpm", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-run-node-tool-local-");
    installRunNodeToolFixture(dir);
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const fakeBinDir = path.join(dir, "bin");
    const toolBinDir = path.join(dir, "node_modules", ".bin");
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(toolBinDir, { recursive: true });
    writeExecutable(
      fakeBinDir,
      "pnpm",
      "#!/usr/bin/env bash\necho 'pnpm should not run from run-node-tool' >&2\nexit 99\n",
    );
    writeExecutable(toolBinDir, "oxfmt", "#!/usr/bin/env bash\nprintf 'local:%s\\n' \"$*\"\n");

    expect(
      run(dir, "bash", ["scripts/pre-commit/run-node-tool.sh", "oxfmt", "--write", "a.ts"], {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      }),
    ).toBe("local:--write a.ts");
  });

  it("fails before pnpm can hydrate dependencies when node_modules is missing", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-run-node-tool-missing-deps-");
    installRunNodeToolFixture(dir);
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const fakeBinDir = path.join(dir, "bin");
    const markerPath = path.join(dir, "pnpm-called");
    mkdirSync(fakeBinDir, { recursive: true });
    writeExecutable(
      fakeBinDir,
      "pnpm",
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(markerPath)}\nexit 99\n`,
    );

    const result = runFailure(
      dir,
      "bash",
      ["scripts/pre-commit/run-node-tool.sh", "oxfmt", "--write", "a.ts"],
      { PATH: `${fakeBinDir}:${process.env.PATH ?? ""}` },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Missing repo dependencies: cannot run oxfmt without node_modules.",
    );
    expect(existsSync(markerPath)).toBe(false);
  });
});
