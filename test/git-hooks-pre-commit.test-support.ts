import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";

const baseGitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "user.name",
  GIT_CONFIG_VALUE_0: "Hook Test",
  GIT_CONFIG_KEY_1: "user.email",
  GIT_CONFIG_VALUE_1: "hook@example.invalid",
  GIT_CONFIG_KEY_2: "commit.gpgSign",
  GIT_CONFIG_VALUE_2: "false",
  GIT_CONFIG_KEY_3: "init.templateDir",
  GIT_CONFIG_VALUE_3: "",
};
export const rulePath = ".git/private rules.txt";
export const ruleSetting = "hooks.blockedLiteralsFile";
export const literals = ["GUARD_SYNTHETIC_ALPHA", "GUARD_SYNTHETIC_BETA_[x].*42"] as const;

export const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) => {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 20_000,
    maxBuffer: 24 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      TMPDIR: cwd,
      LC_ALL: "C",
      TZ: "UTC",
      ...baseGitEnv,
      ...env,
    },
  }).trim();
};

type FailedCommand = {
  status: number;
  stderr: string;
  stdout: string;
};

export const runFailure = (
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

export function writeExecutable(dir: string, name: string, contents: string): void {
  writeFileSync(path.join(dir, name), contents, {
    encoding: "utf8",
    mode: 0o755,
  });
}

export function installPreCommitFixture(dir: string): string {
  mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
  mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "git-hooks", "pre-commit"),
    path.join(dir, "git-hooks", "pre-commit"),
  );
  for (const name of [
    "run-node-tool.sh",
    "filter-staged-files.mjs",
    "guard-staged-content.mjs",
    "format-staged.sh",
  ]) {
    copyFileSync(
      path.join(process.cwd(), "scripts/pre-commit", name),
      path.join(dir, "scripts/pre-commit", name),
    );
  }
  writeFileSync(path.join(dir, rulePath), `${literals.join("\n")}\n`, { mode: 0o600 });
  run(dir, "git", ["config", "--local", ruleSetting, path.join(dir, rulePath)]);
  mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true });
  writeExecutable(path.join(dir, "node_modules/.bin"), "oxfmt", "#!/bin/sh\nexit 0\n");

  const fakeBinDir = path.join(dir, "bin");
  mkdirSync(fakeBinDir, { recursive: true });
  return fakeBinDir;
}

export function createContentGuardFixture(tempDirs: string[]): string {
  const dir = makeTempRepoRoot(tempDirs, "openclaw-content-guard-");
  run(dir, "git", ["init", "-q", "--initial-branch=main"]);
  installPreCommitFixture(dir);
  return dir;
}

export function stageContent(dir: string, name: string, content: string | Buffer): void {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), content);
  run(dir, "git", ["--literal-pathspecs", "add", "-f", "--", name]);
}

export const commitArgs = ["-c", "core.hooksPath=git-hooks", "commit", "-qm", "guard proof"];
